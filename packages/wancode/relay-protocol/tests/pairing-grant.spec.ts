import { describe, expect, it } from 'vitest'
import {
  RelayAuthorizationError,
  assertRelayPairingCode,
  createMemoryRelayPairingGrantStore,
  createMemoryRelayStore,
  createMemoryRelayTokenIssuer,
  createRelayPairingCode,
  createStaticOidcIdentityProvider,
  generateDeviceKeyPair,
  mintRelayPairingGrant,
  redeemRelayPairingGrant,
  registerRelayDevice,
} from '../src/index.ts'

const NOW = 1_700_000_000_000
const ISSUER = 'https://idp.wancode.example/realms/wancode'
const AUDIENCE = 'wancode-relay'

function expectRelayError(run: () => unknown, code: string): void {
  try {
    run()
    expect.unreachable('expected a relay authorization error')
  } catch (cause) {
    expect(cause).toBeInstanceOf(RelayAuthorizationError)
    expect((cause as RelayAuthorizationError).code).toBe(code)
  }
}

function assertion(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    iss: ISSUER,
    aud: AUDIENCE,
    sub: 'user-a',
    exp: Math.floor((NOW + 60_000) / 1000),
    ...overrides,
  }
}

describe('relay pairing grants', () => {
  it('mints a one-time code, redeems a PWA, and refuses reuse or a jwt', () => {
    const store = createMemoryRelayStore()
    const grants = createMemoryRelayPairingGrantStore()
    const tokens = createMemoryRelayTokenIssuer(store)
    const identity = createStaticOidcIdentityProvider({ issuer: ISSUER, audience: AUDIENCE })
    const claims = identity.verify(assertion(), NOW)
    const desktopKeys = generateDeviceKeyPair()
    const pwaKeys = generateDeviceKeyPair()
    registerRelayDevice({
      identity: claims,
      deviceId: 'desktop-a',
      publicKey: desktopKeys.publicKey,
      encryptionPublicKey: desktopKeys.encryptionPublicKey,
      now: NOW,
      store,
    })
    const minted = mintRelayPairingGrant({
      identity: claims,
      desktopDeviceId: 'desktop-a',
      now: NOW,
      devices: store,
      grants,
    })
    expect(minted.pairingCode).toMatch(/^[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}$/u)
    expect(minted.desktopDeviceId).toBe('desktop-a')
    expect(JSON.stringify(minted)).not.toMatch(/privateKey|encryptionPrivateKey/)
    expect(assertRelayPairingCode(minted.pairingCode)).toHaveLength(8)
    expectRelayError(() => assertRelayPairingCode('aaa.bbb.ccc'), 'malformed')
    expectRelayError(() => assertRelayPairingCode('access_token'), 'plaintext')
    const redeemed = redeemRelayPairingGrant({
      pairingCode: minted.pairingCode,
      deviceId: 'pwa-a',
      publicKey: pwaKeys.publicKey,
      encryptionPublicKey: pwaKeys.encryptionPublicKey,
      now: NOW,
      devices: store,
      grants,
      tokens,
    })
    expect(redeemed.device.deviceId).toBe('pwa-a')
    expect(redeemed.device.userId).toBe('user-a')
    expect(redeemed.desktop.deviceId).toBe('desktop-a')
    expect(redeemed.accessToken.length).toBeGreaterThan(0)
    expect(JSON.stringify(redeemed.device)).not.toMatch(/privateKey|encryptionPrivateKey/)
    expectRelayError(
      () => redeemRelayPairingGrant({
        pairingCode: minted.pairingCode,
        deviceId: 'pwa-b',
        publicKey: generateDeviceKeyPair().publicKey,
        encryptionPublicKey: generateDeviceKeyPair().encryptionPublicKey,
        now: NOW,
        devices: store,
        grants,
        tokens,
      }),
      'replay',
    )
  })

  it('retires an outstanding grant when the desktop mints again', () => {
    const store = createMemoryRelayStore()
    const grants = createMemoryRelayPairingGrantStore()
    const tokens = createMemoryRelayTokenIssuer(store)
    const identity = createStaticOidcIdentityProvider({ issuer: ISSUER, audience: AUDIENCE })
    const claims = identity.verify(assertion(), NOW)
    const desktopKeys = generateDeviceKeyPair()
    registerRelayDevice({
      identity: claims,
      deviceId: 'desktop-a',
      publicKey: desktopKeys.publicKey,
      encryptionPublicKey: desktopKeys.encryptionPublicKey,
      now: NOW,
      store,
    })
    const first = mintRelayPairingGrant({
      identity: claims,
      desktopDeviceId: 'desktop-a',
      now: NOW,
      devices: store,
      grants,
    })
    const second = mintRelayPairingGrant({
      identity: claims,
      desktopDeviceId: 'desktop-a',
      now: NOW,
      devices: store,
      grants,
    })
    expect(second.pairingCode).not.toBe(first.pairingCode)
    const pwaKeys = generateDeviceKeyPair()
    expectRelayError(
      () => redeemRelayPairingGrant({
        pairingCode: first.pairingCode,
        deviceId: 'pwa-a',
        publicKey: pwaKeys.publicKey,
        encryptionPublicKey: pwaKeys.encryptionPublicKey,
        now: NOW,
        devices: store,
        grants,
        tokens,
      }),
      'replay',
    )
    const redeemed = redeemRelayPairingGrant({
      pairingCode: second.pairingCode,
      deviceId: 'pwa-a',
      publicKey: pwaKeys.publicKey,
      encryptionPublicKey: pwaKeys.encryptionPublicKey,
      now: NOW,
      devices: store,
      grants,
      tokens,
    })
    expect(redeemed.device.deviceId).toBe('pwa-a')
  })

  it('refuses an expired grant, a missing desktop, and an unknown code', () => {
    const store = createMemoryRelayStore()
    const grants = createMemoryRelayPairingGrantStore()
    const tokens = createMemoryRelayTokenIssuer(store)
    const identity = createStaticOidcIdentityProvider({ issuer: ISSUER, audience: AUDIENCE })
    const claims = identity.verify(assertion(), NOW)
    const desktopKeys = generateDeviceKeyPair()
    const pwaKeys = generateDeviceKeyPair()
    expectRelayError(
      () => mintRelayPairingGrant({
        identity: claims,
        desktopDeviceId: 'desktop-a',
        now: NOW,
        devices: store,
        grants,
      }),
      'revoked-device',
    )
    registerRelayDevice({
      identity: claims,
      deviceId: 'desktop-a',
      publicKey: desktopKeys.publicKey,
      encryptionPublicKey: desktopKeys.encryptionPublicKey,
      now: NOW,
      store,
    })
    const minted = mintRelayPairingGrant({
      identity: claims,
      desktopDeviceId: 'desktop-a',
      now: NOW,
      devices: store,
      grants,
      ttlMs: 1,
    })
    expectRelayError(
      () => redeemRelayPairingGrant({
        pairingCode: minted.pairingCode,
        deviceId: 'pwa-a',
        publicKey: pwaKeys.publicKey,
        encryptionPublicKey: pwaKeys.encryptionPublicKey,
        now: NOW + 2,
        devices: store,
        grants,
        tokens,
      }),
      'expired-token',
    )
    expectRelayError(
      () => redeemRelayPairingGrant({
        pairingCode: createRelayPairingCode(),
        deviceId: 'pwa-a',
        publicKey: pwaKeys.publicKey,
        encryptionPublicKey: pwaKeys.encryptionPublicKey,
        now: NOW,
        devices: store,
        grants,
        tokens,
      }),
      'untrusted-identity',
    )
  })
})
