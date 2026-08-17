/** Build and verify one signed Wancode Windows x64 NSIS release. */

import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { withoutWindowsSigningSecrets } from './package-win.ts'

type WindowsSigningSource = 'csc' | 'win-csc'

/** Non-secret signing selections established before any build starts. */
export interface WindowsReleasePreflightResult {
  readonly publisher: string
  readonly signing: WindowsSigningSource
}

function value(env: NodeJS.ProcessEnv, name: string): string | undefined {
  const candidate = env[name]?.trim()
  return candidate === '' ? undefined : candidate
}

/** Reject unsigned, ambiguous, or unpinned Windows release configuration. */
export function assertWindowsReleaseReady(
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
  arch: string,
): WindowsReleasePreflightResult {
  if (platform !== 'win32') throw new Error('Signed Windows releases must be built on native Windows')
  if (arch !== 'x64') throw new Error(`Signed Windows releases require x64 Node; received ${arch}`)
  if (value(env, 'CSC_IDENTITY_AUTO_DISCOVERY') === 'false') {
    throw new Error('CSC_IDENTITY_AUTO_DISCOVERY=false would disable Windows release signing')
  }

  const cscLink = value(env, 'CSC_LINK')
  const winLink = value(env, 'WIN_CSC_LINK')
  if (cscLink !== undefined && winLink !== undefined) {
    throw new Error('Configure exactly one Windows certificate source: CSC_LINK or WIN_CSC_LINK')
  }
  let signing: WindowsSigningSource
  if (cscLink !== undefined) {
    if (value(env, 'CSC_KEY_PASSWORD') === undefined) {
      throw new Error('CSC_KEY_PASSWORD is required when CSC_LINK supplies the Windows certificate')
    }
    signing = 'csc'
  } else if (winLink !== undefined) {
    if (value(env, 'WIN_CSC_KEY_PASSWORD') === undefined) {
      throw new Error('WIN_CSC_KEY_PASSWORD is required when WIN_CSC_LINK supplies the Windows certificate')
    }
    signing = 'win-csc'
  } else {
    throw new Error('A Windows signing certificate is required through CSC_LINK or WIN_CSC_LINK')
  }
  const publisher = value(env, 'WANCODE_WINDOWS_PUBLISHER')
  if (publisher === undefined) {
    throw new Error('WANCODE_WINDOWS_PUBLISHER is required to pin the signed release publisher')
  }
  return { publisher, signing }
}

function run(command: string, args: readonly string[], cwd: string, env: NodeJS.ProcessEnv): void {
  const result = spawnSync(command, [...args], { cwd, env, stdio: 'inherit' })
  if (result.error !== undefined) throw result.error
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(' ')} exited with ${String(result.status)}`)
  }
}

function main(): void {
  try {
    const result = assertWindowsReleaseReady(process.env, process.platform, process.arch)
    const desktopRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
    const workspaceRoot = resolve(desktopRoot, '..')
    const require = createRequire(import.meta.url)
    const windowsRoot = process.env.SystemRoot ?? process.env.WINDIR
    const commandShell = windowsRoot === undefined
      ? 'cmd.exe'
      : join(windowsRoot, 'System32', 'cmd.exe')
    const safeEnvironment = withoutWindowsSigningSecrets(process.env)
    delete safeEnvironment.WANCODE_WINDOWS_PUBLISHER

    console.log(`Windows release preflight passed: publisher ${result.publisher}; signing via ${result.signing}`)
    run(
      commandShell,
      ['/d', '/s', '/c', 'corepack yarn workspace dsh-plugin-desktop check:win-package'],
      workspaceRoot,
      safeEnvironment,
    )
    run(
      process.execPath,
      [
        require.resolve('electron-builder/cli.js'),
        '--win',
        'nsis',
        '--x64',
        '--publish',
        'never',
        '--config.npmRebuild=false',
      ],
      desktopRoot,
      process.env,
    )
    run(
      process.execPath,
      [fileURLToPath(new URL('./verify-win-release.ts', import.meta.url))],
      desktopRoot,
      process.env,
    )
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  }
}

const invokedPath = process.argv[1]
if (invokedPath !== undefined && resolve(invokedPath) === fileURLToPath(import.meta.url)) main()
