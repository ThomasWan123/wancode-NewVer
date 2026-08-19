import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { RelayAuthorizationError } from '../../relay-protocol/src/index.ts'
import {
  createPwaIndexHtml,
  createPwaServiceWorkerSource,
  createPwaShellFiles,
  createPwaWebManifest,
  decidePwaCacheAction,
  PWA_SHELL_CACHE,
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
    expect(manifest.start_url).toBe('./')
    expect(manifest.scope).toBe('./')
    expect(manifest.name).toBe('Wan Code')
    expect(JSON.stringify(manifest)).not.toMatch(/token|secret|credential|password|authorization/i)
    expect(PWA_SHELL_CACHE).toBe('wancode-pwa-shell-v1')
    expect(PWA_SHELL_PATHS).toContain('/manifest.webmanifest')
  })

  it('caches only shell GET assets and never stores control-plane tokens', () => {
    expect(decidePwaCacheAction({
      method: 'GET',
      url: 'https://pwa.wancode.example/manifest.webmanifest',
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

  it('emits a service worker that caches the shell and never listens', () => {
    const source = createPwaServiceWorkerSource()
    expect(source).toContain(PWA_SHELL_CACHE)
    expect(source).toContain("self.addEventListener('install'")
    expect(source).toContain("self.addEventListener('fetch'")
    expect(source).toContain('CREDENTIAL_QUERY')
    expect(source).not.toContain('listen(')
    expect(source).not.toContain('createServer')
    expect(source).not.toMatch(/access_token|DEEPSEEK_API_KEY/)
  })

  it('emits static shell files that match the manifest and never embed secrets', () => {
    const files = createPwaShellFiles()
    expect(JSON.parse(files['manifest.webmanifest'])).toEqual(createPwaWebManifest())
    expect(files['sw.js']).toBe(createPwaServiceWorkerSource())
    expect(files['index.html']).toContain('rel="manifest"')
    expect(files['index.html']).toContain("navigator.serviceWorker.register('./sw.js')")
    expect(files['index.html']).toContain('<title>Wan Code</title>')
    expect(files['index.html']).toBe(createPwaIndexHtml())
    expect(JSON.stringify(files)).not.toMatch(/access_token|DEEPSEEK_API_KEY|privateKey/)
    expect(JSON.stringify(files)).not.toContain('listen(')
    for (const name of ['index.html', 'manifest.webmanifest', 'sw.js'] as const) {
      expect(readFileSync(new URL(`../public/${name}`, import.meta.url), 'utf8')).toBe(files[name])
    }
  })
})
