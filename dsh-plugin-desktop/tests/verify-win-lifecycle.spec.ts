import { describe, expect, it, vi } from 'vitest'
import {
  assertWindowsLifecycleReady,
  createNativeWindowsLifecycleHost,
  verifyWindowsInstallerLifecycle,
  type WindowsInstallerLifecycleHost,
} from '../scripts/verify-win-lifecycle.ts'

function lifecycleHost(): WindowsInstallerLifecycleHost & {
  readonly events: string[]
} {
  const events: string[] = []
  let installedVersion: string | undefined
  return {
    events,
    verifyInstaller: vi.fn(async (installer) => {
      events.push(`verify:${installer}`)
    }),
    install: vi.fn(async (installer, _directory) => {
      installedVersion = installer.includes('2.0.0') ? '2.0.0' : '2.1.0'
      events.push(`install:${installedVersion}`)
    }),
    installedVersion: vi.fn(async () => installedVersion),
    uninstall: vi.fn(async () => {
      events.push('uninstall')
      installedVersion = undefined
    }),
    assertUninstalled: vi.fn(async () => {
      events.push('assert-uninstalled')
    }),
  }
}

describe('Windows installer lifecycle verification', () => {
  it('requires an explicitly disposable runner and complete rollback inputs', () => {
    const complete = {
      WANCODE_WINDOWS_LIFECYCLE_DISPOSABLE: '1',
      WANCODE_WINDOWS_PUBLISHER: 'WanCodeNewVer Software',
      WANCODE_WINDOWS_TRUSTED_THUMBPRINTS: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
      WANCODE_PREVIOUS_WINDOWS_INSTALLER: 'D:\\previous\\WanCodeNewVer-2.0.0-x64-Setup.exe',
      WANCODE_PREVIOUS_WINDOWS_VERSION: '2.0.0',
    }

    expect(assertWindowsLifecycleReady(complete, 'win32')).toEqual({
      expectedPublisher: 'WanCodeNewVer Software',
      trustedThumbprints: ['AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'],
      previous: {
        installerPath: 'D:\\previous\\WanCodeNewVer-2.0.0-x64-Setup.exe',
        version: '2.0.0',
      },
    })
    expect(() => assertWindowsLifecycleReady({
      ...complete,
      WANCODE_WINDOWS_LIFECYCLE_DISPOSABLE: undefined,
    }, 'win32')).toThrow('modifies installer registry state')
    expect(() => assertWindowsLifecycleReady({
      ...complete,
      WANCODE_PREVIOUS_WINDOWS_VERSION: undefined,
    }, 'win32')).toThrow('required for rollback')
    expect(() => assertWindowsLifecycleReady({
      ...complete,
      WANCODE_PREVIOUS_WINDOWS_VERSION: 'v2.0',
    }, 'win32')).toThrow('canonical Semantic Versioning')
    expect(() => assertWindowsLifecycleReady({
      ...complete,
      WANCODE_WINDOWS_TRUSTED_THUMBPRINTS: 'not-a-thumbprint',
    }, 'win32')).toThrow('SHA-1 certificate thumbprints')
  })

  it('pins every native lifecycle signature to the expected publisher', async () => {
    const verifyAuthenticode = vi.fn(async () => ({
      subject: 'CN=WanCodeNewVer Software',
      thumbprint: 'BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB',
    }))
    const host = createNativeWindowsLifecycleHost({
      expectedPublisher: 'WanCodeNewVer Software',
      trustedThumbprints: ['AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'],
      environment: {},
      verifyAuthenticode,
    })

    await expect(host.verifyInstaller('D:\\dist\\setup.exe'))
      .rejects.toThrow('approved lifecycle certificate')
    expect(verifyAuthenticode).toHaveBeenCalledWith('D:\\dist\\setup.exe', {})
  })

  it('proves upgrade, rollback, restore, and uninstall in order', async () => {
    const host = lifecycleHost()

    await expect(verifyWindowsInstallerLifecycle({
      platform: 'win32',
      installDirectory: 'D:\\isolated\\WanCodeNewVer',
      current: {
        version: '2.1.0',
        installerPath: 'D:\\dist\\WanCodeNewVer-2.1.0-x64-Setup.exe',
      },
      previous: {
        version: '2.0.0',
        installerPath: 'D:\\previous\\WanCodeNewVer-2.0.0-x64-Setup.exe',
      },
      host,
    })).resolves.toEqual({
      installed: '2.0.0',
      upgraded: '2.1.0',
      rolledBack: '2.0.0',
      restored: '2.1.0',
      uninstalled: true,
    })

    expect(host.events).toEqual([
      'verify:D:\\dist\\WanCodeNewVer-2.1.0-x64-Setup.exe',
      'verify:D:\\previous\\WanCodeNewVer-2.0.0-x64-Setup.exe',
      'install:2.0.0',
      'install:2.1.0',
      'install:2.0.0',
      'install:2.1.0',
      'uninstall',
      'assert-uninstalled',
    ])
  })

  it('attempts cleanup when a version transition fails', async () => {
    const host = lifecycleHost()
    vi.mocked(host.installedVersion)
      .mockResolvedValueOnce('2.0.0')
      .mockResolvedValueOnce('unexpected')
      .mockResolvedValueOnce(undefined)

    await expect(verifyWindowsInstallerLifecycle({
      platform: 'win32',
      installDirectory: 'D:\\isolated\\WanCodeNewVer',
      current: {
        version: '2.1.0',
        installerPath: 'D:\\dist\\WanCodeNewVer-2.1.0-x64-Setup.exe',
      },
      previous: {
        version: '2.0.0',
        installerPath: 'D:\\previous\\WanCodeNewVer-2.0.0-x64-Setup.exe',
      },
      host,
    })).rejects.toThrow('expected 2.1.0 but found unexpected')

    expect(host.uninstall).toHaveBeenCalledOnce()
  })

  it('rejects unsafe lifecycle inputs before touching an installer', async () => {
    const host = lifecycleHost()
    const base = {
      platform: 'win32' as NodeJS.Platform,
      installDirectory: 'D:\\isolated\\WanCodeNewVer',
      current: {
        version: '2.1.0',
        installerPath: 'D:\\dist\\WanCodeNewVer-2.1.0-x64-Setup.exe',
      },
      previous: {
        version: '2.0.0',
        installerPath: 'D:\\previous\\WanCodeNewVer-2.0.0-x64-Setup.exe',
      },
      host,
    }

    await expect(verifyWindowsInstallerLifecycle({
      ...base,
      platform: 'linux',
    })).rejects.toThrow('native Windows')
    await expect(verifyWindowsInstallerLifecycle({
      ...base,
      previous: { ...base.previous, version: '2.2.0' },
    })).rejects.toThrow('older than the current version')
    await expect(verifyWindowsInstallerLifecycle({
      ...base,
      previous: { ...base.previous, installerPath: base.current.installerPath },
    })).rejects.toThrow('must be different files')
    expect(host.verifyInstaller).not.toHaveBeenCalled()
  })
})
