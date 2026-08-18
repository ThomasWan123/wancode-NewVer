/** Cordis Host plugin for scheduled and interactive Wancode updates. */

import { open } from 'node:fs/promises'
import type { Context } from '@deepseek-ai/cordis'
import { writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'
import z from '@deepseek-ai/schemastery'
import type {} from './runtime.ts'
import {
  checkForUpdate,
  compareSemVerVersions,
  parseSemVer,
  type UpdateChannel,
  type UpdateCheckResult,
} from './update-checker.ts'
import type { DesktopApplicationHealth } from './runtime.ts'

/** Stable Cordis plugin name. */
export const name = 'desktop-updates'

/** Native adapter required for network, tray, confirmation, and installer access. */
export const inject = ['desktopRuntime']

const MAX_TIMER_DELAY_MS = 2_147_483_647
const MAX_STATE_BYTES = 4 * 1024

/** Scheduled update policy. */
export interface Config {
  /** Release stream selected for automatic and manual checks. */
  channel: UpdateChannel
  /** Enable background checks in packaged applications. */
  enabled: boolean
  /** Delay before the first background check after plugin activation. */
  initialDelayMs: number
  /** Delay between completion of one background check and the next attempt. */
  intervalMs: number
  /** Maximum duration of one version request before caller-owned cancellation. */
  requestTimeoutMs: number
  /** Maximum time an updated renderer may take to report terminal health. */
  healthTimeoutMs: number
}

/** Validated scheduled update policy. */
export const Config: z<Config> = z.object({
  channel: z.union(['stable', 'beta'] as const).default('stable'),
  enabled: z.boolean().default(true),
  initialDelayMs: z.number().step(1).min(0).max(MAX_TIMER_DELAY_MS).default(60_000),
  intervalMs: z.number().step(1).min(1).max(MAX_TIMER_DELAY_MS).default(6 * 60 * 60 * 1000),
  requestTimeoutMs: z.number().step(1).min(1).max(MAX_TIMER_DELAY_MS).default(15_000),
  healthTimeoutMs: z.number().step(1).min(1).max(MAX_TIMER_DELAY_MS).default(30_000),
})

interface UpdateStateV2 {
  readonly version: 2
  readonly lastPromptedVersion?: string
}

interface UpdateRollbackState {
  readonly fromVersion: string
  readonly toVersion: string
  readonly status: 'pending' | 'available'
}

interface UpdateStateV3 {
  readonly version: 3
  readonly lastPromptedVersion?: string
  readonly rollback: UpdateRollbackState
}

interface UpdateRollbackStateV4 {
  readonly fromVersion: string
  readonly toVersion: string
  readonly status: 'pending' | 'verifying' | 'available' | 'automatic-attempted'
}

interface UpdateStateV4 {
  readonly version: 4
  readonly lastPromptedVersion?: string
  readonly rollback: UpdateRollbackStateV4
}

type UpdateState = UpdateStateV2 | UpdateStateV3 | UpdateStateV4

const EMPTY_STATE: UpdateState = { version: 2 }

/**
 * Register effect-scoped update polling and its dynamic tray command.
 * @param ctx - Host context carrying the desktop native adapter.
 * @param config - validated polling and timeout values.
 */
export function apply(ctx: Context, config: Config): void {
  const adapter = ctx.desktopRuntime.updates
  ctx.effect(() => {
    let disposed = false
    let checking = false
    let availableVersion: string | undefined
    let downloadingVersion: string | undefined
    let state: UpdateState = EMPTY_STATE
    let rollbackVersion: string | undefined
    let pollTimer: ReturnType<typeof setTimeout> | undefined
    let requestTimer: ReturnType<typeof setTimeout> | undefined
    let healthTimer: ReturnType<typeof setTimeout> | undefined
    let requestController: AbortController | undefined
    let downloadController: AbortController | undefined
    let inFlight: Promise<UpdateCheckResult | null> | undefined
    let manualTask: Promise<void> | undefined
    let downloadTask: Promise<void> | undefined
    let requiredStateWrite: Promise<void> | undefined
    let automaticRecoveryInFlight = false
    let refreshTray = (): void => {}

    const persistState = async (): Promise<void> => {
      try {
        await writeFileAtomic(adapter.statePath, renderState(state), {
          mode: 0o600,
          dirMode: 0o700,
        })
      } catch {
        // Update state is optional; failures must not affect application startup or user activity.
      }
    }

    const persistRequiredState = async (): Promise<void> => {
      const task = writeFileAtomic(adapter.statePath, renderState(state), {
        mode: 0o600,
        dirMode: 0o700,
      })
      requiredStateWrite = task
      try {
        await task
      } finally {
        if (requiredStateWrite === task) requiredStateWrite = undefined
      }
    }

    const stateReady = (async () => {
      try {
        state = parseState(await readState(adapter.statePath))
        if (state.version === 3) {
          const legacy = state
          state = {
            version: 4,
            ...(state.lastPromptedVersion === undefined ? {} : { lastPromptedVersion: state.lastPromptedVersion }),
            rollback: {
              ...state.rollback,
              status: state.rollback.status === 'pending'
                ? state.rollback.toVersion === adapter.currentVersion ? 'verifying' : 'pending'
                : 'available',
            },
          }
          try {
            await persistRequiredState()
          } catch {
            state = legacy
            return
          }
        } else if (state.version === 4 && state.rollback.toVersion === adapter.currentVersion
          && state.rollback.status === 'pending') {
          const pending = state
          state = {
            ...state,
            rollback: { ...state.rollback, status: 'verifying' },
          }
          try {
            await persistRequiredState()
          } catch {
            state = pending
            return
          }
        }
        if (state.version === 4) {
          if (state.rollback.toVersion === adapter.currentVersion) {
            rollbackVersion = state.rollback.fromVersion
          } else if (state.rollback.fromVersion === adapter.currentVersion
            && state.rollback.status !== 'pending') {
            state = state.lastPromptedVersion === undefined
              ? EMPTY_STATE
              : { version: 2, lastPromptedVersion: state.lastPromptedVersion }
            await persistState()
          } else if (state.rollback.fromVersion !== adapter.currentVersion) {
            state = state.lastPromptedVersion === undefined
              ? EMPTY_STATE
              : { version: 2, lastPromptedVersion: state.lastPromptedVersion }
            await persistState()
          }
        }
      } catch (cause) {
        if (isEnoent(cause)) return
        state = EMPTY_STATE
        if (!disposed) await persistState()
      }
    })().finally(() => {
      if (!disposed) refreshTray()
    })

    const rememberPrompt = async (version: string): Promise<void> => {
      await stateReady
      if (state.lastPromptedVersion === version) return
      state = state.version === 3 || state.version === 4
        ? { ...state, lastPromptedVersion: version }
        : { version: 2, lastPromptedVersion: version }
      await persistState()
    }

    const startCheck = (): Promise<UpdateCheckResult | null> => {
      if (inFlight !== undefined) return inFlight
      checking = true
      refreshTray()
      const controller = new AbortController()
      requestController = controller

      const task = (async () => {
        requestTimer = setTimeout(() => { controller.abort() }, config.requestTimeoutMs)
        try {
          return await checkForUpdate({
            channel: config.channel,
            currentVersion: adapter.currentVersion,
            signal: controller.signal,
            request: adapter.request,
          })
        } catch {
          return null
        }
      })().finally(() => {
        if (requestTimer !== undefined) clearTimeout(requestTimer)
        requestTimer = undefined
        if (requestController === controller) requestController = undefined
        inFlight = undefined
        checking = false
        refreshTray()
      })
      inFlight = task
      return task
    }

    const observeResult = (result: UpdateCheckResult | null): string | undefined => {
      if (disposed || result === null) return undefined
      availableVersion = result.status === 'update-available' && adapter.canDownload
        ? result.latestVersion
        : undefined
      refreshTray()
      return availableVersion
    }

    const startDownload = (version: string): Promise<void> => {
      if (downloadTask !== undefined) return downloadTask
      const task = (async () => {
        let confirmed: boolean
        try {
          confirmed = await adapter.confirmDownload(version)
        } catch {
          return
        }
        if (!confirmed || disposed) return

        const confirmedVersion = observeResult(await startCheck())
        if (confirmedVersion !== version || disposed) return

        await stateReady
        if (disposed) return
        state = {
          version: 4,
          ...(state.lastPromptedVersion === undefined
            ? {}
            : { lastPromptedVersion: state.lastPromptedVersion }),
          rollback: {
            fromVersion: adapter.currentVersion,
            toVersion: version,
            status: 'pending',
          },
        }
        await persistRequiredState()
        if (disposed) return

        const controller = new AbortController()
        downloadController = controller
        downloadingVersion = version
        refreshTray()
        try {
          await adapter.downloadAndOpen(version, controller.signal)
        } catch {
          // Network, filesystem, and installer-opening failures are deliberately silent.
        } finally {
          if (downloadController === controller) downloadController = undefined
          downloadingVersion = undefined
          refreshTray()
        }
      })().finally(() => {
        if (downloadTask === task) downloadTask = undefined
      })
      downloadTask = task
      return task
    }

    const offerDownload = async (version: string, automatic: boolean): Promise<void> => {
      if (disposed || !adapter.canDownload) return
      await stateReady
      if (disposed || (automatic && state.lastPromptedVersion === version)) return
      await rememberPrompt(version)
      if (!disposed) await startDownload(version)
    }

    const runManualCheck = (): Promise<void> => {
      manualTask ??= (async () => {
        if (availableVersion !== undefined) {
          await offerDownload(availableVersion, false)
          return
        }
        const result = await startCheck()
        if (disposed) return
        const version = observeResult(result)
        if (version !== undefined) {
          await offerDownload(version, false)
          return
        }
        await adapter.showManualCheckResult(result)
      })().catch(() => undefined).finally(() => { manualTask = undefined })
      return manualTask
    }

    const runRollback = (): Promise<void> => {
      const version = rollbackVersion
      if (version === undefined) return Promise.resolve()
      if (downloadTask !== undefined) return downloadTask
      const task = (async () => {
        let confirmed: boolean
        try {
          confirmed = await adapter.confirmRollback(version)
        } catch {
          return
        }
        if (disposed || rollbackVersion !== version) return
        if (!confirmed) {
          const previousState = state
          state = state.lastPromptedVersion === undefined
            ? EMPTY_STATE
            : { version: 2, lastPromptedVersion: state.lastPromptedVersion }
          try {
            await persistRequiredState()
          } catch {
            state = previousState
            return
          }
          rollbackVersion = undefined
          refreshTray()
          return
        }
        const controller = new AbortController()
        downloadController = controller
        downloadingVersion = version
        refreshTray()
        try {
          await adapter.downloadAndOpen(version, controller.signal)
        } catch {
          // Rollback download and installer-opening failures remain retryable from the tray.
        } finally {
          if (downloadController === controller) downloadController = undefined
          downloadingVersion = undefined
          refreshTray()
        }
      })().finally(() => {
        if (downloadTask === task) downloadTask = undefined
      })
      downloadTask = task
      return task
    }

    const runAutomaticRollback = (): Promise<void> => {
      if (downloadTask !== undefined) return downloadTask
      const task = (async () => {
        await stateReady
        if (disposed || state.version !== 4
          || state.rollback.toVersion !== adapter.currentVersion
          || state.rollback.status !== 'verifying'
          || !adapter.isPackaged
          || !adapter.canDownload) return
        const previousState = state
        state = {
          ...state,
          rollback: { ...state.rollback, status: 'automatic-attempted' },
        }
        try {
          await persistRequiredState()
        } catch {
          state = previousState
          return
        }
        automaticRecoveryInFlight = true
        const version = state.rollback.fromVersion
        const controller = new AbortController()
        downloadController = controller
        downloadingVersion = version
        refreshTray()
        try {
          await adapter.downloadAndOpen(version, controller.signal, 'automatic-recovery')
        } catch {
          // Automatic rollback is one-shot; the tray keeps a manual retry available.
        } finally {
          if (downloadController === controller) downloadController = undefined
          downloadingVersion = undefined
          refreshTray()
        }
      })().finally(() => {
        if (downloadTask === task) downloadTask = undefined
      })
      downloadTask = task
      return task
    }

    const handleApplicationHealth = async (status: DesktopApplicationHealth): Promise<void> => {
      await stateReady
      if (disposed || state.version !== 4
        || state.rollback.toVersion !== adapter.currentVersion
        || state.rollback.status !== 'verifying') return
      if (healthTimer !== undefined) clearTimeout(healthTimer)
      healthTimer = undefined
      if (status === 'failed') {
        await runAutomaticRollback()
        return
      }
      const previousState = state
      state = {
        ...state,
        rollback: { ...state.rollback, status: 'available' },
      }
      try {
        await persistRequiredState()
      } catch {
        state = previousState
      }
      refreshTray()
    }

    const removeHealthHandler = ctx.desktopRuntime.registerApplicationHealthHandler((status) => {
      return handleApplicationHealth(status)
    })
    void stateReady.then(() => {
      if (disposed || !adapter.isPackaged || !adapter.canDownload || state.version !== 4
        || state.rollback.toVersion !== adapter.currentVersion) return
      if (state.rollback.status === 'verifying') {
        healthTimer = setTimeout(() => {
          healthTimer = undefined
          void runAutomaticRollback()
        }, config.healthTimeoutMs)
      } else if (state.rollback.status === 'automatic-attempted') {
        // A previous unhealthy startup already consumed the one automatic attempt.
      }
    })

    const runTrayCommand = async (): Promise<void> => {
      await stateReady
      if (disposed) return
      await (rollbackVersion === undefined ? runManualCheck() : runRollback())
    }

    const runBackgroundCheck = async (): Promise<void> => {
      await stateReady
      if (inFlight !== undefined
        || downloadTask !== undefined
        || rollbackVersion !== undefined
        || disposed) return
      try {
        const version = observeResult(await startCheck())
        if (version !== undefined) await offerDownload(version, true)
      } catch {
        // Scheduled checks never surface failures to the user or the application log.
      }
    }

    const scheduleBackgroundCheck = (delayMs: number): void => {
      pollTimer = setTimeout(() => {
        pollTimer = undefined
        void runBackgroundCheck().finally(() => {
          if (!disposed) scheduleBackgroundCheck(config.intervalMs)
        })
      }, delayMs)
    }

    const registration = ctx.desktopRuntime.registerTrayItem({
      group: 'status',
      order: 10,
      label: () => downloadingVersion === undefined
        ? rollbackVersion === undefined
          ? availableVersion === undefined
            ? checking ? 'Checking for Updates…' : 'Check for Updates…'
            : `Wan Code ${availableVersion} Available`
          : `Rollback to Wan Code ${rollbackVersion}…`
        : `Downloading Wan Code ${downloadingVersion}…`,
      invoke: runTrayCommand,
    })
    refreshTray = registration.refresh

    if (adapter.isPackaged && config.enabled) scheduleBackgroundCheck(config.initialDelayMs)

    return async () => {
      disposed = true
      if (pollTimer !== undefined) clearTimeout(pollTimer)
      if (requestTimer !== undefined) clearTimeout(requestTimer)
      if (healthTimer !== undefined) clearTimeout(healthTimer)
      requestController?.abort()
      if (!automaticRecoveryInFlight) downloadController?.abort()
      removeHealthHandler()
      registration.dispose()
      // Native dialogs are not cancellable. Await only file state and the abortable version request.
      const pending: Promise<unknown>[] = [stateReady]
      if (inFlight !== undefined) pending.push(inFlight)
      if (requiredStateWrite !== undefined) pending.push(requiredStateWrite)
      await Promise.allSettled(pending)
    }
  }, 'dsh-plugin-desktop: update polling, confirmation, and installer handoff')
}

function parseState(text: string): UpdateState {
  const value: unknown = JSON.parse(text)
  if (!isRecord(value)) throw new Error('invalid update state')
  if (value.version === 2) {
    if ((value.lastPromptedVersion !== undefined && !isReleaseVersion(value.lastPromptedVersion))
      || Object.keys(value).some(key => !['version', 'lastPromptedVersion'].includes(key))) {
      throw new Error('invalid v2 update state')
    }
    return value.lastPromptedVersion === undefined
      ? EMPTY_STATE
      : { version: 2, lastPromptedVersion: value.lastPromptedVersion as string }
  }
  if (value.version === 4) {
    if ((value.lastPromptedVersion !== undefined && !isReleaseVersion(value.lastPromptedVersion))
      || !isRecord(value.rollback)
      || !isReleaseVersion(value.rollback.fromVersion)
      || !isReleaseVersion(value.rollback.toVersion)
      || typeof value.rollback.status !== 'string'
      || !['pending', 'verifying', 'available', 'automatic-attempted'].includes(value.rollback.status)
      || (compareSemVerVersions(value.rollback.fromVersion, value.rollback.toVersion) ?? 0) >= 0
      || Object.keys(value).some(key => !['version', 'lastPromptedVersion', 'rollback'].includes(key))
      || Object.keys(value.rollback).some(key => !['fromVersion', 'toVersion', 'status'].includes(key))) {
      throw new Error('invalid v4 update state')
    }
    return {
      version: 4,
      ...(value.lastPromptedVersion === undefined
        ? {}
        : { lastPromptedVersion: value.lastPromptedVersion as string }),
      rollback: {
        fromVersion: value.rollback.fromVersion,
        toVersion: value.rollback.toVersion,
        status: value.rollback.status as UpdateRollbackStateV4['status'],
      },
    }
  }
  if (value.version !== 3
    || (value.lastPromptedVersion !== undefined && !isReleaseVersion(value.lastPromptedVersion))
    || !isRecord(value.rollback)
    || !isReleaseVersion(value.rollback.fromVersion)
    || !isReleaseVersion(value.rollback.toVersion)
    || typeof value.rollback.status !== 'string'
    || !['pending', 'available'].includes(value.rollback.status)
    || (compareSemVerVersions(value.rollback.fromVersion, value.rollback.toVersion) ?? 0) >= 0
    || Object.keys(value).some(key => !['version', 'lastPromptedVersion', 'rollback'].includes(key))
    || Object.keys(value.rollback).some(key => !['fromVersion', 'toVersion', 'status'].includes(key))) {
    throw new Error('invalid v3 update state')
  }
  return {
    version: 3,
    ...(value.lastPromptedVersion === undefined
      ? {}
      : { lastPromptedVersion: value.lastPromptedVersion as string }),
    rollback: {
      fromVersion: value.rollback.fromVersion,
      toVersion: value.rollback.toVersion,
      status: value.rollback.status as UpdateRollbackState['status'],
    },
  }
}

async function readState(filename: string): Promise<string> {
  const handle = await open(filename, 'r')
  try {
    const buffer = Buffer.alloc(MAX_STATE_BYTES + 1)
    const { bytesRead } = await handle.read(buffer, 0, buffer.byteLength, 0)
    if (bytesRead > MAX_STATE_BYTES) throw new Error(`update state exceeds ${MAX_STATE_BYTES} bytes`)
    return new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, bytesRead))
  } finally {
    await handle.close()
  }
}

function renderState(state: UpdateState): string {
  return `${JSON.stringify(state, null, 2)}\n`
}

function isReleaseVersion(value: unknown): value is string {
  if (typeof value !== 'string') return false
  const parsed = parseSemVer(value)
  return parsed !== null && parsed.version === value
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isEnoent(value: unknown): boolean {
  return isRecord(value) && value.code === 'ENOENT'
}
