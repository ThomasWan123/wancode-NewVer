import { afterEach, describe, expect, it } from 'vitest'
import {
  RelayAuthorizationError,
  assertOutboundRelayUrl,
  connectOutboundRelay,
  createMemoryRelayStore,
  createSignedHandshakeEnvelope,
  generateDeviceKeyPair,
} from '../src/index.ts'
import { startLoopbackRelay, type LoopbackRelay } from '../src/loopback.ts'

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

async function expectRelayErrorAsync(run: () => Promise<unknown>, code: string): Promise<void> {
  try {
    await run()
    expect.unreachable('expected a relay authorization error')
  } catch (cause) {
    expect(cause).toBeInstanceOf(RelayAuthorizationError)
    expect((cause as RelayAuthorizationError).code).toBe(code)
  }
}

function authorizedStore(publicKey: string) {
  const store = createMemoryRelayStore()
  store.putAccessToken({
    tokenId: 'tok-live',
    userId: ACTOR.userId,
    deviceId: ACTOR.deviceId,
    expiresAt: NOW + 60_000,
  })
  store.putDevice({
    deviceId: ACTOR.deviceId,
    userId: ACTOR.userId,
    publicKey,
  })
  return store
}

describe('outbound relay url policy', () => {
  it('allows production wss and loopback ws', () => {
    expect(assertOutboundRelayUrl('wss://relay.example.invalid/v1').protocol).toBe('wss:')
    expect(assertOutboundRelayUrl('ws://127.0.0.1:9').hostname).toBe('127.0.0.1')
    expect(assertOutboundRelayUrl('ws://localhost:9').hostname).toBe('localhost')
  })

  it('rejects cleartext websocket to a non-loopback host', () => {
    expectRelayError(() => assertOutboundRelayUrl('ws://relay.example.invalid/v1'), 'cleartext-transport')
    expectRelayError(() => assertOutboundRelayUrl('ws://0.0.0.0:9'), 'cleartext-transport')
    expectRelayError(() => assertOutboundRelayUrl('ws://192.168.1.9:9'), 'cleartext-transport')
  })

  it('rejects credentials placed on the relay url', () => {
    expectRelayError(() => assertOutboundRelayUrl('wss://user:tok-live@relay.example.invalid/v1'), 'plaintext')
    expectRelayError(() => assertOutboundRelayUrl('wss://relay.example.invalid/v1?accessToken=tok-live'), 'plaintext')
  })
})

describe('outbound websocket handshake', () => {
  const relays: LoopbackRelay[] = []

  afterEach(async () => {
    const pending = relays.splice(0)
    await Promise.all(pending.map(relay => relay.close()))
  })

  it('opens a session over loopback ws without listening on the client', async () => {
    const keys = generateDeviceKeyPair()
    const relay = await startLoopbackRelay({ store: authorizedStore(keys.publicKey), now: NOW })
    relays.push(relay)
    expect(relay.address).toBe('127.0.0.1')
    expect(relay.url.startsWith('ws://127.0.0.1:')).toBe(true)

    const envelope = createSignedHandshakeEnvelope({
      id: 'hs-1',
      sentAt: NOW,
      actor: ACTOR,
      keyPair: keys,
      nonce: 'nonce-1',
      capabilities: ['session.observe', 'session.prompt'],
    })
    const connection = await connectOutboundRelay({
      url: relay.url,
      accessToken: 'tok-live',
      envelope,
    })
    expect(connection.sessionId).toBe('sess:device-a:nonce-1')
    expect(connection.userId).toBe('user-a')
    expect(connection.deviceId).toBe('device-a')
    expect(connection.grantedCapabilities).toEqual(['session.observe', 'session.prompt'])
    expect(connection.ack.kind).toBe('handshake-ack')
    expect(JSON.stringify(connection.ack)).not.toContain(keys.privateKey)
    connection.close()
  })

  it('fails closed on the wire when the handshake key is not the registered device', async () => {
    const registered = generateDeviceKeyPair()
    const attacker = generateDeviceKeyPair()
    const relay = await startLoopbackRelay({ store: authorizedStore(registered.publicKey), now: NOW })
    relays.push(relay)
    await expectRelayErrorAsync(() => connectOutboundRelay({
      url: relay.url,
      accessToken: 'tok-live',
      envelope: createSignedHandshakeEnvelope({
        id: 'hs-1',
        sentAt: NOW,
        actor: ACTOR,
        keyPair: attacker,
        nonce: 'nonce-1',
        capabilities: ['session.observe'],
      }),
    }), 'untrusted-key')
  })
})
