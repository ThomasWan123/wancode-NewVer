import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import * as pwa from '../src/index.ts'

const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
  name?: unknown
  dsh?: unknown
  packageManager?: unknown
  dependencies?: Record<string, unknown>
  exports?: Record<string, unknown>
}

describe('relay-pwa package surface', () => {
  it('is an owned Wan Code module without a loadable DSH entry or public listener', () => {
    expect(manifest.name).toBe('@wancode/relay-pwa')
    expect(manifest.dsh).toBeUndefined()
    expect(manifest.packageManager).toBeUndefined()
    expect(manifest.dependencies).toBeUndefined()
    expect(manifest.exports).toEqual({
      '.': {
        types: './src/index.ts',
        default: './src/index.ts',
      },
    })
    expect(pwa).toHaveProperty('projectRelaySessionView')
    expect(pwa).toHaveProperty('projectRelayNotification')
    expect(pwa).toHaveProperty('createPwaRelayController')
    expect(pwa).toHaveProperty('createPwaSessionBoard')
    expect(pwa).toHaveProperty('createPwaWebManifest')
    expect(pwa).toHaveProperty('createPwaIndexHtml')
    expect(pwa).toHaveProperty('createPwaShellFiles')
    expect(pwa).toHaveProperty('createPwaServiceWorkerSource')
    expect(pwa).toHaveProperty('decidePwaCacheAction')
    expect(pwa).not.toHaveProperty('startRelayCloud')
    expect(pwa).not.toHaveProperty('startLoopbackRelay')
    expect(pwa).not.toHaveProperty('listen')
    expect(pwa).not.toHaveProperty('createServer')
  })
})
