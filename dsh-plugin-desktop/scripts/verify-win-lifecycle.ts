/** Native Windows install, upgrade, rollback, restore, and uninstall gate. */

import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { extractFile } from '@electron/asar'
import { compareSemVerVersions, parseSemVer } from '../src/update-checker.ts'
import {
  verifyWindowsAuthenticode,
  type AuthenticodeProbeResult,
} from '../src/windows-signature.ts'
import { verifyWindowsInstaller } from './verify-win-installer.ts'

/** One versioned NSIS installer participating in the lifecycle. */
export interface WindowsLifecycleInstaller {
  readonly version: string
  readonly installerPath: string
}

/** Native operations kept outside the lifecycle state machine. */
export interface WindowsInstallerLifecycleHost {
  verifyInstaller(installerPath: string): Promise<void>
  install(installerPath: string, installDirectory: string): Promise<void>
  installedVersion(installDirectory: string): Promise<string | undefined>
  uninstall(installDirectory: string): Promise<void>
  assertUninstalled(installDirectory: string): Promise<void>
}

/** Inputs for one isolated Windows lifecycle verification. */
export interface WindowsInstallerLifecycleOptions {
  readonly platform: NodeJS.Platform
  readonly installDirectory: string
  readonly current: WindowsLifecycleInstaller
  readonly previous: WindowsLifecycleInstaller
  readonly host: WindowsInstallerLifecycleHost
}

/** Version transitions proven by the lifecycle gate. */
export interface WindowsInstallerLifecycleResult {
  readonly installed: string
  readonly upgraded: string
  readonly rolledBack: string
  readonly restored: string
  readonly uninstalled: true
}

/** Explicit release-runner inputs required before touching Windows installer state. */
export interface WindowsLifecyclePreflightResult {
  readonly expectedPublisher: string
  readonly trustedThumbprints: readonly string[]
  readonly previous: WindowsLifecycleInstaller
}

function environmentValue(
  environment: NodeJS.ProcessEnv,
  name: string,
): string | undefined {
  const candidate = environment[name]?.trim()
  return candidate === '' ? undefined : candidate
}

/** Require a disposable runner and an explicit previous release rollback target. */
export function assertWindowsLifecycleReady(
  environment: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
): WindowsLifecyclePreflightResult {
  if (platform !== 'win32') {
    throw new Error('Windows installer lifecycle verification must run on native Windows')
  }
  if (environmentValue(environment, 'WANCODE_WINDOWS_LIFECYCLE_DISPOSABLE') !== '1') {
    throw new Error(
      'WANCODE_WINDOWS_LIFECYCLE_DISPOSABLE=1 is required because the lifecycle gate modifies installer registry state',
    )
  }
  const expectedPublisher = environmentValue(environment, 'WANCODE_WINDOWS_PUBLISHER')
  if (expectedPublisher === undefined) {
    throw new Error('WANCODE_WINDOWS_PUBLISHER is required for lifecycle signature verification')
  }
  const thumbprints = environmentValue(environment, 'WANCODE_WINDOWS_TRUSTED_THUMBPRINTS')
    ?.split(',')
    .map(value => value.trim().toUpperCase())
    .filter(value => value.length > 0)
  if (thumbprints === undefined
    || thumbprints.length === 0
    || thumbprints.some(value => !/^[A-F0-9]{40}$/u.test(value))) {
    throw new Error(
      'WANCODE_WINDOWS_TRUSTED_THUMBPRINTS must contain comma-separated SHA-1 certificate thumbprints',
    )
  }
  const installerPath = environmentValue(environment, 'WANCODE_PREVIOUS_WINDOWS_INSTALLER')
  const version = environmentValue(environment, 'WANCODE_PREVIOUS_WINDOWS_VERSION')
  if (installerPath === undefined || version === undefined) {
    throw new Error(
      'WANCODE_PREVIOUS_WINDOWS_INSTALLER and WANCODE_PREVIOUS_WINDOWS_VERSION are required for rollback verification',
    )
  }
  const parsedVersion = parseSemVer(version)
  if (parsedVersion === null || parsedVersion.version !== version) {
    throw new Error('WANCODE_PREVIOUS_WINDOWS_VERSION must be canonical Semantic Versioning')
  }
  return {
    expectedPublisher,
    trustedThumbprints: [...new Set(thumbprints)],
    previous: {
      installerPath: resolve(installerPath),
      version,
    },
  }
}

/**
 * Verify the complete version transition sequence through native installer interfaces.
 * The host is responsible for signature checks and isolated filesystem operations.
 */
