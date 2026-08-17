import { describe, expect, it } from 'vitest'
import { assertWindowsReleaseReady } from '../scripts/release-win.ts'

describe('Windows release preflight', () => {
  it('accepts one complete certificate source and publisher pin', () => {
    expect(assertWindowsReleaseReady({
      CSC_LINK: 'D:\\secrets\\wancode.pfx',
      CSC_KEY_PASSWORD: 'secret',
      WANCODE_WINDOWS_PUBLISHER: 'Wancode Software',
    }, 'win32', 'x64')).toEqual({
      publisher: 'Wancode Software',
      signing: 'csc',
    })
    expect(assertWindowsReleaseReady({
      WIN_CSC_LINK: 'D:\\secrets\\wancode.pfx',
      WIN_CSC_KEY_PASSWORD: 'secret',
      WANCODE_WINDOWS_PUBLISHER: 'Wancode Software',
    }, 'win32', 'x64')).toEqual({
      publisher: 'Wancode Software',
      signing: 'win-csc',
    })
  })

  it('fails closed for the wrong host or incomplete and disabled signing', () => {
    const complete = {
      CSC_LINK: 'certificate',
      CSC_KEY_PASSWORD: 'secret',
      WANCODE_WINDOWS_PUBLISHER: 'Wancode',
    }
    expect(() => assertWindowsReleaseReady(complete, 'linux', 'x64')).toThrow('native Windows')
    expect(() => assertWindowsReleaseReady(complete, 'win32', 'arm64')).toThrow('x64')
    expect(() => assertWindowsReleaseReady({
      CSC_LINK: 'certificate',
      WANCODE_WINDOWS_PUBLISHER: 'Wancode',
    }, 'win32', 'x64')).toThrow('CSC_KEY_PASSWORD')
    expect(() => assertWindowsReleaseReady({
      ...complete,
      CSC_IDENTITY_AUTO_DISCOVERY: 'false',
    }, 'win32', 'x64')).toThrow('disable')
  })

  it('rejects ambiguous certificate sources and a missing publisher pin', () => {
    expect(() => assertWindowsReleaseReady({
      CSC_LINK: 'one',
      CSC_KEY_PASSWORD: 'secret',
      WIN_CSC_LINK: 'two',
      WIN_CSC_KEY_PASSWORD: 'secret',
      WANCODE_WINDOWS_PUBLISHER: 'Wancode',
    }, 'win32', 'x64')).toThrow('one Windows certificate source')
    expect(() => assertWindowsReleaseReady({
      CSC_LINK: 'one',
      CSC_KEY_PASSWORD: 'secret',
    }, 'win32', 'x64')).toThrow('WANCODE_WINDOWS_PUBLISHER')
  })
})
