import { mkdir, mkdtemp, readFile, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type {
  DesktopNotification,
  DesktopRuntime,
  DesktopTrayItem,
} from '../src/runtime.ts'
import type { UpdateCheckResult } from '../src/update-checker.ts'
import { apply, Config, inject, type Config as UpdateConfig } from '../src/updates.ts'

const testConfig: UpdateConfig = {
  channel: 'stable',
  enabled: true,
  initialDelayMs: 10,
  intervalMs: 1000,
  requestTimeoutMs: 1000,
  healthTimeoutMs: 30_000,
}

function versionResponse(version: unknown): Response {
  return Response.json({ tag_name: typeof version === 'string' ? `v${version}` : version })
}

interface Harness {
  readonly statePath: string
  readonly tray: DesktopTrayItem
  readonly notifications: DesktopNotification[]
  readonly warnings: unknown[][]
  readonly confirmDownload: ReturnType<typeof vi.fn>
  readonly confirmRollback: ReturnType<typeof vi.fn>
  readonly showManualCheckResult: ReturnType<typeof vi.fn>
  readonly downloadAndOpen: ReturnType<typeof vi.fn>
  readonly refresh: ReturnType<typeof vi.fn>
  readonly registrationDispose: ReturnType<typeof vi.fn>
  reportHealth(status: 'healthy' | 'failed'): void | Promise<void>
  dispose(): Promise<void>
}

async function createHarness(options: {
  readonly packaged?: boolean
  readonly currentVersion?: string
  readonly canDownload?: boolean
  readonly config?: UpdateConfig
  readonly request?: DesktopRuntime['updates']['request']
  readonly confirmDownload?: (version: string) => Promise<boolean>
  readonly confirmRollback?: (version: string) => Promise<boolean>
  readonly showManualCheckResult?: (result: UpdateCheckResult | null) => Promise<void>
  readonly downloadAndOpen?: (
    version: string,
    signal: AbortSignal,
    mode?: 'interactive' | 'automatic-recovery',
  ) => Promise<void>
  readonly notify?: (notification: DesktopNotification) => void
  readonly state?: string
} = {}): Promise<Harness> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-updates-'))
  const statePath = join(root, 'private', 'state.json')
  if (options.state !== undefined) {
    await mkdir(join(root, 'private'), { recursive: true })
    await writeFile(statePath, options.state, { mode: 0o600 })
  }
  const notifications: DesktopNotification[] = []
  const warnings: unknown[][] = []
  const refresh = vi.fn()
  const registrationDispose = vi.fn()
  const confirmDownload = vi.fn(options.confirmDownload ?? (async () => false))
  const confirmRollback = vi.fn(options.confirmRollback ?? (async () => false))
  const showManualCheckResult = vi.fn(options.showManualCheckResult ?? (async () => {}))
  const downloadAndOpen = vi.fn(options.downloadAndOpen ?? (async () => {}))
  let tray: DesktopTrayItem | undefined
  let disposer: (() => void | Promise<void>) | undefined
  let applicationHealthHandler: ((status: 'healthy' | 'failed') => void) | undefined
  const runtime = {
    updates: {
      isPackaged: options.packaged ?? true,
      currentVersion: options.currentVersion ?? '2.0.0',
      statePath,
      canDownload: options.canDownload ?? true,
      request: options.request ?? (async () => versionResponse('2.0.0')),
      confirmDownload,
      confirmRollback,
      showManualCheckResult,
      downloadAndOpen,
      notify: options.notify ?? ((notification: DesktopNotification) => { notifications.push(notification) }),
    },
    registerTrayItem: (item: DesktopTrayItem) => {
      tray = item
      return { refresh, dispose: registrationDispose }
    },
    registerApplicationHealthHandler: (handler: (status: 'healthy' | 'failed') => void) => {
      applicationHealthHandler = handler
      return () => {
        if (applicationHealthHandler === handler) applicationHealthHandler = undefined
      }
    },
  } as unknown as DesktopRuntime
  const ctx = {
    desktopRuntime: runtime,
    logger: { warn: (...args: unknown[]) => { warnings.push(args) } },
    effect: (register: () => (() => void | Promise<void>)) => {
      disposer = register()
      return disposer
    },
  } as unknown as Context

  apply(ctx, options.config ?? testConfig)
  if (tray === undefined) throw new Error('Update tray item was not registered.')
  return {
    statePath,
    tray,
    notifications,
    warnings,
    confirmDownload,
    confirmRollback,
    showManualCheckResult,
    downloadAndOpen,
    refresh,
    registrationDispose,
    reportHealth: status => applicationHealthHandler?.(status),
    dispose: async () => { await disposer?.() },
  }
}

