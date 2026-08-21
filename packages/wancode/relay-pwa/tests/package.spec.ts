import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import * as pwa from '../src/index.ts'

const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
  name?: unknown
  dsh?: unknown
  packageManager?: unknown
  dependencies?: Record<string, unknown>
  exports?: Record<string, unknown>
  files?: unknown
}

describe('relay-pwa package surface', () => {
  it('is an owned Wan Code module without a loadable DSH entry or public listener', () => {
    expect(manifest.name).toBe('@wancode/relay-pwa')
    expect(manifest.dsh).toBeUndefined()
    expect(manifest.packageManager).toBeUndefined()
    expect(manifest.files).toEqual([
      'src/**',
      'public/**',
      'README.md',
      'README.zh.md',
    ])
    expect(manifest.exports).toEqual({
      '.': {
        types: './src/index.ts',
        default: './src/index.ts',
      },
      './host': {
        types: './src/host.ts',
        default: './src/host.ts',
      },
    })
    expect(pwa).toHaveProperty('projectRelaySessionView')
    expect(pwa).toHaveProperty('projectRelayNotification')
    expect(pwa).toHaveProperty('assertPwaProgressDetail')
    expect(pwa).toHaveProperty('assertPwaSessionId')
    expect(pwa).toHaveProperty('assertPwaRequestId')
    expect(pwa).toHaveProperty('assertPwaPresenceState')
    expect(pwa).toHaveProperty('MAX_PWA_PROGRESS_DETAIL_CHARS')
    expect(pwa).toHaveProperty('createPwaRelayController')
    expect(pwa).toHaveProperty('loadPwaRelayIdentity')
    expect(pwa).toHaveProperty('peekPwaRelayPublicIdentity')
    expect(pwa).toHaveProperty('resolvePwaRelayIdentity')
    expect(pwa).toHaveProperty('enrollPwaPairingShell')
    expect(pwa).toHaveProperty('bindPwaRelayIdentityStorage')
    expect(pwa).toHaveProperty('bindPwaRelayAsyncIdentityStorage')
    expect(pwa).toHaveProperty('openPwaRelayIdentityIndexedDb')
    expect(pwa).toHaveProperty('assertPwaDesktopSelection')
    expect(pwa).toHaveProperty('isSelectablePwaDesktop')
    expect(pwa).toHaveProperty('createPwaSessionBoard')
    expect(pwa).toHaveProperty('createPwaWebManifest')
    expect(pwa).toHaveProperty('createPwaIndexHtml')
    expect(pwa).toHaveProperty('createPwaShellFiles')
    expect(pwa).toHaveProperty('createPwaDeployFiles')
    expect(pwa).toHaveProperty('createPwaShellIcon')
    expect(pwa).toHaveProperty('createPwaShellIcons')
    expect(pwa).toHaveProperty('createPwaServiceWorkerSource')
    expect(pwa).toHaveProperty('createPwaPairingScriptSource')
    expect(pwa).toHaveProperty('PWA_SHELL_CSP')
    expect(pwa).toHaveProperty('decidePwaCacheAction')
    expect(pwa).toHaveProperty('decidePwaCacheRetention')
    expect(pwa).toHaveProperty('assertPwaShellOrigin')
    expect(pwa).not.toHaveProperty('startPwaShellHost')
    expect(pwa).not.toHaveProperty('startRelayCloud')
    expect(pwa).not.toHaveProperty('startLoopbackRelay')
    expect(pwa).not.toHaveProperty('listen')
    expect(pwa).not.toHaveProperty('createServer')
  })
})
