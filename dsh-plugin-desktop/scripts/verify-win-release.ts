/** Fail-loud Authenticode verification for a signed Windows release pair. */

import { dirname, resolve } from 'node:path'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import {
  verifyWindowsAuthenticode,
  type AuthenticodeProbeResult,
} from '../src/windows-signature.ts'
import {
  verifyWindowsInstaller,
  type WindowsInstallerArtifacts,
} from './verify-win-installer.ts'

/** Injectable release verification inputs. */
export interface SignedWindowsReleaseOptions {
  readonly platform: NodeJS.Platform
  readonly expectedPublisher: string
  readonly artifacts: WindowsInstallerArtifacts
  readonly verifyAuthenticode: (filename: string) => Promise<AuthenticodeProbeResult>
}

/** Non-secret signing identity confirmed for both release artifacts. */
export interface SignedWindowsReleaseResult {
  readonly publisher: string
  readonly thumbprint: string
}

/** Require both binaries to be trusted, publisher-matched, and signed by one certificate. */
export async function verifySignedWindowsRelease(
  options: SignedWindowsReleaseOptions,
): Promise<SignedWindowsReleaseResult> {
  if (options.platform !== 'win32') {
    throw new Error('Signed Windows release verification must run on native Windows')
  }
  const publisher = options.expectedPublisher.trim()
  if (publisher.length === 0) {
    throw new Error('WANCODE_WINDOWS_PUBLISHER is required for signed release verification')
  }

  const installer = await options.verifyAuthenticode(options.artifacts.installerPath)
  const application = await options.verifyAuthenticode(options.artifacts.applicationPath)
  for (const result of [installer, application]) {
    if (!result.subject.toLowerCase().includes(publisher.toLowerCase())) {
      throw new Error(`Authenticode signer does not match the expected publisher: ${publisher}`)
    }
  }
  if (installer.thumbprint !== application.thumbprint) {
    throw new Error('The installer and application must be signed by the same certificate')
  }
  return {
    publisher: installer.subject,
    thumbprint: installer.thumbprint,
  }
}

async function main(): Promise<void> {
  try {
    const desktopRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
    const result = await verifySignedWindowsRelease({
      platform: process.platform,
      expectedPublisher: process.env.WANCODE_WINDOWS_PUBLISHER ?? '',
      artifacts: verifyWindowsInstaller({ desktopRoot, version: desktopVersion(desktopRoot) }),
      verifyAuthenticode: filename => verifyWindowsAuthenticode(filename),
    })
    console.log(`Signed Windows release verification passed: ${result.publisher}; ${result.thumbprint}`)
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  }
}

function desktopVersion(desktopRoot: string): string {
  const manifest = JSON.parse(readFileSync(resolve(desktopRoot, 'package.json'), 'utf8')) as {
    version?: unknown
  }
  if (typeof manifest.version !== 'string' || manifest.version.length === 0) {
    throw new Error('Desktop package has no valid release version')
  }
  return manifest.version
}

const invokedPath = process.argv[1]
if (invokedPath !== undefined && resolve(invokedPath) === fileURLToPath(import.meta.url)) {
  await main()
}
