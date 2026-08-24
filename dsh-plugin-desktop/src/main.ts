/** Wancode executable: minimal Electron bootstrap around the Host Cordis root. */

import { app, BrowserWindow } from 'electron'
import type { Context } from '@deepseek-ai/cordis'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  boot,
  installFailLoud,
  loadLayeredEnv,
  type FailLoudProcess,
} from '@deepseek-ai/dsh-app-boot'
import { provideCmdline } from '@deepseek-ai/dsh-cmdline'
import { defaultDshHome } from '@deepseek-ai/dsh-home-paths'
import { DSH_LAUNCH_ENVIRONMENT_KEY } from '@deepseek-ai/dsh-launch-environment'
import { appendDesktopLog, installDesktopLogMirror } from './desktop-log.ts'
import {
  markDesktopCleanExit,
  prepareDesktopCrashRecovery,
} from './crash-recovery.ts'
import {
  installDesktopDshRuntime,
  installDesktopPnpmRuntime,
} from './desktop-runtime-environment.ts'
import { ElectronDesktopRuntime } from './electron-runtime.ts'
import { maybeImportLegacyHarnessHome } from './home-migration.ts'
import { installProfilePackageResolver } from './module-resolution.ts'
import { packagedDependencyPath } from './packaged-runtime-path.ts'
import {
  configureWancodeHarnessHome,
  configureWancodeTelemetry,
  WANCODE_APP_ID,
  WANCODE_PRODUCT_NAME,
} from './product.ts'
import {
  beginDesktopProfileStartup,
  listDesktopProfiles,
  markDesktopProfileFailed,
  markDesktopProfileHealthy,
  selectDesktopProfile,
  type DesktopProfileStartup,
} from './profile-manager.ts'
import { DesktopProfileService } from './profile-service.ts'
import { prepareDesktopProfile, type SkippedOptionalEntry } from './profile.ts'
import type { DesktopPnpmBootstrap } from './pnpm.ts'
import {
  createDesktopExitCoordinator,
  createDesktopShutdown,
  installShutdownRequests,
  type DesktopShutdown,
} from './shutdown.ts'
import {
  diagnoseWindowsVolumes,
  formatWindowsVolumeConcern,
  type WindowsVolumeConcern,
} from './windows-volume-diagnostics.ts'

const BIN_NAME = 'dsh-plugin-desktop'

/** Report profile recovery without changing startup or rollback outcomes. */
function notifyProfileRecovery(runtime: ElectronDesktopRuntime, body: string): void {
  try {
    runtime.updates.notify({ title: 'Unable to Open Profile', body })
  } catch (cause) {
    process.stderr.write(
      `${BIN_NAME}: failed to show profile recovery notification: ${cause instanceof Error ? cause.message : String(cause)}\n`,
    )
  }
}

/** Report optional user UI plugins skipped to keep startup recoverable. */
function notifySkippedOptionalEntries(
  runtime: ElectronDesktopRuntime,
  entries: readonly SkippedOptionalEntry[],
): void {
  if (entries.length === 0) return
  const names = entries.map(entry => entry.name)
  const suffix = names.length > 1 ? ` and ${names.length - 1} more` : ''
  try {
    runtime.updates.notify({
      title: 'Skipped Unavailable UI Plugin',
      body: `${names[0]} is not installed in this profile${suffix}.`,
    })
  } catch (cause) {
    process.stderr.write(
      `${BIN_NAME}: failed to show skipped plugin notification: ${cause instanceof Error ? cause.message : String(cause)}\n`,
    )
  }
}

/** Surface path/volume risks that otherwise become obscure sandbox or pnpm failures later. */
function warnWindowsVolumeConcerns(concerns: readonly WindowsVolumeConcern[]): void {
  for (const concern of concerns) {
    process.stderr.write(`${BIN_NAME}: Windows volume warning: ${formatWindowsVolumeConcern(concern)}\n`)
  }
}

/** Notify once after the UI is ready; stderr carries the exact paths. */
function notifyWindowsVolumeConcerns(
  runtime: ElectronDesktopRuntime,
  concerns: readonly WindowsVolumeConcern[],
): void {
  if (concerns.length === 0) return
  try {
    runtime.updates.notify({
      title: 'Storage May Be Unsupported',
      body: `${concerns[0]?.label ?? 'A configured path'} is on a volume that may break sandboxed commands or plugin installs.`,
    })
  } catch (cause) {
    process.stderr.write(
      `${BIN_NAME}: failed to show Windows volume warning: ${cause instanceof Error ? cause.message : String(cause)}\n`,
    )
  }
}

