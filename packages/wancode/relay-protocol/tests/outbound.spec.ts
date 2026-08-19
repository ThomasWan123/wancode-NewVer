import { afterEach, describe, expect, it } from 'vitest'
import {
  RelayAuthorizationError,
  assertOutboundRelayUrl,
  connectOutboundRelay,
  createMemoryRelayStore,
  createSealedRelayEnvelope,
  createSignedHandshakeEnvelope,
  generateDeviceKeyPair,
  openSealedRelayPayload,
  parseRelayWireCommand,
  revokeRelayDevice,
} from '../src/index.ts'
import { startLoopbackRelay, type LoopbackRelay } from '../src/loopback.ts'

const NOW = 1_700_000_000_000
const ACTOR = { userId: 'user-a', deviceId: 'device-a' }
const DEST = { userId: 'user-a', deviceId: 'desktop-b' }

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

function withDestination(store: ReturnType<typeof createMemoryRelayStore>, publicKey: string) {
  store.putAccessToken({
    tokenId: 'tok-desktop',
    userId: DEST.userId,
    deviceId: DEST.deviceId,
    expiresAt: NOW + 60_000,
  })
  store.putDevice({
    deviceId: DEST.deviceId,
    userId: DEST.userId,
    publicKey,
  })
  return store
}

