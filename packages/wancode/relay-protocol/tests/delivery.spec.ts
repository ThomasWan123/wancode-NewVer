import { describe, expect, it } from 'vitest'
import {
  RelayAuthorizationError,
  acknowledgeRelayMailbox,
  createMemoryRelayAuditLog,
  createMemoryRelayMailbox,
  createMemoryRelayPresence,
  createMemoryRelayStore,
  createSealedRelayEnvelope,
  deliverRelayEnvelope,
  generateDeviceKeyPair,
  openSealedRelayPayload,
  parseRelayEnvelope,
  reclaimRelayMailbox,
  type DeviceKeyPair,
} from '../src/index.ts'

const NOW = 1_700_000_000_000
const ACTOR = { userId: 'user-a', deviceId: 'pwa-a' }
const SECRET = 'never-store-this-prompt-in-the-relay'

function expectRelayError(run: () => unknown, code: string): void {
  try {
    run()
    expect.unreachable('expected a relay authorization error')
  } catch (cause) {
    expect(cause).toBeInstanceOf(RelayAuthorizationError)
    expect((cause as RelayAuthorizationError).code).toBe(code)
  }
}

function sealedPrompt(
  recipient: DeviceKeyPair,
  id = 'msg-1',
  sender = generateDeviceKeyPair(),
): Record<string, unknown> {
  return createSealedRelayEnvelope({
    id,
    sentAt: NOW,
    actor: ACTOR,
    kind: 'prompt',
    sender,
    recipientEncryptionPublicKey: recipient.encryptionPublicKey,
    payload: { kind: 'prompt', sessionId: 'sess-1', text: SECRET },
  })
}

function authorizedStore() {
  const store = createMemoryRelayStore()
  store.putAccessToken({
    tokenId: 'tok-pwa',
    userId: 'user-a',
    deviceId: 'pwa-a',
    expiresAt: NOW + 60_000,
  })
  store.putAccessToken({
    tokenId: 'tok-desktop',
    userId: 'user-a',
    deviceId: 'desktop-a',
    expiresAt: NOW + 60_000,
  })
  store.putAccessToken({
    tokenId: 'tok-other',
    userId: 'user-b',
    deviceId: 'desktop-b',
    expiresAt: NOW + 60_000,
  })
  store.putDevice({ deviceId: 'pwa-a', userId: 'user-a', publicKey: 'pwa-a-public' })
  store.putDevice({ deviceId: 'desktop-a', userId: 'user-a', publicKey: 'desktop-a-public' })
  store.putDevice({ deviceId: 'desktop-b', userId: 'user-b', publicKey: 'desktop-b-public' })
  return store
}