/** Show a visible status window until the Host tree can mount the real shell. */
function openStartupStatusWindow(): BrowserWindow {
  const window = new BrowserWindow({
    width: 420,
    height: 180,
    show: true,
    resizable: false,
    autoHideMenuBar: true,
    title: WANCODE_PRODUCT_NAME,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  })
  if (process.platform === 'win32') window.removeMenu()
  void window.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(
    '<!doctype html><html><body style="margin:0;height:100%;display:flex;align-items:center;justify-content:center;font:14px Segoe UI,sans-serif;background:#f4f4f5;color:#18181b"><p>Starting WanCodeNewVer…</p></body></html>',
  )}`)
  return window
}

function closeStartupStatusWindow(window: BrowserWindow | undefined): void {
  if (window === undefined || window.isDestroyed()) return
  window.destroy()
}

/** Start one Electron process and leave lifetime to the mounted desktop plugin. */
async function start(): Promise<void> {
  app.setName(WANCODE_PRODUCT_NAME)
  const userDataPath = app.getPath('userData')
  if (!app.requestSingleInstanceLock()) {
    appendDesktopLog(
      userDataPath,
      `${BIN_NAME}: another WanCodeNewVer process already holds the single-instance lock\n`,
    )
    app.quit()
    return
  }
  let crashRecovery
  try {
    crashRecovery = prepareDesktopCrashRecovery(userDataPath)
  } catch (cause) {
    process.stderr.write(
      `${BIN_NAME}: failed to inspect previous exit: ${cause instanceof Error ? cause.message : String(cause)}\n`,
    )
    crashRecovery = { disableHardwareAcceleration: false, recoveredFromCrash: false }
  }
  if (crashRecovery.disableHardwareAcceleration) {
    app.disableHardwareAcceleration()
  }

  let current: Context | undefined
  let profileStartup: DesktopProfileStartup | undefined
  let profileStatePath: string | undefined
  let shutdown: DesktopShutdown | undefined
  let removeShutdownRequests: (() => void) | undefined
  let disposeDshRuntime: (() => void) | undefined
  let disposePnpmRuntime: (() => void) | undefined
  let runtime!: ElectronDesktopRuntime
  let startupWindow: BrowserWindow | undefined
  const nativeExit = createDesktopExitCoordinator(
    {
      prepareToQuit: () => {
        runtime.prepareToQuit()
        try {
          markDesktopCleanExit(app.getPath('userData'))
        } catch (cause) {
          process.stderr.write(
            `${BIN_NAME}: failed to record a clean exit: ${cause instanceof Error ? cause.message : String(cause)}\n`,
          )
        }
      },
      relaunch: () => { app.relaunch() },
      exit: code => { app.exit(code) },
    },
    () => { removeShutdownRequests?.() },
  )
  let restartRequested = false
  runtime = new ElectronDesktopRuntime(async () => {
    if (shutdown === undefined) {
      throw new Error('dsh-plugin-desktop: shutdown coordinator is not ready')
    }
    if (restartRequested) return
    restartRequested = true
    nativeExit.requestRelaunch()
    await shutdown.request(0)
  }, (report) => {
    if (profileStartup === undefined || profileStatePath === undefined) {
      throw new Error('dsh-plugin-desktop: renderer boot health arrived before profile startup')
    }
    if (report.status === 'healthy') {
      markDesktopProfileHealthy(profileStatePath, profileStartup.profileName)
    } else {
      markDesktopProfileFailed(profileStatePath, profileStartup.profileName)
    }
  })
  const finalExit = (code: number): void => { nativeExit.finish(code) }
  shutdown = createDesktopShutdown(
    async () => {
      try {
        await current?.fiber.dispose()
      } finally {
        disposeDshRuntime?.()
        disposePnpmRuntime?.()
      }
    },
    finalExit,
  )
  const requestQuit = (code: number): void => { void shutdown.request(code) }
  removeShutdownRequests = installShutdownRequests(process, app, requestQuit)

  app.on('second-instance', () => {
    appendDesktopLog(app.getPath('userData'), `${BIN_NAME}: second launch requested; showing the existing window\n`)
    runtime.show()
  })
  app.on('window-all-closed', () => {
    // Tray sessions stay alive until the user quits from the tray.
  })
  await app.whenReady()
  app.on('child-process-gone', (_event, details) => {
    process.stderr.write(
      `${BIN_NAME}: child process gone: ${details.type} ${details.reason} (${String(details.exitCode)})\n`,
    )
  })
  process.on('uncaughtException', (error) => {
    process.stderr.write(
      `${BIN_NAME}: uncaught exception: ${error.stack ?? error.message}\n`,
    )
  })
  try {
    installDesktopLogMirror(app.getPath('userData'))
    appendDesktopLog(
      app.getPath('userData'),
      `${BIN_NAME}: starting ${WANCODE_PRODUCT_NAME} on ${process.platform}\n`,
    )
    if (crashRecovery.recoveredFromCrash) {
      appendDesktopLog(
        app.getPath('userData'),
        `${BIN_NAME}: previous generation exited uncleanly; GPU cache cleared and hardware acceleration disabled\n`,
      )
    }
  } catch (cause) {
    process.stderr.write(
      `${BIN_NAME}: failed to install diagnostics log: ${cause instanceof Error ? cause.message : String(cause)}\n`,
    )
  }
  if (process.platform === 'win32') app.setAppUserModelId(WANCODE_APP_ID)
  if (app.isPackaged && process.cwd() === '/') process.chdir(app.getPath('home'))
  const explicitHome = process.env.DSH_HOME !== undefined && process.env.DSH_HOME.trim().length > 0
  const homeDir = configureWancodeHarnessHome(app.getPath('userData'), process.env)
  configureWancodeTelemetry(process.env)
  try {
    await maybeImportLegacyHarnessHome({
      userDataPath: app.getPath('userData'),
      destinationHome: homeDir,
      sourceHome: defaultDshHome(),
      explicitHome,
      confirm: () => runtime.confirmImportLegacyHome(),
    })
  } catch (cause) {
    process.stderr.write(
      `${BIN_NAME}: failed to import existing Harness data: ${cause instanceof Error ? cause.message : String(cause)}\n`,
    )
    try {
      runtime.updates.notify({
        title: 'Unable to Import Data',
        body: 'WanCodeNewVer could not copy ~/.dsh and will start with a private data directory.',
      })
    } catch (notifyCause) {
      process.stderr.write(
        `${BIN_NAME}: failed to show import warning: ${notifyCause instanceof Error ? notifyCause.message : String(notifyCause)}\n`,
      )
    }
  }
  const windowsVolumeConcerns = diagnoseWindowsVolumes(process.platform, [
    { label: 'application install', path: process.execPath },
    { label: 'desktop user data', path: app.getPath('userData') },
    { label: 'DSH home', path: homeDir },
  ])
  warnWindowsVolumeConcerns(windowsVolumeConcerns)

  const failLoudProcess: FailLoudProcess = {
    on: (event, handler) => process.on(event, handler),
    off: (event, handler) => process.off(event, handler),
    stderr: process.stderr,
    exit: finalExit,
  }
  installFailLoud(BIN_NAME, failLoudProcess, async () => {
    try {
      await current?.fiber.dispose()
    } finally {
      disposeDshRuntime?.()
      disposePnpmRuntime?.()
    }
  })

  try {
    const environment = loadLayeredEnv(BIN_NAME, process.cwd())
    const electronVersion = process.versions.electron
    if (electronVersion === undefined) {
      throw new Error(`${BIN_NAME}: plugin runtime requires the Electron runtime version`)
    }
    const pnpmBinPath = packagedDependencyPath(import.meta.url, 'pnpm/bin/pnpm.mjs')
    const pnpmRuntime = installDesktopPnpmRuntime({
      platform: process.platform,
      appExecutable: process.execPath,
      pnpmBinPath,
      electronVersion,
      stateDir: join(app.getPath('userData'), 'runtime-commands'),
      environment: process.env,
    })
    const releasePnpmRuntime = (): void => { pnpmRuntime.dispose() }
    disposePnpmRuntime = releasePnpmRuntime
    const selectionStatePath = join(app.getPath('userData'), 'profile-selection', 'state.json')
    profileStatePath = selectionStatePath
    profileStartup = beginDesktopProfileStartup(selectionStatePath, homeDir)
    const activeProfileName = profileStartup.profileName
    const prepared = prepareDesktopProfile(
      process.env.DSH_TELEMETRY_DISABLED,
      homeDir,
      process.platform,
      activeProfileName,
    )
    const dshBootstrapPath = fileURLToPath(new URL('./desktop-cli.js', import.meta.url))
    const dshRuntime = process.platform === 'win32'
      ? installDesktopDshRuntime({
          platform: process.platform,
          appExecutable: process.execPath,
          dshBootstrapPath,
          profileName: activeProfileName,
          homeDir,
          stateDir: join(app.getPath('userData'), 'host-commands', activeProfileName),
          environment: process.env,
        })
      : undefined
    const releaseDshRuntime = (): void => { dshRuntime?.dispose() }
    disposeDshRuntime = releaseDshRuntime
    const desktopPnpmBootstrap: DesktopPnpmBootstrap = {
      activeProfileName,
      activeProfileDir: prepared.profile.dir,
      homeDir,
      appExecutable: process.execPath,
      pnpmBinPath,
      electronVersion,
      nodeBinDir: pnpmRuntime.nodeBinDir,
      nodeShimPath: pnpmRuntime.nodeShimPath,
      clearEnvironmentPath: pnpmRuntime.clearEnvironmentPath,
      dshBootstrapPath,
    }
    const releasePackageResolver = installProfilePackageResolver(prepared.bareModuleBaseUrl)
    startupWindow = openStartupStatusWindow()
    appendDesktopLog(
      app.getPath('userData'),
      `${BIN_NAME}: loading Host Cordis tree for profile ${activeProfileName}\n`,
    )
    const bootPulse = setInterval(() => {
      appendDesktopLog(app.getPath('userData'), `${BIN_NAME}: Host boot still running\n`)
    }, 5_000)
    const ctx = await boot(
      BIN_NAME,
      prepared.rootConfig,
      prepared.patches,
      async (hostCtx) => {
        hostCtx.effect(
          () => releasePnpmRuntime,
          'dsh-plugin-desktop: packaged pnpm runtime PATH',
        )
        if (dshRuntime !== undefined) {
          hostCtx.effect(
            () => releaseDshRuntime,
            'dsh-plugin-desktop: packaged dsh runtime PATH',
          )
        }
        current = hostCtx
        hostCtx.effect(
          () => releasePackageResolver,
          'dsh-plugin-desktop: profile package resolution',
        )
        hostCtx.provide(DSH_LAUNCH_ENVIRONMENT_KEY, environment)
        hostCtx.provide('desktopRuntime', runtime)
        hostCtx.provide('desktopPnpmBootstrap', desktopPnpmBootstrap)
        await hostCtx.plugin(DesktopProfileService, {
          current: {
            name: activeProfileName,
            dir: prepared.profile.dir,
          },
          list: () => listDesktopProfiles(homeDir),
          persistSelection: name => { selectDesktopProfile(selectionStatePath, homeDir, name) },
          requestRestart: () => runtime.requestRestart(),
        })
        provideCmdline(hostCtx, {
          args: ['--host', '127.0.0.1', '--port', '0'],
          exit: requestQuit,
        })
      },
      prepared.bareModuleBaseUrl,
    ).catch((cause: unknown) => {
      releasePackageResolver()
      throw cause
    }).finally(() => {
      clearInterval(bootPulse)
    })
    current = ctx
    runtime.configureTerminal({
      profileName: activeProfileName,
      profileDir: prepared.profile.dir,
      homeDir: prepared.homeDir,
    })
    appendDesktopLog(
      app.getPath('userData'),
      `${BIN_NAME}: Host Cordis tree is active with profile ${activeProfileName}\n`,
    )
    await runtime.mountScheduled()
    appendDesktopLog(app.getPath('userData'), `${BIN_NAME}: native window mounted\n`)
    runtime.show()
    closeStartupStatusWindow(startupWindow)
    startupWindow = undefined
    notifySkippedOptionalEntries(runtime, prepared.skippedOptionalEntries)
    notifyWindowsVolumeConcerns(runtime, windowsVolumeConcerns)
    if (profileStartup.rolledBackFrom !== undefined) {
      notifyProfileRecovery(
        runtime,
        `Reopened last-known-good profile ${activeProfileName}.`,
      )
    }
  } catch (cause) {
    closeStartupStatusWindow(startupWindow)
    process.stderr.write(`${BIN_NAME}: ${cause instanceof Error ? cause.stack ?? cause.message : String(cause)}\n`)
    await runtime.reportApplicationHealth('failed')
    if (runtime.hasRequestedQuit()) return
    let exitCode = 1
    if (profileStartup !== undefined && profileStatePath !== undefined) {
      const retryLastKnownGood = profileStartup.profileName !== profileStartup.state.lastKnownGood
      try {
        markDesktopProfileFailed(profileStatePath, profileStartup.profileName)
        if (retryLastKnownGood) {
          nativeExit.requestRelaunch()
          exitCode = 0
          notifyProfileRecovery(
            runtime,
            `Reopening last-known-good profile ${profileStartup.state.lastKnownGood}.`,
          )
        }
      } catch (stateCause) {
        process.stderr.write(`${BIN_NAME}: failed to roll back desktop profile state: ${stateCause instanceof Error ? stateCause.message : String(stateCause)}\n`)
      }
    }
    await shutdown.request(exitCode)
  }
}

void start()
