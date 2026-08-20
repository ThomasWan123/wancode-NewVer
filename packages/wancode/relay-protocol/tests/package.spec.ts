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
    expect(manifest.exports).toHaveProperty('./cloud')
    expect(protocol).toHaveProperty('createJwksOidcIdentityProvider')
    expect(protocol).toHaveProperty('assertOidcJwksUrl')
    expect(protocol).toHaveProperty('fetchOidcJwks')
    expect(protocol).toHaveProperty('connectOutboundRelay')
    expect(protocol).toHaveProperty('assertOutboundRelayHttpUrl')
    expect(protocol).toHaveProperty('registerOutboundRelayDevice')
    expect(protocol).toHaveProperty('issueOutboundRelayToken')
    expect(protocol).toHaveProperty('revokeOutboundRelayDevice')
    expect(protocol).toHaveProperty('listOutboundRelayDevices')
    expect(protocol).toHaveProperty('listRelayAccountDevices')
    expect(protocol).toHaveProperty('httpUrlFromOutboundRelayUrl')
    expect(protocol).toHaveProperty('parseRelayWireCommand')
    expect(protocol).toHaveProperty('parseRelayWireDelivery')
    expect(protocol).toHaveProperty('assertOutboundRelayUrl')
    expect(protocol).toHaveProperty('routeRelayEnvelope')
    expect(protocol).toHaveProperty('deliverRelayEnvelope')
    expect(protocol).toHaveProperty('reclaimRelayMailbox')
    expect(protocol).toHaveProperty('assertSealedApplicationEnvelope')
    expect(protocol).toHaveProperty('generateDeviceKeyPair')
    expect(protocol).toHaveProperty('createSignedHandshakeEnvelope')
    expect(protocol).toHaveProperty('createRelayHandshakeNonce')
    expect(protocol).toHaveProperty('createStoredDeviceIdentity')
    expect(protocol).toHaveProperty('createWebCryptoDeviceIdentity')
    expect(protocol).toHaveProperty('generateWebCryptoDeviceKeyPair')
    expect(protocol).toHaveProperty('createWebCryptoDeviceId')
    expect(protocol).toHaveProperty('parseStoredDeviceIdentity')
    expect(protocol).toHaveProperty('serializeStoredDeviceIdentity')
    expect(protocol).toHaveProperty('publicDeviceIdentity')
    expect(protocol).not.toHaveProperty('startLoopbackRelay')
    expect(protocol).not.toHaveProperty('startRelayCloud')
    expect(protocol).not.toHaveProperty('listen')
    expect(protocol).not.toHaveProperty('createServer')
  })
})