export async function verifyWindowsInstallerLifecycle(
  options: WindowsInstallerLifecycleOptions,
): Promise<WindowsInstallerLifecycleResult> {
  if (options.platform !== 'win32') {
    throw new Error('Windows installer lifecycle verification must run on native Windows')
  }
  if (options.installDirectory.trim().length === 0) {
    throw new Error('Windows installer lifecycle verification requires an isolated install directory')
  }
  if (resolve(options.previous.installerPath).toLowerCase()
    === resolve(options.current.installerPath).toLowerCase()) {
    throw new Error('The previous and current Windows installers must be different files')
  }
  const precedence = compareSemVerVersions(options.previous.version, options.current.version)
  if (precedence === null || precedence >= 0) {
    throw new Error('The previous Windows installer version must be valid and older than the current version')
  }

  await options.host.verifyInstaller(options.current.installerPath)
  await options.host.verifyInstaller(options.previous.installerPath)

  let cleanupRequired = false
  try {
    const installAndAssert = async (installer: WindowsLifecycleInstaller): Promise<string> => {
      cleanupRequired = true
      await options.host.install(installer.installerPath, options.installDirectory)
      const installed = await options.host.installedVersion(options.installDirectory)
      if (installed !== installer.version) {
        throw new Error(
          `Windows installer lifecycle expected ${installer.version} but found ${installed ?? 'no installed application'}`,
        )
      }
      return installed
    }

    const installed = await installAndAssert(options.previous)
    const upgraded = await installAndAssert(options.current)
    const rolledBack = await installAndAssert(options.previous)
    const restored = await installAndAssert(options.current)
    await options.host.uninstall(options.installDirectory)
    await options.host.assertUninstalled(options.installDirectory)
    cleanupRequired = false
    return { installed, upgraded, rolledBack, restored, uninstalled: true }
  } finally {
    if (cleanupRequired) {
      await options.host.uninstall(options.installDirectory).catch(() => undefined)
    }
  }
}

interface NativeLifecycleHostOptions {
  readonly expectedPublisher: string
  readonly trustedThumbprints: readonly string[]
  readonly environment: NodeJS.ProcessEnv
  readonly verifyAuthenticode?: (
    filename: string,
    environment?: NodeJS.ProcessEnv,
  ) => Promise<AuthenticodeProbeResult>
}

