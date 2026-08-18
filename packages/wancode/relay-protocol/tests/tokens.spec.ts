import { describe, expect, it } from 'vitest'
import {
  RelayAuthorizationError,
  createMemoryRelayStore,
  createMemoryRelayTokenIssuer,
  dispatchRelayEnvelope,
  issueRelayAccessToken,
} from '../src/index.ts'

const NOW = 1_700_000_000_000

function expectRelayError(run: () => unknown, code: string): void {
  try {
    run()
    expect.unreachable('expected a relay authorization error')
  } catch (cause) {
    expect(cause).toBeInstanceOf(RelayAuthorizationError)
    expect((cause as RelayAuthorizationError).code).toBe(code)
  }
}

describe('short-lived relay access tokens', () => {
  it('issues a device-bound token that authorizes one envelope', () => {
    const store = createMemoryRelayStore()
    store.putDevice({ deviceId: 'device-a', userId: 'user-a', publicKey: 'device-a-public' })
    const issuer = createMemoryRelayTokenIssuer(store)
    const issued = issuer.issue({
      userId: 'user-a',
      deviceId: 'device-a',
      now: NOW,
      ttlMs: 60_000,
    })

    expect(issued.accessToken).toBe(issued.record.tokenId)
    expect(issued.record).toEqual({
      tokenId: issued.accessToken,
      userId: 'user-a',
      deviceId: 'device-a',
      expiresAt: NOW + 60_000,
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

  it('rejects a token after its lifetime elapses', () => {
    const store = createMemoryRelayStore()
    store.putDevice({ deviceId: 'device-a', userId: 'user-a', publicKey: 'device-a-public' })
    const issued = createMemoryRelayTokenIssuer(store).issue({
      userId: 'user-a',
      deviceId: 'device-a',
      now: NOW,
      ttlMs: 1,
    })
    expectRelayError(() => dispatchRelayEnvelope({
      envelope: {
        protocolVersion: 1,
        id: 'msg-1',
        kind: 'handshake',
        sentAt: NOW + 2,
        actor: { userId: 'user-a', deviceId: 'device-a' },
        ciphertext: 'v1:opaque-ciphertext',
      },
      accessToken: issued.accessToken,
      store,
      now: NOW + 2,
    }), 'expired-token')
  })

  it('refuses an empty actor or a non-positive lifetime', () => {
    expectRelayError(() => issueRelayAccessToken({
      userId: '',
      deviceId: 'device-a',
      now: NOW,
    }), 'malformed')
    expectRelayError(() => issueRelayAccessToken({
      userId: 'user-a',
      deviceId: 'device-a',
      now: NOW,
      ttlMs: 0,
    }), 'expired-token')
  })
})
