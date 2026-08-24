import { readFileSync } from 'node:fs'
import { describe, expect, it, vi } from 'vitest'
import {
  verifySignedWindowsRelease,
  type SignedWindowsReleaseOptions,
} from '../scripts/verify-win-release.ts'

const PRODUCT_VERSION = (JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version: string }).version

function options(
  verify: SignedWindowsReleaseOptions['verifyAuthenticode'],
  publisher = 'Wancode Software',
): SignedWindowsReleaseOptions {
  return {
    platform: 'win32',
    expectedPublisher: publisher,
    artifacts: {
      installerPath: `D:\\dist\\WanCodeNewVer-${PRODUCT_VERSION}-x64-Setup.exe`,
      applicationPath: 'D:\\dist\\win-unpacked\\WanCodeNewVer.exe',
    },
    verifyAuthenticode: verify,
  }
}

describe('signed Windows release verification', () => {
  it('requires the installer and application to share the expected publisher', async () => {
    const verify = vi.fn(async () => ({
      subject: 'CN=Wancode Software LLC, O=Wancode Software LLC',
      thumbprint: 'AABBCC',
    }))

    const result = await verifySignedWindowsRelease(options(verify))

    expect(verify).toHaveBeenCalledTimes(2)
    expect(result.publisher).toContain('Wancode Software')
    expect(result.thumbprint).toBe('AABBCC')
  })

  it('rejects platform, publisher, thumbprint, or certificate mismatches', async () => {
    await expect(verifySignedWindowsRelease({
      ...options(async () => ({ subject: 'CN=Wancode Software', thumbprint: 'AA' })),
      platform: 'linux',
    })).rejects.toThrow('native Windows')
    await expect(verifySignedWindowsRelease(options(
      async () => ({ subject: 'CN=Other Publisher', thumbprint: 'AA' }),
    ))).rejects.toThrow('expected publisher')
    await expect(verifySignedWindowsRelease(options(
      async path => path.includes('Setup')
        ? { subject: 'CN=Wancode Software', thumbprint: 'AA' }
        : { subject: 'CN=Wancode Software', thumbprint: 'BB' },
    ))).rejects.toThrow('same certificate')
  })
})
