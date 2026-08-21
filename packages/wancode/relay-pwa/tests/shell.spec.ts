import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { RelayAuthorizationError } from '../../relay-protocol/src/index.ts'
import {
  createPwaIndexHtml,
  createPwaPairingScriptSource,
  createPwaServiceWorkerSource,
  createPwaShellFiles,
  createPwaDeployFiles,
  createPwaShellIcon,
  createPwaShellIcons,
  createPwaWebManifest,
  decidePwaCacheAction,
  decidePwaCacheRetention,
  assertPwaShellOrigin,
  PWA_SHELL_CACHE,
  PWA_SHELL_CSP,
  PWA_SHELL_PATHS,
} from '../src/index.ts'

function expectRelayError(run: () => unknown, code: string): void {
  try {
    run()
    expect.unreachable('expected a relay authorization error')
  } catch (cause) {
    expect(cause).toBeInstanceOf(RelayAuthorizationError)
    expect((cause as RelayAuthorizationError).code).toBe(code)
  }
}

describe('PWA installable shell', () => {
  it('publishes a standalone manifest with relative start_url and no secrets', () => {
    const manifest = createPwaWebManifest()
    expect(manifest.display).toBe('standalone')
    expect(manifest.id).toBe('./')
    expect(manifest.lang).toBe('en')
    expect(manifest.prefer_related_applications).toBe(false)
    expect(manifest.start_url).toBe('./')
    expect(manifest.scope).toBe('./')
    expect(manifest.name).toBe('Wan Code')
    expect(JSON.stringify(manifest)).not.toMatch(/token|secret|credential|password|authorization/i)
    expect(PWA_SHELL_CACHE).toBe('wancode-pwa-shell-v13')
    expect(PWA_SHELL_CSP).toContain("script-src 'self'")
    expect(PWA_SHELL_CSP).toContain("object-src 'none'")
    expect(PWA_SHELL_CSP).toContain("frame-ancestors 'none'")
    expect(PWA_SHELL_CSP).not.toContain('unsafe-inline')
    expect(PWA_SHELL_PATHS).toContain('/manifest.webmanifest')
    expect(PWA_SHELL_PATHS).toContain('/pair.js')
  })

  it('caches only shell GET assets and never stores control-plane tokens', () => {
    expect(decidePwaCacheAction({
      method: 'GET',
      url: 'https://pwa.wancode.example/manifest.webmanifest',
    })).toBe('cache-shell')
    expect(decidePwaCacheAction({
      method: 'GET',
      url: 'https://pwa.wancode.example/pair.js',
    })).toBe('cache-shell')
    expect(decidePwaCacheAction({
      method: 'GET',
      url: 'https://pwa.wancode.example/v1/devices/list',
    })).toBe('network-only')
    expect(decidePwaCacheAction({
      method: 'POST',
      url: 'https://relay.wancode.example/v1/tokens',
    })).toBe('network-only')
    expectRelayError(
      () => decidePwaCacheAction({
        method: 'GET',
        url: 'https://pwa.wancode.example/?access_token=tok-live',
      }),
      'plaintext',
    )
    expectRelayError(
      () => decidePwaCacheAction({
        method: 'GET',
        url: 'https://pwa.wancode.example/#access_token=tok-live',
      }),
      'plaintext',
    )
    expectRelayError(
      () => decidePwaCacheAction({
        method: 'GET',
        url: 'http://pwa.example.invalid/',
      }),
      'cleartext-transport',
    )
    expectRelayError(
      () => decidePwaCacheAction({
        method: 'GET',
        url: 'https://pwa.wancode.example/',
        DEEPSEEK_API_KEY: 'sk-secret',
      } as never),
      'plaintext',
    )
  })

  it('deletes stale shell caches and refuses credentialed cache names', () => {
    expect(decidePwaCacheRetention(PWA_SHELL_CACHE)).toBe('keep')
    expect(decidePwaCacheRetention('wancode-pwa-shell-v1')).toBe('delete')
    expect(decidePwaCacheRetention('wancode-pwa-shell-v2')).toBe('delete')
    expect(decidePwaCacheRetention('wancode-pwa-shell-v3')).toBe('delete')
    expect(decidePwaCacheRetention('wancode-pwa-shell-v4')).toBe('delete')
    expect(decidePwaCacheRetention('wancode-pwa-shell-v5')).toBe('delete')
    expect(decidePwaCacheRetention('wancode-pwa-shell-v6')).toBe('delete')
    expect(decidePwaCacheRetention('wancode-pwa-shell-v7')).toBe('delete')
    expect(decidePwaCacheRetention('wancode-pwa-shell-v8')).toBe('delete')
    expect(decidePwaCacheRetention('wancode-pwa-shell-v9')).toBe('delete')
    expect(decidePwaCacheRetention('wancode-pwa-shell-v10')).toBe('delete')
    expect(decidePwaCacheRetention('wancode-pwa-shell-v11')).toBe('delete')
    expect(decidePwaCacheRetention('wancode-pwa-shell-v12')).toBe('delete')
    expectRelayError(() => decidePwaCacheRetention(''), 'malformed')
    expectRelayError(() => decidePwaCacheRetention('token-cache'), 'plaintext')
  })

  it('accepts HTTPS or loopback origins and refuses credentialed public HTTP', () => {
    expect(assertPwaShellOrigin('https://pwa.wancode.example/').href).toBe('https://pwa.wancode.example/')
    expect(assertPwaShellOrigin('http://127.0.0.1:4173/').href).toBe('http://127.0.0.1:4173/')
    expectRelayError(
      () => assertPwaShellOrigin('http://pwa.example.invalid/'),
      'cleartext-transport',
    )
    expectRelayError(
      () => assertPwaShellOrigin('https://pwa.wancode.example/?access_token=tok-live'),
      'plaintext',
    )
    expectRelayError(
      () => assertPwaShellOrigin('https://user:pass@pwa.wancode.example/'),
      'plaintext',
    )
    expectRelayError(
      () => assertPwaShellOrigin('https://pwa.wancode.example/#access_token=tok-live'),
      'plaintext',
    )
  })

  it('emits a service worker that caches the shell and never listens', () => {
    const source = createPwaServiceWorkerSource()
    expect(source).toContain(PWA_SHELL_CACHE)
    expect(source).toContain("self.addEventListener('install'")
    expect(source).toContain("self.addEventListener('activate'")
    expect(source).toContain("self.addEventListener('fetch'")
    expect(source).toContain('self.skipWaiting()')
    expect(source).toContain('self.clients.claim()')
    expect(source).toContain('caches.delete(name)')
    expect(source).toContain('CREDENTIAL_QUERY')
    expect(source).not.toContain('listen(')
    expect(source).not.toContain('createServer')
    expect(source).not.toMatch(/access_token|DEEPSEEK_API_KEY/)
  })

  it('emits static shell files that match the manifest and never embed secrets', () => {
    const files = createPwaShellFiles()
    expect(JSON.parse(files['manifest.webmanifest'])).toEqual(createPwaWebManifest())
    expect(files['sw.js']).toBe(createPwaServiceWorkerSource())
    expect(files['pair.js']).toBe(createPwaPairingScriptSource())
    expect(files['index.html']).toContain('rel="manifest"')
    expect(files['index.html']).toContain('rel="apple-touch-icon"')
    expect(files['index.html']).toContain('name="apple-mobile-web-app-capable"')
    expect(files['index.html']).toContain('name="mobile-web-app-capable"')
    expect(files['index.html']).toContain('src="./pair.js"')
    expect(files['index.html']).not.toContain("navigator.serviceWorker.register('./sw.js')")
    expect(files['index.html']).toContain('<title>Wan Code</title>')
    expect(files['index.html']).toContain('name="origin"')
    expect(files['index.html']).toContain('name="pair"')
    expect(files['index.html']).not.toContain('name="token"')
    expect(files['pair.js']).toContain('allowedPairingCode')
    expect(files['pair.js']).toContain('/v1/pairing/redeem')
    expect(files['pair.js']).toContain("sessionStorage.setItem('wancode-relay-desktop'")
    expect(files['pair.js']).toContain('WebSocket')
    expect(files['pair.js']).toContain('v1:hs:')
    expect(files['pair.js']).toContain('handshake-ack')
    expect(files['pair.js']).not.toContain("sessionStorage.setItem('pair'")
    expect(files['index.html']).toContain('id="forget"')
    expect(files['pair.js']).toContain("sessionStorage.removeItem('wancode-relay-origin'")
    expect(files['pair.js']).toContain("sessionStorage.removeItem('wancode-relay-desktop'")
    expect(files['pair.js']).not.toContain('revoke')
    expect(files['pair.js']).toContain('event.preventDefault()')
    expect(files['pair.js']).toContain("navigator.serviceWorker.register('./sw.js')")
    expect(files['pair.js']).toContain('sessionStorage')
    expect(files['pair.js']).toContain('parsed.hash.length > 0')
    expect(files['pair.js']).toContain('indexedDB')
    expect(files['pair.js']).toContain("indexedDB.open('wancode-relay-identity', 1)")
    expect(files['pair.js']).toContain("sessionStorage.setItem('wancode-relay-origin'")
    expect(files['pair.js']).not.toContain("sessionStorage.setItem('wancode-relay-identity'")
    expect(files['pair.js']).toContain("sessionStorage.getItem('wancode-relay-desktop'")
    expect(files['pair.js']).not.toContain('localStorage')
    expect(files['index.html']).not.toContain('name="token"')
    expect(files['index.html']).toBe(createPwaIndexHtml())
    expect(files['index.html'] + files['manifest.webmanifest'] + files['sw.js']).not.toMatch(
      /access_token|DEEPSEEK_API_KEY|privateKey/,
    )
    expect(files['pair.js']).not.toMatch(/access_token|DEEPSEEK_API_KEY/)
    expect(files['pair.js']).not.toMatch(/sessionStorage\.setItem\([^)]*accessToken/)
    expect(JSON.stringify(files)).not.toContain('listen(')
    for (const name of ['index.html', 'manifest.webmanifest', 'sw.js', 'pair.js'] as const) {
      expect(readFileSync(new URL(`../public/${name}`, import.meta.url), 'utf8')).toBe(files[name])
    }
  })

  it('returns deploy files that include icons and never start a listener', () => {
    const files = createPwaDeployFiles()
    expect(files['index.html']).toBe(createPwaShellFiles()['index.html'])
    expect(files['icons/wancode-192.png']).toEqual(createPwaShellIcons()['icons/wancode-192.png'])
    expect(files['icons/wancode-512.png']).toEqual(createPwaShellIcons()['icons/wancode-512.png'])
    expect(Object.keys(files).sort()).toEqual([
      'icons/wancode-192.png',
      'icons/wancode-512.png',
      'index.html',
      'manifest.webmanifest',
      'pair.js',
      'sw.js',
    ])
    expect(JSON.stringify({
      html: files['index.html'],
      manifest: files['manifest.webmanifest'],
      sw: files['sw.js'],
    })).not.toContain('listen(')
  })

  it('emits PNG icons that match the checked-in installable assets', () => {
    const icons = createPwaShellIcons()
    expect(readPngSize(icons['icons/wancode-192.png'])).toEqual({ width: 192, height: 192 })
    expect(readPngSize(icons['icons/wancode-512.png'])).toEqual({ width: 512, height: 512 })
    expect(createPwaShellIcon(192).equals(icons['icons/wancode-192.png'])).toBe(true)
    expect(PWA_SHELL_PATHS).toContain('/icons/wancode-192.png')
    expect(PWA_SHELL_PATHS).toContain('/icons/wancode-512.png')
    for (const name of ['icons/wancode-192.png', 'icons/wancode-512.png'] as const) {
      expect(readFileSync(new URL(`../public/${name}`, import.meta.url))).toEqual(icons[name])
    }
  })
})

function readPngSize(png: Buffer): { width: number, height: number } {
  expect(png.subarray(0, 8)).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
  return {
    width: png.readUInt32BE(16),
    height: png.readUInt32BE(20),
  }
}
