import { describe, expect, it } from 'vitest'
import {
  RelayAuthorizationError,
  createMemoryRelayStore,
  createMemoryRelayTokenIssuer,
  createStaticOidcIdentityProvider,
  dispatchRelayEnvelope,
  generateDeviceKeyPair,
  registerRelayDevice,
  revokeRelayDevice,
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

describe('replaceable OIDC identity and device registration', () => {
  it('registers a device from a trusted assertion and authorizes a token', () => {
    const identity = createStaticOidcIdentityProvider({ issuer: ISSUER, audience: AUDIENCE })
    const store = createMemoryRelayStore()
    const keys = generateDeviceKeyPair()
    const claims = identity.verify(assertion(), NOW)
    const device = registerRelayDevice({
      identity: claims,
      deviceId: 'device-a',
      publicKey: keys.publicKey,
      now: NOW,
      store,
    })
    const issued = createMemoryRelayTokenIssuer(store).issue({
      userId: claims.userId,
      deviceId: device.deviceId,
      now: NOW,
      ttlMs: 60_000,
    })

    expect(device).toEqual({
      deviceId: 'device-a',
      userId: 'user-a',
      publicKey: keys.publicKey,
    })
    expect(dispatchRelayEnvelope({
      envelope: {
        protocolVersion: 1,
        id: 'msg-1',
        kind: 'handshake',
        sentAt: NOW,
        actor: { userId: 'user-a', deviceId: 'device-a' },
        ciphertext: 'v1:opaque-ciphertext',
      },
      accessToken: issued.accessToken,
      store,
      now: NOW,
    }).outcome).toBe('accepted')
  })

  it('rejects an expired, foreign, or plaintext identity assertion', () => {
    const identity = createStaticOidcIdentityProvider({ issuer: ISSUER, audience: AUDIENCE })
    expectRelayError(() => identity.verify(assertion({ exp: Math.floor(NOW / 1000) }), NOW), 'expired-token')
    expectRelayError(() => identity.verify(assertion({ iss: 'https://evil.example' }), NOW), 'untrusted-identity')
    expectRelayError(() => identity.verify(assertion({ aud: 'other-api' }), NOW), 'untrusted-identity')
    expectRelayError(() => identity.verify(assertion({ prompt: 'delete all files' }), NOW), 'plaintext')
  })

  it('revokes a device immediately and refuses to reuse that device id', () => {
    const identity = createStaticOidcIdentityProvider({ issuer: ISSUER, audience: AUDIENCE })
    const store = createMemoryRelayStore()
    const keys = generateDeviceKeyPair()
    const claims = identity.verify(assertion(), NOW)
    registerRelayDevice({
      identity: claims,
      deviceId: 'device-a',
      publicKey: keys.publicKey,
      now: NOW,
      store,
    })
    const issued = createMemoryRelayTokenIssuer(store).issue({
      userId: 'user-a',
      deviceId: 'device-a',
      now: NOW,
      ttlMs: 60_000,
    })

    expect(revokeRelayDevice({
      userId: 'user-a',
      deviceId: 'device-a',
      now: NOW,
      store,
    }).revokedAt).toBe(NOW)
    expectRelayError(() => dispatchRelayEnvelope({
      envelope: {
        protocolVersion: 1,
        id: 'msg-1',
        kind: 'handshake',
        sentAt: NOW,
        actor: { userId: 'user-a', deviceId: 'device-a' },
        ciphertext: 'v1:opaque-ciphertext',
      },
      accessToken: issued.accessToken,
      store,
      now: NOW,
    }), 'revoked-device')
    expectRelayError(() => registerRelayDevice({
      identity: claims,
      deviceId: 'device-a',
      publicKey: keys.publicKey,
      now: NOW,
      store,
    }), 'revoked-device')
  })

  it('refuses a device id that already belongs to another account', () => {
    const identity = createStaticOidcIdentityProvider({ issuer: ISSUER, audience: AUDIENCE })
    const store = createMemoryRelayStore()
    const keys = generateDeviceKeyPair()
    registerRelayDevice({
      identity: identity.verify(assertion(), NOW),
      deviceId: 'device-a',
      publicKey: keys.publicKey,
      now: NOW,
      store,
    })
    expectRelayError(() => registerRelayDevice({
      identity: identity.verify(assertion({ sub: 'user-b' }), NOW),
      deviceId: 'device-a',
      publicKey: keys.publicKey,
      now: NOW,
      store,
    }), 'cross-account')
    expectRelayError(() => revokeRelayDevice({
      userId: 'user-b',
      deviceId: 'device-a',
      now: NOW,
      store,
    }), 'cross-account')
  })

  it('stores an optional X25519 encryption public key and refuses a later mismatch', () => {
    const identity = createStaticOidcIdentityProvider({ issuer: ISSUER, audience: AUDIENCE })
    const store = createMemoryRelayStore()
    const keys = generateDeviceKeyPair()
    const other = generateDeviceKeyPair()
    const claims = identity.verify(assertion(), NOW)
    expect(registerRelayDevice({
      identity: claims,
      deviceId: 'device-a',
      publicKey: keys.publicKey,
      encryptionPublicKey: keys.encryptionPublicKey,
      now: NOW,
      store,
    })).toEqual({
      deviceId: 'device-a',
      userId: 'user-a',
      publicKey: keys.publicKey,
      encryptionPublicKey: keys.encryptionPublicKey,
    })
    expect(registerRelayDevice({
      identity: claims,
      deviceId: 'device-a',
      publicKey: keys.publicKey,
      encryptionPublicKey: keys.encryptionPublicKey,
      now: NOW,
      store,
    }).encryptionPublicKey).toBe(keys.encryptionPublicKey)
    expectRelayError(() => registerRelayDevice({
      identity: claims,
      deviceId: 'device-a',
      publicKey: keys.publicKey,
      encryptionPublicKey: other.encryptionPublicKey,
      now: NOW,
      store,
    }), 'untrusted-key')
    expectRelayError(() => registerRelayDevice({
      identity: claims,
      deviceId: 'device-b',
      publicKey: keys.publicKey,
      encryptionPublicKey: keys.publicKey,
      now: NOW,
      store,
    }), 'untrusted-key')
  })
})