describe('relay offline delivery and reconnect', () => {
  it('queues the same sealed box for an offline device until reclaim', () => {
    const store = authorizedStore()
    const mailbox = createMemoryRelayMailbox()
    const presence = createMemoryRelayPresence()
    const audit = createMemoryRelayAuditLog()
    const recipient = generateDeviceKeyPair()
    const envelope = sealedPrompt(recipient)
    expect(deliverRelayEnvelope({
      envelope,
      accessToken: 'tok-pwa',
      destinationDeviceId: 'desktop-a',
      store,
      mailbox,
      presence,
      now: NOW,
      audit,
    })).toEqual({
      envelopeId: 'msg-1',
      toDeviceId: 'desktop-a',
      outcome: 'queued',
    })
    const queued = reclaimRelayMailbox({
      accessToken: 'tok-desktop',
      deviceId: 'desktop-a',
      store,
      mailbox,
      now: NOW,
    })
    expect(queued).toEqual([parseRelayEnvelope(envelope)])
    expect(JSON.stringify(queued)).not.toContain(SECRET)
    expect(openSealedRelayPayload(queued[0], recipient)).toEqual({
      kind: 'prompt',
      sessionId: 'sess-1',
      text: SECRET,
    })
    expect(JSON.stringify(audit.list())).not.toMatch(/prompt|credential|toolOutput|ciphertext/u)
  })

  it('delivers live when the destination is online and does not queue', () => {
    const store = authorizedStore()
    const mailbox = createMemoryRelayMailbox()
    const presence = createMemoryRelayPresence()
    const recipient = generateDeviceKeyPair()
    const envelope = sealedPrompt(recipient)
    presence.setOnline('desktop-a', 'session-desktop')
    expect(deliverRelayEnvelope({
      envelope,
      accessToken: 'tok-pwa',
      destinationDeviceId: 'desktop-a',
      store,
      mailbox,
      presence,
      now: NOW,
    }).outcome).toBe('delivered')
    expect(reclaimRelayMailbox({
      accessToken: 'tok-desktop',
      deviceId: 'desktop-a',
      store,
      mailbox,
      now: NOW,
    })).toEqual([])
    expect(openSealedRelayPayload(envelope, recipient)).toEqual({
      kind: 'prompt',
      sessionId: 'sess-1',
      text: SECRET,
    })
  })

  it('pushes a sealed box through the live sink and does not queue', () => {
    const store = authorizedStore()
    const mailbox = createMemoryRelayMailbox()
    const presence = createMemoryRelayPresence()
    const recipient = generateDeviceKeyPair()
    const envelope = sealedPrompt(recipient)
    const pushed: Array<{ deviceId: string, envelope: ReturnType<typeof parseRelayEnvelope> }> = []
    presence.setOnline('desktop-a', 'session-desktop')
    expect(deliverRelayEnvelope({
      envelope,
      accessToken: 'tok-pwa',
      destinationDeviceId: 'desktop-a',
      store,
      mailbox,
      presence,
      now: NOW,
      live: {
        push(deviceId, next) {
          pushed.push({ deviceId, envelope: next })
          return true
        },
      },
    }).outcome).toBe('delivered')
    expect(pushed).toEqual([{ deviceId: 'desktop-a', envelope: parseRelayEnvelope(envelope) }])
    expect(JSON.stringify(pushed)).not.toContain(SECRET)
    expect(mailbox.list('desktop-a')).toEqual([])
  })

  it('queues when the destination is online but live push fails', () => {
    const store = authorizedStore()
    const mailbox = createMemoryRelayMailbox()
    const presence = createMemoryRelayPresence()
    const recipient = generateDeviceKeyPair()
    presence.setOnline('desktop-a', 'session-desktop')
    expect(deliverRelayEnvelope({
      envelope: sealedPrompt(recipient),
      accessToken: 'tok-pwa',
      destinationDeviceId: 'desktop-a',
      store,
      mailbox,
      presence,
      now: NOW,
      live: { push() { return false } },
    }).outcome).toBe('queued')
    expect(mailbox.list('desktop-a')).toHaveLength(1)
  })

  it('keeps reconnect drains identical until acknowledgement', () => {
    const store = authorizedStore()
    const mailbox = createMemoryRelayMailbox()
    const presence = createMemoryRelayPresence()
    const recipient = generateDeviceKeyPair()
    deliverRelayEnvelope({
      envelope: sealedPrompt(recipient),
      accessToken: 'tok-pwa',
      destinationDeviceId: 'desktop-a',
      store,
      mailbox,
      presence,
      now: NOW,
    })
    const first = reclaimRelayMailbox({
      accessToken: 'tok-desktop',
      deviceId: 'desktop-a',
      store,
      mailbox,
      now: NOW + 1,
    })
    const retry = reclaimRelayMailbox({
      accessToken: 'tok-desktop',
      deviceId: 'desktop-a',
      store,
      mailbox,
      now: NOW + 2,
    })
    expect(retry).toEqual(first)
    expect(openSealedRelayPayload(first[0], recipient)).toEqual({
      kind: 'prompt',
      sessionId: 'sess-1',
      text: SECRET,
    })
    acknowledgeRelayMailbox({
      accessToken: 'tok-desktop',
      deviceId: 'desktop-a',
      envelopeId: 'msg-1',
      store,
      mailbox,
      now: NOW + 3,
    })
    expect(reclaimRelayMailbox({
      accessToken: 'tok-desktop',
      deviceId: 'desktop-a',
      store,
      mailbox,
      now: NOW + 4,
    })).toEqual([])
    expect(acknowledgeRelayMailbox({
      accessToken: 'tok-desktop',
      deviceId: 'desktop-a',
      envelopeId: 'msg-1',
      store,
      mailbox,
      now: NOW + 5,
    }).outcome).toBe('duplicate')
  })

  it('does not duplicate a queued envelope on an identical retry', () => {
    const store = authorizedStore()
    const mailbox = createMemoryRelayMailbox()
    const presence = createMemoryRelayPresence()
    const envelope = sealedPrompt(generateDeviceKeyPair())
    const first = deliverRelayEnvelope({
      envelope,
      accessToken: 'tok-pwa',
      destinationDeviceId: 'desktop-a',
      store,
      mailbox,
      presence,
      now: NOW,
    })
    const retry = deliverRelayEnvelope({
      envelope,
      accessToken: 'tok-pwa',
      destinationDeviceId: 'desktop-a',
      store,
      mailbox,
      presence,
      now: NOW + 1,
    })
    expect(first.outcome).toBe('queued')
    expect(retry.outcome).toBe('duplicate')
    expect(reclaimRelayMailbox({
      accessToken: 'tok-desktop',
      deviceId: 'desktop-a',
      store,
      mailbox,
      now: NOW + 2,
    })).toHaveLength(1)
  })

  it('refuses reclaim after expiry, revocation, or a cross-account token', () => {
    const store = authorizedStore()
    const mailbox = createMemoryRelayMailbox()
    const presence = createMemoryRelayPresence()
    deliverRelayEnvelope({
      envelope: sealedPrompt(generateDeviceKeyPair()),
      accessToken: 'tok-pwa',
      destinationDeviceId: 'desktop-a',
      store,
      mailbox,
      presence,
      now: NOW,
    })
    store.putDevice({
      deviceId: 'desktop-a',
      userId: 'user-a',
      publicKey: 'desktop-a-public',
      revokedAt: NOW + 10,
    })
    expectRelayError(() => reclaimRelayMailbox({
      accessToken: 'tok-desktop',
      deviceId: 'desktop-a',
      store,
      mailbox,
      now: NOW + 10,
    }), 'revoked-device')
    expect(reclaimRelayMailbox({
      accessToken: 'tok-desktop',
      deviceId: 'desktop-a',
      store,
      mailbox,
      now: NOW,
    })).toEqual([])
    store.putDevice({ deviceId: 'desktop-a', userId: 'user-a', publicKey: 'desktop-a-public' })
    expectRelayError(() => reclaimRelayMailbox({
      accessToken: 'tok-other',
      deviceId: 'desktop-a',
      store,
      mailbox,
      now: NOW,
    }), 'cross-account')
    expectRelayError(() => reclaimRelayMailbox({
      accessToken: 'tok-desktop',
      deviceId: 'desktop-a',
      store,
      mailbox,
      now: NOW + 120_000,
    }), 'expired-token')
  })
})
