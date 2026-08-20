import { describe, expect, it } from 'vitest'
import {
  RelayAuthorizationError,
  createMemoryRelayStore,
  createRelayHandshakeNonce,
  createSignedHandshakeEnvelope,
  dispatchRelayEnvelope,
  generateDeviceKeyPair,
  openOutboundSession,
  parseHandshakeAck,
  parseRelayWireHandshake,
} from '../src/index.ts'

const NOW = 1_700_000_000_000
const ACTOR = { userId: 'user-a', deviceId: 'device-a' }

function expectRelayError(run: () => unknown, code: string): void {
  try {
    run()
    expect.unreachable('expected a relay authorization error')
  } catch (cause) {
    expect(cause).toBeInstanceOf(RelayAuthorizationError)
    expect((cause as RelayAuthorizationError).code).toBe(code)
  }
}

describe('relay handshake nonce', () => {
  it('creates a unique hex nonce without node:crypto', () => {
    const first = createRelayHandshakeNonce()
    const second = createRelayHandshakeNonce()
    expect(first).toMatch(/^[0-9a-f]{32}$/u)
    expect(second).toMatch(/^[0-9a-f]{32}$/u)
    expect(first).not.toBe(second)
    expect(first).not.toMatch(/token|secret|credential/i)
  })
})

function authorizedStore(publicKey: string, now = NOW) {
  const store = createMemoryRelayStore()
  store.putAccessToken({
    tokenId: 'tok-live',
    userId: ACTOR.userId,
    deviceId: ACTOR.deviceId,
    expiresAt: now + 60_000,
  })
  store.putDevice({
    deviceId: ACTOR.deviceId,
    userId: ACTOR.userId,
    publicKey,
  })
  return store
}