afterEach(() => {
  vi.useRealTimers()
})

describe('desktop update Host plugin', () => {
  it('automatically rolls back once when the updated renderer reports failed health', async () => {
    const harness = await createHarness({
      currentVersion: '2.1.0',
      config: { ...testConfig, enabled: false },
      state: JSON.stringify({
        version: 3,
        rollback: {
          fromVersion: '2.0.0',
          toVersion: '2.1.0',
          status: 'pending',
        },
      }),
    })

    await vi.waitFor(async () => {
      expect(JSON.parse(await readFile(harness.statePath, 'utf8'))).toEqual({
        version: 4,
        rollback: {
          fromVersion: '2.0.0',
          toVersion: '2.1.0',
          status: 'verifying',
        },
      })
    })
    harness.reportHealth('failed')

    await vi.waitFor(() => {
      expect(harness.downloadAndOpen).toHaveBeenCalledWith(
        '2.0.0',
        expect.any(AbortSignal),
        'automatic-recovery',
      )
    })
    expect(harness.confirmRollback).not.toHaveBeenCalled()
    expect(JSON.parse(await readFile(harness.statePath, 'utf8'))).toEqual({
      version: 4,
      rollback: {
        fromVersion: '2.0.0',
        toVersion: '2.1.0',
        status: 'automatic-attempted',
      },
    })
  })

  it('keeps manual rollback available after the updated renderer reports healthy', async () => {
    const harness = await createHarness({
      currentVersion: '2.1.0',
      config: { ...testConfig, enabled: false },
      state: JSON.stringify({
        version: 4,
        rollback: {
          fromVersion: '2.0.0',
          toVersion: '2.1.0',
          status: 'pending',
        },
      }),
    })

    await vi.waitFor(async () => {
      expect(JSON.parse(await readFile(harness.statePath, 'utf8')).rollback.status).toBe('verifying')
    })
    harness.reportHealth('healthy')

    await vi.waitFor(async () => {
      expect(JSON.parse(await readFile(harness.statePath, 'utf8'))).toEqual({
        version: 4,
        rollback: {
          fromVersion: '2.0.0',
          toVersion: '2.1.0',
          status: 'available',
        },
      })
    })
    expect(harness.downloadAndOpen).not.toHaveBeenCalled()
    expect(harness.tray.label()).toBe('Rollback to Wan Code 2.0.0…')
  })

  it('automatically rolls back when the updated renderer misses its health deadline', async () => {
    vi.useFakeTimers()
    const harness = await createHarness({
      currentVersion: '2.1.0',
      config: { ...testConfig, enabled: false, healthTimeoutMs: 25 },
      state: JSON.stringify({
        version: 4,
        rollback: {
          fromVersion: '2.0.0',
          toVersion: '2.1.0',
          status: 'pending',
        },
      }),
    })

    await vi.waitFor(async () => {
      expect(JSON.parse(await readFile(harness.statePath, 'utf8')).rollback.status).toBe('verifying')
    })
    await vi.advanceTimersByTimeAsync(25)

    await vi.waitFor(() => {
      expect(harness.downloadAndOpen).toHaveBeenCalledWith(
        '2.0.0',
        expect.any(AbortSignal),
        'automatic-recovery',
      )
    })
    expect(harness.confirmRollback).not.toHaveBeenCalled()
  })

  it('does not abort automatic recovery when the Host disposes during download', async () => {
    let observedSignal: AbortSignal | undefined
    let finishDownload!: () => void
    const downloadStarted = new Promise<void>((resolve) => {
      finishDownload = resolve
    })
    const harness = await createHarness({
      currentVersion: '2.1.0',
      config: { ...testConfig, enabled: false },
      state: JSON.stringify({
        version: 4,
        rollback: {
          fromVersion: '2.0.0',
          toVersion: '2.1.0',
          status: 'verifying',
        },
      }),
      downloadAndOpen: async (_version, signal) => {
        observedSignal = signal
        await downloadStarted
      },
    })

    await vi.waitFor(() => {
      expect(harness.tray.label()).toBe('Rollback to Wan Code 2.0.0…')
    })
    const health = Promise.resolve(harness.reportHealth('failed'))
    await vi.waitFor(() => { expect(harness.downloadAndOpen).toHaveBeenCalledOnce() })
    await harness.dispose()

    expect(observedSignal?.aborted).toBe(false)
    finishDownload()
    await health
  })

  it('does not repeat an automatic rollback attempt on a later unhealthy launch', async () => {
    vi.useFakeTimers()
    const harness = await createHarness({
      currentVersion: '2.1.0',
      config: { ...testConfig, enabled: false, healthTimeoutMs: 25 },
      state: JSON.stringify({
        version: 4,
        rollback: {
          fromVersion: '2.0.0',
          toVersion: '2.1.0',
          status: 'automatic-attempted',
        },
      }),
    })

    await vi.waitFor(() => {
      expect(harness.tray.label()).toBe('Rollback to Wan Code 2.0.0…')
    })
    harness.reportHealth('failed')
    await vi.advanceTimersByTimeAsync(100)

    expect(harness.downloadAndOpen).not.toHaveBeenCalled()
    expect(harness.confirmRollback).not.toHaveBeenCalled()
  })

  it('offers manual rollback while the target version awaits health confirmation', async () => {
    const harness = await createHarness({
      packaged: false,
      currentVersion: '2.1.0',
      state: JSON.stringify({
        version: 3,
        lastPromptedVersion: '2.1.0',
        rollback: {
          fromVersion: '2.0.0',
          toVersion: '2.1.0',
          status: 'pending',
        },
      }),
      confirmRollback: async () => true,
    })

    await vi.waitFor(() => {
      expect(harness.tray.label()).toBe('Rollback to Wan Code 2.0.0…')
    })
    await harness.tray.invoke()

    expect(harness.confirmRollback).toHaveBeenCalledWith('2.0.0')
    expect(harness.downloadAndOpen).toHaveBeenCalledWith('2.0.0', expect.any(AbortSignal))
    expect(JSON.parse(await readFile(harness.statePath, 'utf8'))).toEqual({
      version: 4,
      lastPromptedVersion: '2.1.0',
      rollback: {
        fromVersion: '2.0.0',
        toVersion: '2.1.0',
        status: 'verifying',
      },
    })
  })

  it('dismisses an available rollback when the user keeps the current version', async () => {
    const harness = await createHarness({
      packaged: false,
      currentVersion: '2.1.0',
      state: JSON.stringify({
        version: 3,
        rollback: {
          fromVersion: '2.0.0',
          toVersion: '2.1.0',
          status: 'available',
        },
      }),
      confirmRollback: async () => false,
    })

    await vi.waitFor(() => {
      expect(harness.tray.label()).toBe('Rollback to Wan Code 2.0.0…')
    })
    await harness.tray.invoke()

    expect(harness.tray.label()).toBe('Check for Updates…')
    expect(JSON.parse(await readFile(harness.statePath, 'utf8'))).toEqual({ version: 2 })
  })

  it('clears the automatic rollback marker after the previous version starts again', async () => {
    const harness = await createHarness({
      packaged: false,
      currentVersion: '2.0.0',
      state: JSON.stringify({
        version: 4,
        lastPromptedVersion: '2.1.0',
        rollback: {
          fromVersion: '2.0.0',
          toVersion: '2.1.0',
          status: 'automatic-attempted',
        },
      }),
    })

    await vi.waitFor(async () => {
      expect(JSON.parse(await readFile(harness.statePath, 'utf8'))).toEqual({
        version: 2,
        lastPromptedVersion: '2.1.0',
      })
    })
    expect(harness.tray.label()).toBe('Check for Updates…')
  })

  it('does not poll or consume update prompts while rollback is available', async () => {
    vi.useFakeTimers()
    const request = vi.fn(async () => versionResponse('2.2.0'))
    const harness = await createHarness({
      currentVersion: '2.1.0',
      request,
      state: JSON.stringify({
        version: 3,
        rollback: {
          fromVersion: '2.0.0',
          toVersion: '2.1.0',
          status: 'available',
        },
      }),
    })

    await vi.advanceTimersByTimeAsync(testConfig.initialDelayMs + testConfig.intervalMs)

    expect(request).not.toHaveBeenCalled()
    expect(harness.confirmDownload).not.toHaveBeenCalled()
  })

  it('waits for rollback state before dispatching an immediate tray click', async () => {
    const request = vi.fn(async () => versionResponse('2.2.0'))
    const harness = await createHarness({
      packaged: false,
      currentVersion: '2.1.0',
      request,
      state: JSON.stringify({
        version: 3,
        rollback: {
          fromVersion: '2.0.0',
          toVersion: '2.1.0',
          status: 'available',
        },
      }),
    })

    await harness.tray.invoke()

    expect(harness.confirmRollback).toHaveBeenCalledWith('2.0.0')
    expect(request).not.toHaveBeenCalled()
  })

  it('does not let a disposed rollback dialog overwrite state', async () => {
    let closeDialog!: (confirmed: boolean) => void
    const confirmation = new Promise<boolean>(resolve => { closeDialog = resolve })
    const originalState = {
      version: 4,
      rollback: {
        fromVersion: '2.0.0',
        toVersion: '2.1.0',
        status: 'available',
      },
    }
    const harness = await createHarness({
      packaged: false,
      currentVersion: '2.1.0',
      state: JSON.stringify(originalState),
      confirmRollback: async () => confirmation,
    })

    await vi.waitFor(() => {
      expect(harness.tray.label()).toBe('Rollback to Wan Code 2.0.0…')
    })
    const pending = harness.tray.invoke()
    await vi.waitFor(() => { expect(harness.confirmRollback).toHaveBeenCalledOnce() })
    await harness.dispose()
    closeDialog(false)
    await pending

    expect(JSON.parse(await readFile(harness.statePath, 'utf8'))).toEqual(originalState)
  })

  it('exposes the packaged 60-second and six-hour background policy', () => {
    expect(inject).toEqual(['desktopRuntime'])
    expect(Config({} as UpdateConfig)).toEqual({
      channel: 'stable',
      enabled: true,
      initialDelayMs: 60_000,
      intervalMs: 21_600_000,
      requestTimeoutMs: 15_000,
      healthTimeoutMs: 30_000,
    })
    expect(() => Config({ intervalMs: 0 } as UpdateConfig)).toThrow()
    expect(() => Config({ requestTimeoutMs: 0 } as UpdateConfig)).toThrow()
    expect(() => Config({ healthTimeoutMs: 0 } as UpdateConfig)).toThrow()
  })

  it.each([
    { packaged: false, enabled: true },
    { packaged: true, enabled: false },
  ])('reports a manual up-to-date result while automatic polling is disabled: %#', async ({ packaged, enabled }) => {
    vi.useFakeTimers()
    const request = vi.fn(async () => versionResponse('2.0.0'))
    const harness = await createHarness({
      packaged,
      request,
      config: { ...testConfig, enabled },
    })

    await vi.advanceTimersByTimeAsync(testConfig.intervalMs)
    expect(request).not.toHaveBeenCalled()
    expect(harness.tray.label()).toBe('Check for Updates…')
    await harness.tray.invoke()
    expect(request).toHaveBeenCalledOnce()
    expect(harness.showManualCheckResult).toHaveBeenCalledWith({
      status: 'up-to-date',
      currentVersion: '2.0.0',
      latestVersion: '2.0.0',
    })
    expect(harness.confirmDownload).not.toHaveBeenCalled()
    expect(harness.downloadAndOpen).not.toHaveBeenCalled()
    expect(harness.notifications).toEqual([])
    expect(harness.warnings).toEqual([])
  })

  it('uses the beta release stream for manual checks and offers prerelease assets', async () => {
    const requested: string[] = []
    const harness = await createHarness({
      packaged: false,
      config: { ...testConfig, channel: 'beta' },
      request: async (url) => {
        requested.push(url)
        return Response.json([
          { tag_name: 'v2.1.0-beta.1', draft: false, prerelease: true },
          { tag_name: 'v2.0.1', draft: false, prerelease: false },
        ])
      },
    })

    await harness.tray.invoke()

    expect(requested).toEqual([
      'https://api.github.com/repos/ThomasWan123/wancode-NewVer/releases?per_page=100&page=1',
    ])
    expect(harness.confirmDownload).toHaveBeenCalledWith('2.1.0-beta.1')
    expect(harness.tray.label()).toBe('Wan Code 2.1.0-beta.1 Available')
  })

  it('preserves beta prompt history across restarts', async () => {
    const request = vi.fn(async () => Response.json([
      { tag_name: 'v2.1.0-beta.1', draft: false, prerelease: true },
    ]))
    const harness = await createHarness({
      config: {
        ...testConfig,
        channel: 'beta',
        initialDelayMs: 1,
        intervalMs: 10,
      },
      state: JSON.stringify({
        version: 2,
        lastPromptedVersion: '2.1.0-beta.1',
      }),
      request,
    })

    await vi.waitFor(() => { expect(request.mock.calls.length).toBeGreaterThanOrEqual(2) })

    expect(harness.confirmDownload).not.toHaveBeenCalled()
    expect(JSON.parse(await readFile(harness.statePath, 'utf8'))).toEqual({
      version: 2,
      lastPromptedVersion: '2.1.0-beta.1',
    })
    await harness.dispose()
  })

  it('prompts once for a background update and persists only state v2 prompt history', async () => {
    vi.useFakeTimers()
    const request = vi.fn(async () => versionResponse('2.1.0'))
    const harness = await createHarness({ request })

    await vi.advanceTimersByTimeAsync(testConfig.initialDelayMs)
    await vi.waitFor(() => { expect(harness.confirmDownload).toHaveBeenCalledWith('2.1.0') })
    expect(harness.downloadAndOpen).not.toHaveBeenCalled()
    expect(harness.tray.label()).toBe('Wan Code 2.1.0 Available')
    await vi.waitFor(async () => {
      expect(JSON.parse(await readFile(harness.statePath, 'utf8'))).toEqual({
        version: 2,
        lastPromptedVersion: '2.1.0',
      })
    })
    if (process.platform !== 'win32') {
      expect((await stat(harness.statePath)).mode & 0o777).toBe(0o600)
    }

    await vi.advanceTimersByTimeAsync(testConfig.intervalMs)
    await vi.waitFor(() => { expect(request).toHaveBeenCalledTimes(2) })
    expect(harness.confirmDownload).toHaveBeenCalledOnce()
    expect(harness.notifications).toEqual([])
    expect(harness.warnings).toEqual([])
  })

  it('downloads and opens only after confirmation', async () => {
    vi.useFakeTimers()
    let resolveDownload!: () => void
    const download = new Promise<void>(resolve => { resolveDownload = resolve })
    const harness = await createHarness({
      request: async () => versionResponse('2.1.0'),
      confirmDownload: async () => true,
      downloadAndOpen: async () => download,
    })

    await vi.advanceTimersByTimeAsync(testConfig.initialDelayMs)
    await vi.waitFor(() => { expect(harness.downloadAndOpen).toHaveBeenCalledOnce() })
    const [version, signal] = harness.downloadAndOpen.mock.calls[0] as [string, AbortSignal]
    expect(version).toBe('2.1.0')
    expect(signal).toBeInstanceOf(AbortSignal)
    expect(signal.aborted).toBe(false)
    expect(harness.tray.label()).toBe('Downloading Wan Code 2.1.0…')
    expect(JSON.parse(await readFile(harness.statePath, 'utf8'))).toEqual({
      version: 4,
      lastPromptedVersion: '2.1.0',
      rollback: {
        fromVersion: '2.0.0',
        toVersion: '2.1.0',
        status: 'pending',
      },
    })
    expect(harness.notifications).toEqual([])

    resolveDownload()
    await vi.waitFor(() => { expect(harness.tray.label()).toBe('Wan Code 2.1.0 Available') })
    expect(harness.notifications).toEqual([])
    expect(harness.tray.label()).toBe('Wan Code 2.1.0 Available')
  })

  it('treats a manual available-version selection as a fresh confirmation', async () => {
    const confirmDownload = vi.fn()
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(true)
    const harness = await createHarness({
      packaged: false,
      request: async () => versionResponse('2.1.0'),
      confirmDownload,
    })

    await harness.tray.invoke()
    expect(confirmDownload).toHaveBeenCalledOnce()
    expect(harness.downloadAndOpen).not.toHaveBeenCalled()
    expect(harness.tray.label()).toBe('Wan Code 2.1.0 Available')

    await harness.tray.invoke()
    expect(confirmDownload).toHaveBeenCalledTimes(2)
    expect(harness.downloadAndOpen).toHaveBeenCalledOnce()
    expect(harness.showManualCheckResult).not.toHaveBeenCalled()
  })

  it('rechecks the version after confirmation and skips a rotated download', async () => {
    const request = vi.fn()
      .mockResolvedValueOnce(versionResponse('2.1.0'))
      .mockResolvedValueOnce(versionResponse('2.2.0'))
    const harness = await createHarness({
      packaged: false,
      request,
      confirmDownload: async () => true,
    })

    await harness.tray.invoke()

    expect(request).toHaveBeenCalledTimes(2)
    expect(harness.confirmDownload).toHaveBeenCalledWith('2.1.0')
    expect(harness.downloadAndOpen).not.toHaveBeenCalled()
    expect(harness.showManualCheckResult).not.toHaveBeenCalled()
    expect(harness.tray.label()).toBe('Wan Code 2.2.0 Available')
  })

  it.each([
    ['up-to-date', async () => versionResponse('2.0.0')],
    ['failed', async () => new Response('unavailable', { status: 503 })],
  ] as const)('keeps an automatic %s result silent', async (_case, request) => {
    vi.useFakeTimers()
    const requestSpy = vi.fn(request)
    const harness = await createHarness({ request: requestSpy })

    await vi.advanceTimersByTimeAsync(testConfig.initialDelayMs)
    await vi.waitFor(() => { expect(requestSpy).toHaveBeenCalledOnce() })

    expect(harness.showManualCheckResult).not.toHaveBeenCalled()
    expect(harness.confirmDownload).not.toHaveBeenCalled()
    expect(harness.downloadAndOpen).not.toHaveBeenCalled()
  })

  it.each([
    ['same version', async () => versionResponse('2.0.0'), {
      status: 'up-to-date', currentVersion: '2.0.0', latestVersion: '2.0.0',
    }],
    ['older version', async () => versionResponse('1.9.9'), {
      status: 'up-to-date', currentVersion: '2.0.0', latestVersion: '1.9.9',
    }],
    ['invalid version', async () => versionResponse('v2.1.0'), null],
    ['service unavailable', async () => new Response('unavailable', { status: 503 }), null],
    ['network failure', async () => { throw new TypeError('offline') }, null],
  ] as const)('reports a manual %s result without prompting or downloading', async (_case, request, expected) => {
    const harness = await createHarness({ packaged: false, request })

    await harness.tray.invoke()

    expect(harness.showManualCheckResult).toHaveBeenCalledWith(expected)
    expect(harness.confirmDownload).not.toHaveBeenCalled()
    expect(harness.downloadAndOpen).not.toHaveBeenCalled()
    expect(harness.notifications).toEqual([])
    expect(harness.warnings).toEqual([])
    expect(harness.tray.label()).toBe('Check for Updates…')
  })

  it('silently resets legacy state and does not use it as an available version cache', async () => {
    vi.useFakeTimers()
    const harness = await createHarness({
      request: async () => versionResponse('2.1.0'),
      state: JSON.stringify({
        version: 1,
        checkedVersion: '2.0.0',
        etag: '"legacy"',
        lastNotifiedVersion: '2.1.0',
        availableRelease: {
          tagName: 'v2.1.0',
          version: '2.1.0',
          htmlUrl: 'https://example.test/legacy',
        },
      }),
    })

    expect(harness.tray.label()).toBe('Check for Updates…')
    await vi.advanceTimersByTimeAsync(testConfig.initialDelayMs)
    await vi.waitFor(() => { expect(harness.confirmDownload).toHaveBeenCalledWith('2.1.0') })
    await vi.waitFor(async () => {
      expect(JSON.parse(await readFile(harness.statePath, 'utf8'))).toEqual({
        version: 2,
        lastPromptedVersion: '2.1.0',
      })
    })
    expect(harness.warnings).toEqual([])
  })

  it('rejects a malformed rollback status instead of coercing it', async () => {
    const harness = await createHarness({
      packaged: false,
      state: JSON.stringify({
        version: 3,
        rollback: {
          fromVersion: '2.0.0',
          toVersion: '2.1.0',
          status: ['pending'],
        },
      }),
    })

    await vi.waitFor(async () => {
      expect(JSON.parse(await readFile(harness.statePath, 'utf8'))).toEqual({ version: 2 })
    })
    expect(harness.tray.label()).toBe('Check for Updates…')
  })

  it('does not prompt on a platform without a fixed download entry', async () => {
    const harness = await createHarness({
      packaged: false,
      canDownload: false,
      request: async () => versionResponse('2.1.0'),
    })

    await harness.tray.invoke()

    expect(harness.confirmDownload).not.toHaveBeenCalled()
    expect(harness.showManualCheckResult).toHaveBeenCalledWith({
      status: 'update-available',
      currentVersion: '2.0.0',
      latestVersion: '2.1.0',
    })
    expect(harness.downloadAndOpen).not.toHaveBeenCalled()
    expect(harness.notifications).toEqual([])
    expect(harness.tray.label()).toBe('Check for Updates…')
  })

  it('shares one pending download and silently restores availability after failure', async () => {
    let rejectDownload!: (cause: Error) => void
    const download = new Promise<void>((_resolve, reject) => { rejectDownload = reject })
    const harness = await createHarness({
      packaged: false,
      request: async () => versionResponse('2.1.0'),
      confirmDownload: async () => true,
      downloadAndOpen: async () => download,
    })

    const first = harness.tray.invoke()
    await vi.waitFor(() => { expect(harness.downloadAndOpen).toHaveBeenCalledOnce() })
    const second = harness.tray.invoke()
    expect(harness.downloadAndOpen).toHaveBeenCalledOnce()
    rejectDownload(new Error('offline'))
    await Promise.all([first, second])

    expect(harness.downloadAndOpen).toHaveBeenCalledOnce()
    expect(harness.notifications).toEqual([])
    expect(harness.warnings).toEqual([])
    expect(harness.tray.label()).toBe('Wan Code 2.1.0 Available')
  })

  it('aborts checks and downloads and removes the tray item on effect disposal', async () => {
    let checkSignal: AbortSignal | undefined
    const checking = await createHarness({
      packaged: false,
      request: async (_url, init) => new Promise<Response>((_resolve, reject) => {
        checkSignal = init.signal as AbortSignal
        checkSignal.addEventListener('abort', () => {
          reject(new DOMException('disposed', 'AbortError'))
        }, { once: true })
      }),
    })
    const pendingCheck = checking.tray.invoke()
    await vi.waitFor(() => { expect(checkSignal).toBeDefined() })
    await checking.dispose()
    await pendingCheck
    expect(checkSignal?.aborted).toBe(true)
    expect(checking.registrationDispose).toHaveBeenCalledOnce()
    expect(checking.notifications).toEqual([])

    let downloadSignal: AbortSignal | undefined
    const downloading = await createHarness({
      packaged: false,
      request: async () => versionResponse('2.1.0'),
      confirmDownload: async () => true,
      downloadAndOpen: async (_version, signal) => new Promise<void>((_resolve, reject) => {
        downloadSignal = signal
        signal.addEventListener('abort', () => {
          reject(new DOMException('disposed', 'AbortError'))
        }, { once: true })
      }),
    })
    const pendingDownload = downloading.tray.invoke()
    await vi.waitFor(() => { expect(downloadSignal).toBeDefined() })
    await downloading.dispose()
    await pendingDownload
    expect(downloadSignal?.aborted).toBe(true)
    expect(downloading.registrationDispose).toHaveBeenCalledOnce()
    expect(downloading.notifications).toEqual([])
    expect(downloading.warnings).toEqual([])
  })

  it('does not wait for an open manual result dialog during disposal', async () => {
    let closeDialog!: () => void
    const dialog = new Promise<void>(resolve => { closeDialog = resolve })
    const harness = await createHarness({
      packaged: false,
      showManualCheckResult: async () => dialog,
    })
    const pending = harness.tray.invoke()
    await vi.waitFor(() => { expect(harness.showManualCheckResult).toHaveBeenCalledOnce() })

    await harness.dispose()
    expect(harness.registrationDispose).toHaveBeenCalledOnce()

    closeDialog()
    await pending
  })

  it('reports a timed-out shared manual request and restores the idle tray label', async () => {
    vi.useFakeTimers()
    const signals: AbortSignal[] = []
    const request = vi.fn((_url: string, init: RequestInit) => new Promise<Response>((_resolve, reject) => {
      const signal = init.signal as AbortSignal
      signals.push(signal)
      signal.addEventListener('abort', () => {
        reject(new DOMException('cancelled', 'AbortError'))
      }, { once: true })
    }))
    const harness = await createHarness({ packaged: false, request })

    const first = harness.tray.invoke()
    const second = harness.tray.invoke()
    await vi.waitFor(() => { expect(request).toHaveBeenCalledOnce() })
    expect(harness.tray.label()).toBe('Checking for Updates…')
    await vi.advanceTimersByTimeAsync(testConfig.requestTimeoutMs)
    await Promise.all([first, second])

    expect(signals[0]?.aborted).toBe(true)
    expect(harness.confirmDownload).not.toHaveBeenCalled()
    expect(harness.showManualCheckResult).toHaveBeenCalledWith(null)
    expect(harness.notifications).toEqual([])
    expect(harness.warnings).toEqual([])
    expect(harness.tray.label()).toBe('Check for Updates…')
  })
})
