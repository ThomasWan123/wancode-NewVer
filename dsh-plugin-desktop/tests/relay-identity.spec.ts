import { describe, expect, it, vi } from 'vitest'
import {
  RelayAuthorizationError,
  createSealedRelayEnvelope,
  createStoredDeviceIdentity,
  openSealedRelayPayload,
  parseStoredDeviceIdentity,
} from '@wancode/relay-protocol'
import { credentialTarget, type CredentialStore } from '../src/credentials-win.ts'
import {
  RELAY_DEVICE_CREDENTIAL_REF,
  loadDesktopRelayIdentity,
} from '../src/relay-identity.ts'
import { prepareDesktopRelay, openDesktopRelaySession, openDesktopRelayMailbox, type Config as RelayConfig } from '../src/relay.ts'

class MemoryStore implements CredentialStore {
  readonly values = new Map<string, string>()

  get(target: string): string | undefined {
    return this.values.get(target)
  }

  set(target: string, value: string): void {
    this.values.set(target, value)
  }

  delete(target: string): boolean {
    return this.values.delete(target)
  }
}

function idleConfig(overrides: Partial<RelayConfig> = {}): RelayConfig {
  return { enabled: false, url: '', ...overrides }
}

describe('desktop relay device identity', () => {
  it('stores a generated identity in Credential Manager and reloads the same public fields', () => {
    const store = new MemoryStore()
    const home = 'C:\\Wancode\\harness'
    const first = loadDesktopRelayIdentity({ home, store })
    const raw = store.get(credentialTarget(home, RELAY_DEVICE_CREDENTIAL_REF))
    expect(raw).toBeDefined()
    const stored = parseStoredDeviceIdentity(raw as string)

    expect(first.deviceId).toBe(stored.deviceId)
    expect(first.publicKey).toBe(stored.keyPair.publicKey)
    expect(first.encryptionPublicKey).toBe(stored.keyPair.encryptionPublicKey)
    expect(JSON.stringify(first)).not.toContain(stored.keyPair.privateKey)
    expect(JSON.stringify(first)).not.toContain(stored.keyPair.encryptionPrivateKey)
    expect(raw).toContain(stored.keyPair.privateKey)

    const handshake = first.createHandshake({
      id: 'hs-1',
      sentAt: 1_700_000_000_000,
      userId: 'user-a',
      nonce: 'nonce-1',
      capabilities: ['session.prompt'],
    })
    expect(handshake).toEqual(expect.objectContaining({
      protocolVersion: 1,
      id: 'hs-1',
      kind: 'handshake',
    }))
    expect(JSON.stringify(handshake)).not.toContain(stored.keyPair.privateKey)

    const second = loadDesktopRelayIdentity({ home, store })
    expect(second.deviceId).toBe(first.deviceId)
    expect(second.publicKey).toBe(first.publicKey)
    expect(store.values.size).toBe(1)
  })

  it('refuses a mutated stored identity and never enrolls from it', () => {
    const store = new MemoryStore()
    const home = 'C:\\Wancode\\harness'
    const identity = loadDesktopRelayIdentity({ home, store })
    const target = credentialTarget(home, RELAY_DEVICE_CREDENTIAL_REF)
    const stored = parseStoredDeviceIdentity(store.get(target) as string)
    store.set(target, JSON.stringify({
      protocolVersion: 1,
      deviceId: identity.deviceId,
      publicKey: stored.keyPair.publicKey,
      privateKey: stored.keyPair.privateKey,
      encryptionPublicKey: stored.keyPair.encryptionPublicKey,
      encryptionPrivateKey: stored.keyPair.encryptionPrivateKey,
      prompt: 'delete all files',
    }))
    try {
      loadDesktopRelayIdentity({ home, store })
      expect.unreachable('expected a relay authorization error')
    } catch (cause) {
      expect(cause).toBeInstanceOf(RelayAuthorizationError)
      expect((cause as RelayAuthorizationError).code).toBe('plaintext')
    }
  })

  it('enrolls the stored public identity without opening a socket', async () => {
    const store = new MemoryStore()
    const identity = loadDesktopRelayIdentity({ home: 'C:\\Wancode\\harness', store })
    const connect = vi.fn()
    const register = vi.fn(async () => ({
      deviceId: identity.deviceId,
      userId: 'user-a',
      publicKey: identity.publicKey,
      encryptionPublicKey: identity.encryptionPublicKey,
    }))
    const handle = prepareDesktopRelay(idleConfig({
      enabled: true,
      url: 'wss://relay.example.invalid/v1',
    }), connect, {
      register,
      issueToken: vi.fn(),
      revoke: vi.fn(),
      listDevices: vi.fn(),
    })

    await expect(handle?.enroll({
      assertion: { sub: 'user-a' },
      identity,
    })).resolves.toEqual({
      deviceId: identity.deviceId,
      userId: 'user-a',
      publicKey: identity.publicKey,
      encryptionPublicKey: identity.encryptionPublicKey,
    })
    expect(register).toHaveBeenCalledWith({
      httpUrl: 'https://relay.example.invalid/',
      assertion: { sub: 'user-a' },
      deviceId: identity.deviceId,
      publicKey: identity.publicKey,
      encryptionPublicKey: identity.encryptionPublicKey,
    })
    expect(connect).not.toHaveBeenCalled()
  })

  it('enrolls, mints a token, and dials without exposing private keys', async () => {
    const store = new MemoryStore()
    const identity = loadDesktopRelayIdentity({ home: 'C:\\Wancode\\harness', store })
    const connection = {
      sessionId: 'sess-1',
      userId: 'user-a',
      deviceId: identity.deviceId,
      grantedCapabilities: ['session.prompt'],
      send: vi.fn(),
      reclaim: vi.fn(),
      receive: vi.fn(),
      acknowledge: vi.fn(),
      close: vi.fn(),
    }
    const connect = vi.fn(async () => connection)
    const register = vi.fn(async () => ({
      deviceId: identity.deviceId,
      userId: 'user-a',
      publicKey: identity.publicKey,
      encryptionPublicKey: identity.encryptionPublicKey,
    }))
    const issueToken = vi.fn(async () => ({
      accessToken: 'tok-live',
      expiresAt: 1_700_000_900_000,
    }))
    const handle = prepareDesktopRelay(idleConfig({
      enabled: true,
      url: 'wss://relay.example.invalid/v1',
    }), connect, {
      register,
      issueToken,
      revoke: vi.fn(),
      listDevices: vi.fn(),
    })
    expect(handle).toBeDefined()
    const opened = await openDesktopRelaySession({
      handle: handle!,
      identity,
      assertion: { sub: 'user-a' },
      userId: 'user-a',
      nonce: 'nonce-1',
      now: 1_700_000_000_000,
    })
    expect(opened).toBe(connection)
    expect(register).toHaveBeenCalledOnce()
    expect(issueToken).toHaveBeenCalledWith({
      httpUrl: 'https://relay.example.invalid/',
      assertion: { sub: 'user-a' },
      deviceId: identity.deviceId,
    })
    expect(connect).toHaveBeenCalledWith({
      accessToken: 'tok-live',
      envelope: identity.createHandshake({
        id: `hs:${identity.deviceId}:nonce-1`,
        sentAt: 1_700_000_000_000,
        userId: 'user-a',
        nonce: 'nonce-1',
        capabilities: ['session.observe', 'session.prompt', 'session.approve', 'session.cancel'],
      }),
      url: 'wss://relay.example.invalid/v1',
    })
    handle?.dispose()
  })

  it('mints a handshake nonce when none is supplied', async () => {
    const store = new MemoryStore()
    const identity = loadDesktopRelayIdentity({ home: 'C:\\Wancode\\harness', store })
    const connect = vi.fn(async () => ({
      sessionId: 'sess-1',
      userId: 'user-a',
      deviceId: identity.deviceId,
      grantedCapabilities: ['session.prompt'],
      send: vi.fn(),
      reclaim: vi.fn(),
      receive: vi.fn(),
      acknowledge: vi.fn(),
      close: vi.fn(),
    }))
    const handle = prepareDesktopRelay(idleConfig({
      enabled: true,
      url: 'wss://relay.example.invalid/v1',
    }), connect, {
      register: vi.fn(async () => ({
        deviceId: identity.deviceId,
        userId: 'user-a',
        publicKey: identity.publicKey,
        encryptionPublicKey: identity.encryptionPublicKey,
      })),
      issueToken: vi.fn(async () => ({
        accessToken: 'tok-live',
        expiresAt: 1_700_000_900_000,
      })),
      revoke: vi.fn(),
      listDevices: vi.fn(),
    })
    await openDesktopRelaySession({
      handle: handle!,
      identity,
      assertion: { sub: 'user-a' },
      userId: 'user-a',
      now: 1_700_000_000_000,
    })
    expect(connect).toHaveBeenCalledOnce()
    const call = connect.mock.calls[0] as unknown as [{ envelope: { id: string } }]
    expect(call[0].envelope.id).toMatch(new RegExp(`^hs:${identity.deviceId}:[0-9a-f]+$`))
    handle?.dispose()
  })

  it('applies sealed PWA mail after opening a desktop session', async () => {
    const store = new MemoryStore()
    const identity = loadDesktopRelayIdentity({ home: 'C:\\Wancode\\harness', store })
    const pwa = createStoredDeviceIdentity()
    const secret = 'review the login form'
    const envelope = createSealedRelayEnvelope({
      id: 'msg-1',
      sentAt: 1_700_000_000_000,
      actor: { userId: 'user-a', deviceId: pwa.deviceId },
      kind: 'prompt',
      sender: pwa.keyPair,
      recipientEncryptionPublicKey: identity.encryptionPublicKey,
      payload: {
        kind: 'prompt',
        sessionId: 'sess-1',
        text: secret,
      },
    })
    const prompt = vi.fn(async () => undefined)
    const acknowledge = vi.fn(async () => ({
      envelopeId: 'msg-1',
      toDeviceId: identity.deviceId,
      outcome: 'delivered' as const,
    }))
    const handle = prepareDesktopRelay(
      idleConfig({
        enabled: true,
        url: 'wss://relay.example.invalid/v1',
      }),
      vi.fn(async () => ({
        sessionId: 'sess-1',
        userId: 'user-a',
        deviceId: identity.deviceId,
        grantedCapabilities: ['session.prompt'],
        send: vi.fn(),
        reclaim: vi.fn(async () => [envelope]),
        receive: vi.fn(async () => []),
        acknowledge,
        close: vi.fn(),
      })),
      {
        register: vi.fn(async () => ({
          deviceId: identity.deviceId,
          userId: 'user-a',
          publicKey: identity.publicKey,
          encryptionPublicKey: identity.encryptionPublicKey,
        })),
        issueToken: vi.fn(async () => ({
          accessToken: 'tok-live',
          expiresAt: 1_700_000_900_000,
        })),
        revoke: vi.fn(),
        listDevices: vi.fn(),
      },
      undefined,
      {
        get(name) {
          return name === 'sessions'
            ? { get: (sessionId: string) => sessionId === 'sess-1' ? { prompt } : undefined }
            : undefined
        },
      },
    )
    await expect(openDesktopRelayMailbox({
      handle: handle!,
      identity,
      assertion: { sub: 'user-a' },
      userId: 'user-a',
      nonce: 'nonce-mail',
      now: 1_700_000_000_000,
    })).resolves.toEqual({
      applied: 1,
      ignored: 0,
    })
    expect(prompt).toHaveBeenCalledWith(
      [{ type: 'text', text: secret }],
      'queue',
    )
    expect(acknowledge).toHaveBeenCalledWith({ envelopeId: 'msg-1' })
    handle?.dispose()
  })

  it('does not ack PWA mail when the Host session is missing', async () => {
    const store = new MemoryStore()
    const identity = loadDesktopRelayIdentity({ home: 'C:\\Wancode\\harness', store })
    const pwa = createStoredDeviceIdentity()
    const envelope = createSealedRelayEnvelope({
      id: 'msg-missing',
      sentAt: 1_700_000_000_000,
      actor: { userId: 'user-a', deviceId: pwa.deviceId },
      kind: 'prompt',
      sender: pwa.keyPair,
      recipientEncryptionPublicKey: identity.encryptionPublicKey,
      payload: {
        kind: 'prompt',
        sessionId: 'sess-missing',
        text: 'review the login form',
      },
    })
    const acknowledge = vi.fn()
    const handle = prepareDesktopRelay(
      idleConfig({
        enabled: true,
        url: 'wss://relay.example.invalid/v1',
      }),
      vi.fn(async () => ({
        sessionId: 'sess-1',
        userId: 'user-a',
        deviceId: identity.deviceId,
        grantedCapabilities: ['session.prompt'],
        send: vi.fn(),
        reclaim: vi.fn(async () => [envelope]),
        receive: vi.fn(async () => []),
        acknowledge,
        close: vi.fn(),
      })),
      {
        register: vi.fn(async () => ({
          deviceId: identity.deviceId,
          userId: 'user-a',
          publicKey: identity.publicKey,
          encryptionPublicKey: identity.encryptionPublicKey,
        })),
        issueToken: vi.fn(async () => ({
          accessToken: 'tok-live',
          expiresAt: 1_700_000_900_000,
        })),
        revoke: vi.fn(),
        listDevices: vi.fn(),
      },
      undefined,
      {
        get() {
          return undefined
        },
      },
    )
    try {
      await openDesktopRelayMailbox({
        handle: handle!,
        identity,
        assertion: { sub: 'user-a' },
        userId: 'user-a',
        nonce: 'nonce-missing',
        now: 1_700_000_000_000,
      })
      expect.unreachable('expected a relay authorization error')
    } catch (cause) {
      expect(cause).toBeInstanceOf(RelayAuthorizationError)
      expect((cause as RelayAuthorizationError).code).toBe('malformed')
    }
    expect(acknowledge).not.toHaveBeenCalled()
    handle?.dispose()
  })

  it('refuses to open a desktop session without a handshake nonce', async () => {
    const store = new MemoryStore()
    const identity = loadDesktopRelayIdentity({ home: 'C:\\Wancode\\harness', store })
    const handle = prepareDesktopRelay(idleConfig({
      enabled: true,
      url: 'wss://relay.example.invalid/v1',
    }), vi.fn(), {
      register: vi.fn(),
      issueToken: vi.fn(),
      revoke: vi.fn(),
      listDevices: vi.fn(),
    })
    try {
      await openDesktopRelaySession({
        handle: handle!,
        identity,
        assertion: { sub: 'user-a' },
        userId: 'user-a',
        nonce: '',
      })
      expect.unreachable('expected a relay authorization error')
    } catch (cause) {
      expect(cause).toBeInstanceOf(RelayAuthorizationError)
      expect((cause as RelayAuthorizationError).code).toBe('malformed')
    }
  })

  it('refuses to open a desktop session without a handshake nonce', async () => {
    const store = new MemoryStore()
    const identity = loadDesktopRelayIdentity({ home: 'C:\\Wancode\\harness', store })
    const handle = prepareDesktopRelay(idleConfig({
      enabled: true,
      url: 'wss://relay.example.invalid/v1',
    }), vi.fn(), {
      register: vi.fn(),
      issueToken: vi.fn(),
      revoke: vi.fn(),
      listDevices: vi.fn(),
    })
    try {
      await openDesktopRelaySession({
        handle: handle!,
        identity,
        assertion: { sub: 'user-a' },
        userId: 'user-a',
        nonce: '',
      })
      expect.unreachable('expected a relay authorization error')
    } catch (cause) {
      expect(cause).toBeInstanceOf(RelayAuthorizationError)
      expect((cause as RelayAuthorizationError).code).toBe('malformed')
    }
  })

  it('opens a sealed PWA follow-up without exposing private keys', () => {
    const store = new MemoryStore()
    const desktop = loadDesktopRelayIdentity({ home: 'C:\\Wancode\\harness', store })
    const pwa = createStoredDeviceIdentity()
    const secret = 'review the login form'
    const envelope = createSealedRelayEnvelope({
      id: 'msg-1',
      sentAt: 1_700_000_000_000,
      actor: { userId: 'user-a', deviceId: pwa.deviceId },
      kind: 'prompt',
      sender: pwa.keyPair,
      recipientEncryptionPublicKey: desktop.encryptionPublicKey,
      payload: {
        kind: 'prompt',
        sessionId: 'sess-1',
        text: secret,
      },
    })
    expect(desktop.openSealed(envelope)).toEqual({
      kind: 'prompt',
      sessionId: 'sess-1',
      text: secret,
    })
    expect(JSON.stringify(desktop)).not.toContain(parseStoredDeviceIdentity(
      store.get(credentialTarget('C:\\Wancode\\harness', RELAY_DEVICE_CREDENTIAL_REF)) as string,
    ).keyPair.privateKey)
    expect(JSON.stringify(envelope)).not.toContain(secret)
  })

  it('seals a session event to a PWA without exposing private keys', () => {
    const store = new MemoryStore()
    const desktop = loadDesktopRelayIdentity({ home: 'C:\\Wancode\\harness', store })
    const pwa = createStoredDeviceIdentity()
    const detail = 'Looking at the form'
    const envelope = desktop.sealTo({
      id: 'evt-1',
      sentAt: 1_700_000_000_000,
      userId: 'user-a',
      recipientEncryptionPublicKey: pwa.keyPair.encryptionPublicKey,
      payload: {
        kind: 'session-event',
        sessionId: 'sess-1',
        type: 'assistant.delta',
        detail,
      },
    })
    expect(openSealedRelayPayload(envelope, pwa.keyPair)).toEqual({
      kind: 'session-event',
      sessionId: 'sess-1',
      type: 'assistant.delta',
      detail,
    })
    expect(JSON.stringify(envelope)).not.toContain(detail)
    expect(JSON.stringify(desktop)).not.toContain(parseStoredDeviceIdentity(
      store.get(credentialTarget('C:\\Wancode\\harness', RELAY_DEVICE_CREDENTIAL_REF)) as string,
    ).keyPair.privateKey)
    try {
      desktop.openSealed(envelope)
      expect.unreachable('expected a relay authorization error')
    } catch (cause) {
      expect(cause).toBeInstanceOf(RelayAuthorizationError)
      expect((cause as RelayAuthorizationError).code).toBe('untrusted-key')
    }
  })
})