describe('outbound device handshake', () => {
  it('opens a session from a desktop-signed outbound handshake', () => {
    const keys = generateDeviceKeyPair()
    const store = authorizedStore(keys.publicKey)
    const envelope = createSignedHandshakeEnvelope({
      id: 'hs-1',
      sentAt: NOW,
      actor: ACTOR,
      keyPair: keys,
      nonce: 'nonce-1',
      capabilities: ['session.observe', 'session.prompt'],
    })

    const session = openOutboundSession({
      envelope,
      accessToken: 'tok-live',
      store,
      now: NOW,
    })

    expect(session.userId).toBe('user-a')
    expect(session.deviceId).toBe('device-a')
    expect(session.grantedCapabilities).toEqual(['session.observe', 'session.prompt'])
    expect(session.ack.kind).toBe('handshake-ack')
    expect(session.ack.ciphertext).not.toContain(keys.privateKey)
    expect(session.ack.ciphertext).not.toMatch(/prompt|credential|toolOutput/i)
    const ack = parseHandshakeAck(session.ack)
    expect(ack.sessionId).toBe(session.sessionId)
    expect(ack.grantedCapabilities).toEqual(['session.observe', 'session.prompt'])
    expect(ack.nonce).toBe('nonce-1')
  })

  it('returns the same session when the identical handshake is retried', () => {
    const keys = generateDeviceKeyPair()
    const store = authorizedStore(keys.publicKey)
    const envelope = createSignedHandshakeEnvelope({
      id: 'hs-1',
      sentAt: NOW,
      actor: ACTOR,
      keyPair: keys,
      nonce: 'nonce-1',
      capabilities: ['session.observe'],
    })
    const first = openOutboundSession({ envelope, accessToken: 'tok-live', store, now: NOW })
    const second = openOutboundSession({ envelope, accessToken: 'tok-live', store, now: NOW })
    expect(second).toEqual(first)
  })

  it('rejects a handshake signed by a key that is not the registered device key', () => {
    const registered = generateDeviceKeyPair()
    const attacker = generateDeviceKeyPair()
    const store = authorizedStore(registered.publicKey)
    const envelope = createSignedHandshakeEnvelope({
      id: 'hs-1',
      sentAt: NOW,
      actor: ACTOR,
      keyPair: attacker,
      nonce: 'nonce-1',
      capabilities: ['session.observe'],
    })
    expectRelayError(() => openOutboundSession({
      envelope,
      accessToken: 'tok-live',
      store,
      now: NOW,
    }), 'untrusted-key')
  })

  it('rejects a handshake that claims the relay opened an inbound connection', () => {
    const keys = generateDeviceKeyPair()
    const store = authorizedStore(keys.publicKey)
    const envelope = createSignedHandshakeEnvelope({
      id: 'hs-1',
      sentAt: NOW,
      actor: ACTOR,
      keyPair: keys,
      nonce: 'nonce-1',
      capabilities: ['session.observe'],
      direction: 'inbound',
    })
    expectRelayError(() => openOutboundSession({
      envelope,
      accessToken: 'tok-live',
      store,
      now: NOW,
    }), 'inbound-forbidden')
  })

  it('rejects a reused handshake nonce from the same device', () => {
    const keys = generateDeviceKeyPair()
    const store = authorizedStore(keys.publicKey)
    const first = createSignedHandshakeEnvelope({
      id: 'hs-1',
      sentAt: NOW,
      actor: ACTOR,
      keyPair: keys,
      nonce: 'nonce-1',
      capabilities: ['session.observe'],
    })
    const replayed = createSignedHandshakeEnvelope({
      id: 'hs-2',
      sentAt: NOW,
      actor: ACTOR,
      keyPair: keys,
      nonce: 'nonce-1',
      capabilities: ['session.observe'],
    })
    openOutboundSession({ envelope: first, accessToken: 'tok-live', store, now: NOW })
    expectRelayError(() => openOutboundSession({
      envelope: replayed,
      accessToken: 'tok-live',
      store,
      now: NOW,
    }), 'replay')
  })

  it('rejects an unknown handshake capability', () => {
    const keys = generateDeviceKeyPair()
    const store = authorizedStore(keys.publicKey)
    const envelope = createSignedHandshakeEnvelope({
      id: 'hs-1',
      sentAt: NOW,
      actor: ACTOR,
      keyPair: keys,
      nonce: 'nonce-1',
      capabilities: ['session.observe', 'host.listen'],
    })
    expectRelayError(() => openOutboundSession({
      envelope,
      accessToken: 'tok-live',
      store,
      now: NOW,
    }), 'unknown-capability')
  })

  it('does not open a session from a non-handshake envelope', () => {
    const keys = generateDeviceKeyPair()
    const store = authorizedStore(keys.publicKey)
    expectRelayError(() => openOutboundSession({
      envelope: {
        protocolVersion: 1,
        id: 'evt-1',
        kind: 'session-event',
        sentAt: NOW,
        actor: ACTOR,
        ciphertext: 'v1:opaque-ciphertext',
      },
      accessToken: 'tok-live',
      store,
      now: NOW,
    }), 'malformed')
    expect(dispatchRelayEnvelope({
      envelope: {
        protocolVersion: 1,
        id: 'evt-1',
        kind: 'session-event',
        sentAt: NOW,
        actor: ACTOR,
        ciphertext: 'v1:opaque-ciphertext',
      },
      accessToken: 'tok-live',
      store,
      now: NOW,
    }).outcome).toBe('accepted')
  })

  it('rejects a handshake-ack whose kind is not handshake-ack', () => {
    expectRelayError(() => parseHandshakeAck({
      protocolVersion: 1,
      id: 'hs-1:ack',
      kind: 'handshake',
      sentAt: NOW,
      actor: ACTOR,
      ciphertext: 'v1:ack:e30',
    }), 'malformed')
  })

  it('accepts a first-frame wire handshake that keeps the token off the url', () => {
    const envelope = {
      protocolVersion: 1,
      id: 'hs-1',
      kind: 'handshake',
      sentAt: NOW,
      actor: ACTOR,
      ciphertext: 'v1:hs:opaque',
    }
    expect(parseRelayWireHandshake({
      accessToken: 'tok-live',
      envelope,
    })).toEqual({
      accessToken: 'tok-live',
      envelope,
    })
  })

  it('refuses plaintext application fields on the first wire frame', () => {
    expectRelayError(() => parseRelayWireHandshake({
      accessToken: 'tok-live',
      envelope: { protocolVersion: 1 },
      prompt: 'delete all files',
    }), 'plaintext')
  })
})
