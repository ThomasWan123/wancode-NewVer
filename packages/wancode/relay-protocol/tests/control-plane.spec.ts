import { describe, expect, it } from 'vitest'
import {
  RelayAuthorizationError,
  createMemoryRelayStore,
  dispatchRelayEnvelope,
  parseRelayEnvelope,
} from '../src/index.ts'

const NOW = 1_700_000_000_000

function validEnvelope(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    protocolVersion: 1,
    id: 'msg-1',
    kind: 'handshake',
    sentAt: NOW,
    actor: { userId: 'user-a', deviceId: 'device-a' },
    ciphertext: 'v1:opaque-ciphertext',
    ...overrides,
  }
}

function harness(now = NOW) {
  const store = createMemoryRelayStore()
  store.putAccessToken({
    tokenId: 'tok-live',
    userId: 'user-a',
    deviceId: 'device-a',
    expiresAt: now + 60_000,
  })
  store.putDevice({
    deviceId: 'device-a',
    userId: 'user-a',
    publicKey: 'device-a-public',
  })
  return {
    store,
    dispatch(envelope: unknown, accessToken = 'tok-live') {
      return dispatchRelayEnvelope({
        envelope,
        accessToken,
        store,
        now,
      })
    },
  }
}

function expectRelayError(run: () => unknown, code: string): void {
  try {
    run()
    expect.unreachable('expected a relay authorization error')
  } catch (cause) {
    expect(cause).toBeInstanceOf(RelayAuthorizationError)
    expect((cause as RelayAuthorizationError).code).toBe(code)
  }
}

describe('WanCodeNewVer relay protocol', () => {
  it('accepts a versioned handshake from a live token and registered device', () => {
    const { dispatch } = harness()
    expect(dispatch(validEnvelope())).toEqual({ id: 'msg-1', outcome: 'accepted' })
  })

  it('returns the original outcome for an identical retry of the same message id', () => {
    const { dispatch } = harness()
    expect(dispatch(validEnvelope())).toEqual({ id: 'msg-1', outcome: 'accepted' })
    expect(dispatch(validEnvelope())).toEqual({ id: 'msg-1', outcome: 'duplicate' })
  })

  it('rejects a reused message id whose ciphertext changed', () => {
    const { dispatch } = harness()
    dispatch(validEnvelope())
    expectRelayError(() => dispatch(validEnvelope({ ciphertext: 'v1:other-ciphertext' })), 'replay')
  })

  it('rejects an expired access token even when the device still exists', () => {
    const store = createMemoryRelayStore()
    store.putAccessToken({
      tokenId: 'tok-old',
      userId: 'user-a',
      deviceId: 'device-a',
      expiresAt: NOW - 1,
    })
    store.putDevice({ deviceId: 'device-a', userId: 'user-a', publicKey: 'device-a-public' })
    expectRelayError(() => dispatchRelayEnvelope({
      envelope: validEnvelope(),
      accessToken: 'tok-old',
      store,
      now: NOW,
    }), 'expired-token')
  })

  it('rejects a revoked device', () => {
    const store = createMemoryRelayStore()
    store.putAccessToken({
      tokenId: 'tok-live',
      userId: 'user-a',
      deviceId: 'device-a',
      expiresAt: NOW + 60_000,
    })
    store.putDevice({
      deviceId: 'device-a',
      userId: 'user-a',
      publicKey: 'device-a-public',
      revokedAt: NOW - 1,
    })
    expectRelayError(() => dispatchRelayEnvelope({
      envelope: validEnvelope(),
      accessToken: 'tok-live',
      store,
      now: NOW,
    }), 'revoked-device')
  })

  it('rejects a token that names a different account than the envelope actor', () => {
    const store = createMemoryRelayStore()
    store.putAccessToken({
      tokenId: 'tok-other',
      userId: 'user-b',
      deviceId: 'device-b',
      expiresAt: NOW + 60_000,
    })
    store.putDevice({ deviceId: 'device-b', userId: 'user-b', publicKey: 'device-b-public' })
    expectRelayError(() => dispatchRelayEnvelope({
      envelope: validEnvelope(),
      accessToken: 'tok-other',
      store,
      now: NOW,
    }), 'cross-account')
  })

  it('refuses plaintext prompt, credential, or tool-output fields on the envelope', () => {
    expectRelayError(() => parseRelayEnvelope(validEnvelope({ prompt: 'delete all files' })), 'plaintext')
    expectRelayError(() => parseRelayEnvelope(validEnvelope({ credential: 'sk-secret' })), 'plaintext')
    expectRelayError(() => parseRelayEnvelope(validEnvelope({ toolOutput: '-----BEGIN KEY-----' })), 'plaintext')
  })

  it('rejects an unknown protocol version', () => {
    expectRelayError(() => parseRelayEnvelope(validEnvelope({ protocolVersion: 2 })), 'unknown-protocol')
  })
})
