import { describe, expect, it } from 'vitest'
import {
  RelayAuthorizationError,
  createSealedRelayEnvelope,
  createWebCryptoSealedRelayEnvelope,
  createSignedHandshakeEnvelope,
  generateDeviceKeyPair,
  openSealedRelayPayload,
  parseRelayEnvelope,
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

describe('device-sealed application payloads', () => {
  it('lets only the recipient open a sealed prompt', () => {
    const sender = generateDeviceKeyPair()
    const recipient = generateDeviceKeyPair()
    const stranger = generateDeviceKeyPair()
    const envelope = createSealedRelayEnvelope({
      id: 'msg-1',
      sentAt: NOW,
      actor: ACTOR,
      kind: 'prompt',
      sender,
      recipientEncryptionPublicKey: recipient.encryptionPublicKey,
      payload: { kind: 'prompt', sessionId: 'sess-1', text: SECRET },
    })

    const parsed = parseRelayEnvelope(envelope)
    expect(parsed.kind).toBe('prompt')
    expect(JSON.stringify(envelope)).not.toContain(SECRET)
    expect(parsed.ciphertext).not.toContain(sender.encryptionPrivateKey)
    expect(openSealedRelayPayload(envelope, recipient)).toEqual({
      kind: 'prompt',
      sessionId: 'sess-1',
      text: SECRET,
    })
    expectRelayError(() => openSealedRelayPayload(envelope, stranger), 'untrusted-key')
    expectRelayError(() => openSealedRelayPayload(envelope, sender), 'untrusted-key')
  })

  it('lets the recipient open a WebCrypto-sealed prompt', async () => {
    const sender = generateDeviceKeyPair()
    const recipient = generateDeviceKeyPair()
    const envelope = await createWebCryptoSealedRelayEnvelope({
      id: 'msg-webcrypto',
      sentAt: NOW,
      actor: ACTOR,
      kind: 'prompt',
      sender,
      recipientEncryptionPublicKey: recipient.encryptionPublicKey,
      payload: { kind: 'prompt', sessionId: 'sess-1', text: SECRET },
    })

    expect(JSON.stringify(envelope)).not.toContain(SECRET)
    expect(openSealedRelayPayload(envelope, recipient)).toEqual({
      kind: 'prompt',
      sessionId: 'sess-1',
      text: SECRET,
    })
  })

  it('seals approval and cancel frames for the same recipient', () => {
    const sender = generateDeviceKeyPair()
    const recipient = generateDeviceKeyPair()
    const approval = createSealedRelayEnvelope({
      id: 'msg-2',
      sentAt: NOW,
      actor: ACTOR,
      kind: 'approval',
      sender,
      recipientEncryptionPublicKey: recipient.encryptionPublicKey,
      payload: { kind: 'approval', sessionId: 'sess-1', requestId: 'req-1', approved: true },
    })
    const cancel = createSealedRelayEnvelope({
      id: 'msg-3',
      sentAt: NOW,
      actor: ACTOR,
      kind: 'cancel',
      sender,
      recipientEncryptionPublicKey: recipient.encryptionPublicKey,
      payload: { kind: 'cancel', sessionId: 'sess-1', requestId: 'req-1' },
    })
    expect(openSealedRelayPayload(approval, recipient)).toEqual({
      kind: 'approval',
      sessionId: 'sess-1',
      requestId: 'req-1',
      approved: true,
    })
    expect(openSealedRelayPayload(cancel, recipient)).toEqual({
      kind: 'cancel',
      sessionId: 'sess-1',
      requestId: 'req-1',
    })
  })

  it('fails closed when the box is mutated or carries plaintext field names', () => {
    const sender = generateDeviceKeyPair()
    const recipient = generateDeviceKeyPair()
    const envelope = createSealedRelayEnvelope({
      id: 'msg-4',
      sentAt: NOW,
      actor: ACTOR,
      kind: 'session-event',
      sender,
      recipientEncryptionPublicKey: recipient.encryptionPublicKey,
      payload: { kind: 'session-event', sessionId: 'sess-1', type: 'tool', detail: 'running' },
    })
    expectRelayError(() => openSealedRelayPayload({
      ...envelope,
      kind: 'prompt',
    }, recipient), 'untrusted-key')
    expectRelayError(() => createSealedRelayEnvelope({
      id: 'msg-5',
      sentAt: NOW,
      actor: ACTOR,
      kind: 'prompt',
      sender,
      recipientEncryptionPublicKey: recipient.encryptionPublicKey,
      payload: { kind: 'prompt', sessionId: 'sess-1', text: SECRET, prompt: SECRET } as never,
    }), 'plaintext')
  })

  it('refuses handshake ciphertext and a signing key used as an encryption key', () => {
    const sender = generateDeviceKeyPair()
    const recipient = generateDeviceKeyPair()
    const handshake = createSignedHandshakeEnvelope({
      id: 'hs-1',
      sentAt: NOW,
      actor: ACTOR,
      keyPair: sender,
      nonce: 'nonce-1',
      capabilities: ['session.prompt'],
    })
    expectRelayError(() => openSealedRelayPayload(handshake, recipient), 'malformed')
    expectRelayError(() => createSealedRelayEnvelope({
      id: 'msg-6',
      sentAt: NOW,
      actor: ACTOR,
      kind: 'prompt',
      sender,
      recipientEncryptionPublicKey: recipient.publicKey,
      payload: { kind: 'prompt', sessionId: 'sess-1', text: SECRET },
    }), 'untrusted-key')
  })

  it('refuses an empty sealed envelope id before encrypting', () => {
    const sender = generateDeviceKeyPair()
    const recipient = generateDeviceKeyPair()
    expectRelayError(() => createSealedRelayEnvelope({
      id: '',
      sentAt: NOW,
      actor: ACTOR,
      kind: 'prompt',
      sender,
      recipientEncryptionPublicKey: recipient.encryptionPublicKey,
      payload: { kind: 'prompt', sessionId: 'sess-1', text: SECRET },
    }), 'malformed')
  })
})