/** Build the production adapter used only by the explicit lifecycle script. */
export function createNativeWindowsLifecycleHost(
  options: NativeLifecycleHostOptions,
): WindowsInstallerLifecycleHost {
  const expectedPublisher = options.expectedPublisher.toLowerCase()
  const trustedThumbprints = new Set(
    options.trustedThumbprints.map(value => value.toUpperCase()),
  )
  const verifyAuthenticode = options.verifyAuthenticode ?? verifyWindowsAuthenticode

  const assertTrustedPublisher = async (filename: string): Promise<void> => {
    const signature = await verifyAuthenticode(filename, options.environment)
    if (!trustedThumbprints.has(signature.thumbprint.toUpperCase())) {
      throw new Error('Authenticode signer is not an approved lifecycle certificate')
    }
    if (!signature.subject.toLowerCase().includes(expectedPublisher)) {
      throw new Error(
        `Authenticode signer does not match the expected lifecycle publisher: ${options.expectedPublisher}`,
      )
    }
  }
  const run = (executable: string, args: readonly string[]): void => {
    const result = spawnSync(executable, [...args], {
      env: options.environment,
      stdio: 'inherit',
      windowsHide: true,
    })
    if (result.error !== undefined) throw result.error
    if (result.status !== 0) {
      throw new Error(`${executable} exited with ${String(result.status)}`)
    }
  }
  const paths = (installDirectory: string) => ({
    application: join(installDirectory, 'Wan Code.exe'),
    archive: join(installDirectory, 'resources', 'app.asar'),
    uninstaller: join(installDirectory, 'Uninstall Wan Code.exe'),
  })
  const registryExecutable = join(
    options.environment.SystemRoot ?? options.environment.WINDIR ?? 'C:\\Windows',
    'System32',
    'reg.exe',
  )
  const powershellExecutable = join(
    options.environment.SystemRoot ?? options.environment.WINDIR ?? 'C:\\Windows',
    'System32',
    'WindowsPowerShell',
    'v1.0',
    'powershell.exe',
  )

  return {
    verifyInstaller: assertTrustedPublisher,
    async install(installerPath, installDirectory) {
      run(installerPath, ['/S', '/currentuser', `/D=${installDirectory}`])
    },
    async installedVersion(installDirectory) {
      const installed = paths(installDirectory)
      if (!existsSync(installed.application)) return undefined
      if (!existsSync(installed.archive)) {
        throw new Error(`Installed Wan Code archive is missing: ${installed.archive}`)
      }
      await assertTrustedPublisher(installed.application)
      const manifest = JSON.parse(
        extractFile(installed.archive, 'package.json').toString('utf8'),
      ) as { version?: unknown }
      if (typeof manifest.version !== 'string' || manifest.version.length === 0) {
        throw new Error(`Installed Wan Code archive has no valid version: ${installed.archive}`)
      }
      return manifest.version
    },
    async uninstall(installDirectory) {
      const installed = paths(installDirectory)
      if (!existsSync(installed.uninstaller)) return
      await assertTrustedPublisher(installed.uninstaller)
      run(installed.uninstaller, ['/S', '/currentuser'])
    },
    async assertUninstalled(installDirectory) {
      const knownFolders = spawnSync(
        powershellExecutable,
        [
          '-NoLogo',
          '-NoProfile',
          '-NonInteractive',
          '-Command',
          "[Environment]::GetFolderPath('Desktop'); [Environment]::GetFolderPath('Programs')",
        ],
        {
          encoding: 'utf8',
          env: options.environment,
          windowsHide: true,
        },
      )
      if (knownFolders.error !== undefined) throw knownFolders.error
      if (knownFolders.status !== 0) {
        throw new Error('Windows known-folder resolution failed during uninstall verification')
      }
      const shortcutCandidates = knownFolders.stdout
        .split(/\r?\n/u)
        .map(value => value.trim())
        .filter(value => value.length > 0)
        .map(folder => join(folder, 'Wan Code.lnk'))
      const registryRoots = ['HKCU\\Software', 'HKLM\\Software']
      const deadline = Date.now() + 15_000
      let remainingShortcut: string | undefined
      let remainingRegistryRoot: string | undefined
      do {
        remainingShortcut = shortcutCandidates.find(candidate => existsSync(candidate))
        remainingRegistryRoot = undefined
        if (!existsSync(installDirectory) && remainingShortcut === undefined) {
          for (const root of registryRoots) {
            const result = spawnSync(
              registryExecutable,
              ['query', root, '/s', '/f', installDirectory, '/d'],
              {
                encoding: 'utf8',
                env: options.environment,
                windowsHide: true,
              },
            )
            if (result.error !== undefined) throw result.error
            if (result.status === 0) {
              remainingRegistryRoot = root
              break
            }
            if (result.status !== 1) {
              throw new Error(`Registry cleanup verification failed under ${root}`)
            }
          }
        }
        if (!existsSync(installDirectory)
          && remainingShortcut === undefined
          && remainingRegistryRoot === undefined) {
          return
        }
        await new Promise(resolvePromise => setTimeout(resolvePromise, 100))
      } while (Date.now() < deadline)

      if (existsSync(installDirectory)) {
        throw new Error(`Wan Code install directory remains after uninstall: ${installDirectory}`)
      }
      if (remainingShortcut !== undefined) {
        throw new Error(`Wan Code shortcut remains after uninstall: ${remainingShortcut}`)
      }
      if (remainingRegistryRoot !== undefined) {
        throw new Error(`Wan Code installer registry state remains under ${remainingRegistryRoot}`)
      }
    },
  }
}

function desktopVersion(desktopRoot: string): string {
  const manifest = JSON.parse(readFileSync(join(desktopRoot, 'package.json'), 'utf8')) as {
    version?: unknown
  }
  if (typeof manifest.version !== 'string' || manifest.version.length === 0) {
    throw new Error('Desktop package has no valid lifecycle version')
  }
  return manifest.version
}

async function main(): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), 'wan-code-lifecycle-'))
  try {
    const preflight = assertWindowsLifecycleReady(process.env, process.platform)
    const desktopRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
    const version = desktopVersion(desktopRoot)
    const artifacts = verifyWindowsInstaller({ desktopRoot, version })
    const result = await verifyWindowsInstallerLifecycle({
      platform: process.platform,
      installDirectory: join(root, 'Wan Code'),
      current: {
        version,
        installerPath: artifacts.installerPath,
      },
      previous: preflight.previous,
      host: createNativeWindowsLifecycleHost({
        expectedPublisher: preflight.expectedPublisher,
        trustedThumbprints: preflight.trustedThumbprints,
        environment: process.env,
      }),
    })
    console.log(`Windows installer lifecycle verification passed: ${JSON.stringify(result)}`)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

const invokedPath = process.argv[1]
if (invokedPath !== undefined && resolve(invokedPath) === fileURLToPath(import.meta.url)) {
  try {
    await main()
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  }
}