async function waitUntilOffline(relay: LoopbackRelay, deviceId: string): Promise<void> {
  const deadline = Date.now() + 2_000
  while (relay.presence.isOnline(deviceId)) {
    if (Date.now() >= deadline) {
      throw new Error(`${deviceId} stayed online after socket close`)
    }
    await new Promise(resolve => setTimeout(resolve, 10))
  }
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

  it('queues a sealed application frame on the same loopback socket', async () => {
    const sender = generateDeviceKeyPair()
    const recipient = generateDeviceKeyPair()
    const store = authorizedStore(sender.publicKey)
    store.putDevice({
      deviceId: 'desktop-b',
      userId: ACTOR.userId,
      publicKey: recipient.publicKey,
    })
    const relay = await startLoopbackRelay({ store, now: NOW })
    relays.push(relay)
    const connection = await connectOutboundRelay({
      url: relay.url,
      accessToken: 'tok-live',
      envelope: createSignedHandshakeEnvelope({
        id: 'hs-1',
        sentAt: NOW,
        actor: ACTOR,
        keyPair: sender,
        nonce: 'nonce-1',
        capabilities: ['session.prompt'],
      }),
    })
    const secret = 'never-store-this-prompt-in-the-relay'
    const envelope = createSealedRelayEnvelope({
      id: 'msg-1',
      sentAt: NOW,
      actor: ACTOR,
      kind: 'prompt',
      sender,
      recipientEncryptionPublicKey: recipient.encryptionPublicKey,
      payload: { kind: 'prompt', sessionId: 'sess-1', text: secret },
    })
    expect(await connection.send({
      envelope,
      destinationDeviceId: 'desktop-b',
    })).toEqual({
      envelopeId: 'msg-1',
      toDeviceId: 'desktop-b',
      outcome: 'queued',
    })
    const queued = relay.mailbox.list('desktop-b')
    expect(JSON.stringify(queued)).not.toContain(secret)
    expect(openSealedRelayPayload(queued[0], recipient)).toEqual({
      kind: 'prompt',
      sessionId: 'sess-1',
      text: secret,
    })
    await expectRelayErrorAsync(() => connection.send({
      envelope: {
        protocolVersion: 1,
        id: 'msg-2',
        kind: 'prompt',
        sentAt: NOW,
        actor: ACTOR,
        ciphertext: 'v1:opaque-ciphertext',
      },
      destinationDeviceId: 'desktop-b',
    }), 'malformed')
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

  it('drains and acknowledges queued mail on the destination socket', async () => {
    const sender = generateDeviceKeyPair()
    const recipient = generateDeviceKeyPair()
    const store = withDestination(authorizedStore(sender.publicKey), recipient.publicKey)
    const relay = await startLoopbackRelay({ store, now: NOW })
    relays.push(relay)
    const source = await connectOutboundRelay({
      url: relay.url,
      accessToken: 'tok-live',
      envelope: createSignedHandshakeEnvelope({
        id: 'hs-1',
        sentAt: NOW,
        actor: ACTOR,
        keyPair: sender,
        nonce: 'nonce-1',
        capabilities: ['session.prompt'],
      }),
    })
    const secret = 'never-store-this-prompt-in-the-relay'
    expect(await source.send({
      envelope: createSealedRelayEnvelope({
        id: 'msg-1',
        sentAt: NOW,
        actor: ACTOR,
        kind: 'prompt',
        sender,
        recipientEncryptionPublicKey: recipient.encryptionPublicKey,
        payload: { kind: 'prompt', sessionId: 'sess-1', text: secret },
      }),
      destinationDeviceId: DEST.deviceId,
    })).toEqual({
      envelopeId: 'msg-1',
      toDeviceId: DEST.deviceId,
      outcome: 'queued',
    })
    source.close()

    const destination = await connectOutboundRelay({
      url: relay.url,
      accessToken: 'tok-desktop',
      envelope: createSignedHandshakeEnvelope({
        id: 'hs-2',
        sentAt: NOW,
        actor: DEST,
        keyPair: recipient,
        nonce: 'nonce-2',
        capabilities: ['session.observe'],
      }),
    })
    const first = await destination.reclaim()
    const second = await destination.reclaim()
    expect(first).toHaveLength(1)
    expect(second).toEqual(first)
    expect(JSON.stringify(first)).not.toContain(secret)
    expect(openSealedRelayPayload(first[0], recipient)).toEqual({
      kind: 'prompt',
      sessionId: 'sess-1',
      text: secret,
    })
    expect(await destination.acknowledge({ envelopeId: 'msg-1' })).toEqual({
      envelopeId: 'msg-1',
      toDeviceId: DEST.deviceId,
      outcome: 'delivered',
    })
    expect(await destination.reclaim()).toEqual([])
    expect(relay.presence.isOnline(DEST.deviceId)).toBe(true)
    destination.close()
    await waitUntilOffline(relay, DEST.deviceId)
  })

  it('pushes a sealed box to the live destination socket', async () => {
    const sender = generateDeviceKeyPair()
    const recipient = generateDeviceKeyPair()
    const store = withDestination(authorizedStore(sender.publicKey), recipient.publicKey)
    const relay = await startLoopbackRelay({ store, now: NOW })
    relays.push(relay)
    const destination = await connectOutboundRelay({
      url: relay.url,
      accessToken: 'tok-desktop',
      envelope: createSignedHandshakeEnvelope({
        id: 'hs-2',
        sentAt: NOW,
        actor: DEST,
        keyPair: recipient,
        nonce: 'nonce-2',
        capabilities: ['session.observe'],
      }),
    })
    const source = await connectOutboundRelay({
      url: relay.url,
      accessToken: 'tok-live',
      envelope: createSignedHandshakeEnvelope({
        id: 'hs-1',
        sentAt: NOW,
        actor: ACTOR,
        keyPair: sender,
        nonce: 'nonce-1',
        capabilities: ['session.prompt'],
      }),
    })
    const secret = 'never-store-this-prompt-in-the-relay'
    expect(await source.send({
      envelope: createSealedRelayEnvelope({
        id: 'msg-live',
        sentAt: NOW,
        actor: ACTOR,
        kind: 'prompt',
        sender,
        recipientEncryptionPublicKey: recipient.encryptionPublicKey,
        payload: { kind: 'prompt', sessionId: 'sess-1', text: secret },
      }),
      destinationDeviceId: DEST.deviceId,
    })).toEqual({
      envelopeId: 'msg-live',
      toDeviceId: DEST.deviceId,
      outcome: 'delivered',
    })
    expect(relay.mailbox.list(DEST.deviceId)).toEqual([])
    const mail = await destination.receive()
    expect(JSON.stringify(mail)).not.toContain(secret)
    expect(openSealedRelayPayload(mail[0], recipient)).toEqual({
      kind: 'prompt',
      sessionId: 'sess-1',
      text: secret,
    })
    source.close()
    destination.close()
  })

  it('fails closed when reclaim is revoked, expired, or cross-account', async () => {
    const sender = generateDeviceKeyPair()
    const recipient = generateDeviceKeyPair()
    const store = withDestination(authorizedStore(sender.publicKey), recipient.publicKey)
    const relay = await startLoopbackRelay({ store, now: NOW })
    relays.push(relay)
    const source = await connectOutboundRelay({
      url: relay.url,
      accessToken: 'tok-live',
      envelope: createSignedHandshakeEnvelope({
        id: 'hs-1',
        sentAt: NOW,
        actor: ACTOR,
        keyPair: sender,
        nonce: 'nonce-1',
        capabilities: ['session.prompt'],
      }),
    })
    await source.send({
      envelope: createSealedRelayEnvelope({
        id: 'msg-1',
        sentAt: NOW,
        actor: ACTOR,
        kind: 'prompt',
        sender,
        recipientEncryptionPublicKey: recipient.encryptionPublicKey,
        payload: { kind: 'prompt', sessionId: 'sess-1', text: 'queued-secret' },
      }),
      destinationDeviceId: DEST.deviceId,
    })
    source.close()

    const destination = await connectOutboundRelay({
      url: relay.url,
      accessToken: 'tok-desktop',
      envelope: createSignedHandshakeEnvelope({
        id: 'hs-2',
        sentAt: NOW,
        actor: DEST,
        keyPair: recipient,
        nonce: 'nonce-2',
        capabilities: ['session.observe'],
      }),
    })
    store.putAccessToken({
      tokenId: 'tok-desktop',
      userId: 'user-b',
      deviceId: DEST.deviceId,
      expiresAt: NOW + 60_000,
    })
    await expectRelayErrorAsync(() => destination.reclaim(), 'cross-account')
    store.putAccessToken({
      tokenId: 'tok-desktop',
      userId: DEST.userId,
      deviceId: DEST.deviceId,
      expiresAt: NOW,
    })
    await expectRelayErrorAsync(() => destination.reclaim(), 'expired-token')
    store.putAccessToken({
      tokenId: 'tok-desktop',
      userId: DEST.userId,
      deviceId: DEST.deviceId,
      expiresAt: NOW + 60_000,
    })
    revokeRelayDevice({
      deviceId: DEST.deviceId,
      userId: DEST.userId,
      store,
      now: NOW,
    })
    await expectRelayErrorAsync(() => destination.reclaim(), 'revoked-device')
    destination.close()
  })
})

describe('relay wire mailbox commands', () => {
  it('parses reclaim and ack without a client-chosen device id', () => {
    expect(parseRelayWireCommand({
      accessToken: 'tok-desktop',
      action: 'reclaim',
    })).toEqual({ kind: 'reclaim', accessToken: 'tok-desktop' })
    expect(parseRelayWireCommand({
      accessToken: 'tok-desktop',
      action: 'ack',
      envelopeId: 'msg-1',
    })).toEqual({
      kind: 'ack',
      accessToken: 'tok-desktop',
      envelopeId: 'msg-1',
    })
    expect(parseRelayWireCommand({
      accessToken: 'tok-live',
      destinationDeviceId: 'desktop-b',
      envelope: { protocolVersion: 1, id: 'msg-1', kind: 'prompt' },
    }).kind).toBe('deliver')
  })

  it('rejects mixed reclaim fields, missing ack ids, and unknown actions', () => {
    expectRelayError(() => parseRelayWireCommand({
      accessToken: 'tok-desktop',
      action: 'reclaim',
      destinationDeviceId: 'desktop-b',
    }), 'malformed')
    expectRelayError(() => parseRelayWireCommand({
      accessToken: 'tok-desktop',
      action: 'ack',
    }), 'malformed')
    expectRelayError(() => parseRelayWireCommand({
      accessToken: 'tok-desktop',
      action: 'listen',
    }), 'malformed')
  })
})
