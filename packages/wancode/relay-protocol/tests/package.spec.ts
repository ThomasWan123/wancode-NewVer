import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import * as protocol from '../src/index.ts'

const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
  name?: unknown
  dsh?: unknown
  packageManager?: unknown
  exports?: Record<string, unknown>
}

describe('relay-protocol package surface', () => {
  it('is an owned Wan Code module without a loadable DSH entry', () => {
    expect(manifest.name).toBe('@wancode/relay-protocol')
    expect(manifest.dsh).toBeUndefined()
    expect(manifest.packageManager).toBeUndefined()
  })

  it('keeps the loopback acceptor off the default protocol export', () => {
    expect(manifest.exports).toHaveProperty('.')
    expect(manifest.exports).toHaveProperty('./loopback')
    expect(protocol).toHaveProperty('connectOutboundRelay')
    expect(protocol).toHaveProperty('assertOutboundRelayUrl')
    expect(protocol).not.toHaveProperty('startLoopbackRelay')
    expect(protocol).not.toHaveProperty('listen')
    expect(protocol).not.toHaveProperty('createServer')
  })
})
