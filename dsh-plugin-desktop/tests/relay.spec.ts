import type { Context } from '@deepseek-ai/cordis'
import { describe, expect, it, vi } from 'vitest'
import {
  apply,
  applyDesktopRelayPayloads,
  createDesktopRelayApprovalSink,
  createDesktopRelayCancelSink,
  createDesktopRelayFollowUpSink,
  drainDesktopRelayMail,
  MAX_DESKTOP_RELAY_FOLLOW_UP_CHARS,
  MAX_DESKTOP_RELAY_PROGRESS_DETAIL_CHARS,
  prepareDesktopRelay,
  processDesktopRelayMail,
  sealDesktopRelaySessionEvent,
  sendDesktopRelaySessionEvent,
  sealDesktopRelayPresence,
  sendDesktopRelayPresence,
  type Config as RelayConfig,
} from '../src/relay.ts'

function expectRelayError(run: () => unknown, code: string): void {
  try {
    run()
    expect.unreachable('expected a relay authorization error')
  } catch (cause) {
    expect((cause as { code?: string }).code).toBe(code)
  }
}

function idleConfig(overrides: Partial<RelayConfig> = {}): RelayConfig {
  return { enabled: false, url: '', ...overrides }
}

describe('desktop outbound relay Host plugin', () => {
  it('stays idle when disabled or when no URL is configured', () => {
    expect(prepareDesktopRelay(idleConfig())).toBeUndefined()
    expect(prepareDesktopRelay(idleConfig({ enabled: true }))).toBeUndefined()
    const effect = vi.fn()
    apply({ effect } as unknown as Context, idleConfig())
    expect(effect).not.toHaveBeenCalled()
  })

  it('refuses a cleartext non-loopback URL and does not open a socket', () => {
    const connect = vi.fn()
    expectRelayError(
      () => prepareDesktopRelay(idleConfig({
        enabled: true,
        url: 'ws://relay.example.invalid/v1',
      }), connect),
      'cleartext-transport',
    )
    expect(connect).not.toHaveBeenCalled()
  })

  it('prepares a wss URL without dialing until connect runs', async () => {
    const connection = {
      sessionId: 'sess-1',
      userId: 'user-a',
      deviceId: 'device-a',
      grantedCapabilities: ['session.prompt'],
      send: vi.fn(),
      reclaim: vi.fn(),
      receive: vi.fn(),
      acknowledge: vi.fn(),
      close: vi.fn(),
    }
    const connect = vi.fn(async () => connection)
    const handle = prepareDesktopRelay(idleConfig({
      enabled: true,
      url: 'wss://relay.example.invalid/v1',
    }), connect)
    expect(handle?.url.href).toBe('wss://relay.example.invalid/v1')
    expect(handle?.httpUrl.href).toBe('https://relay.example.invalid/')
    expect(connect).not.toHaveBeenCalled()

    await handle?.connect({
      accessToken: 'tok-live',
      envelope: { protocolVersion: 1, id: 'hs-1', kind: 'handshake' },
    })
    expect(connect).toHaveBeenCalledWith({
      accessToken: 'tok-live',
      envelope: { protocolVersion: 1, id: 'hs-1', kind: 'handshake' },
      url: 'wss://relay.example.invalid/v1',
    })
    handle?.dispose()
    expect(connection.close).toHaveBeenCalledOnce()
  })

  it('registers, mints a token, lists devices, and revokes over HTTP without opening a socket', async () => {
    const connect = vi.fn()
    const register = vi.fn(async () => ({
      deviceId: 'device-a',
      userId: 'user-a',
      publicKey: 'pub-a',
    }))
    const issueToken = vi.fn(async () => ({
      accessToken: 'tok-live',
      expiresAt: 1_700_000_900_000,
    }))
    const revoke = vi.fn(async () => ({
      deviceId: 'device-a',
      revokedAt: 1_700_000_000_000,
    }))
    const listDevices = vi.fn(async () => [{
      deviceId: 'desktop-b',
      userId: 'user-a',
      publicKey: 'pub-b',
      encryptionPublicKey: 'enc-b',
    }])
    const handle = prepareDesktopRelay(idleConfig({
      enabled: true,
      url: 'wss://relay.example.invalid/v1',
    }), connect, { register, issueToken, revoke, listDevices })

    await expect(handle?.register({
      assertion: { sub: 'user-a' },
      deviceId: 'device-a',
      publicKey: 'pub-a',
    })).resolves.toEqual({
      deviceId: 'device-a',
      userId: 'user-a',
      publicKey: 'pub-a',
    })
    await expect(handle?.issueToken({
      assertion: { sub: 'user-a' },
      deviceId: 'device-a',
    })).resolves.toEqual({
      accessToken: 'tok-live',
      expiresAt: 1_700_000_900_000,
    })
    await expect(handle?.listDevices({
      assertion: { sub: 'user-a' },
    })).resolves.toEqual([{
      deviceId: 'desktop-b',
      userId: 'user-a',
      publicKey: 'pub-b',
      encryptionPublicKey: 'enc-b',
    }])
    await expect(handle?.revoke({
      assertion: { sub: 'user-a' },
      deviceId: 'device-a',
    })).resolves.toEqual({
      deviceId: 'device-a',
      revokedAt: 1_700_000_000_000,
    })
    expect(register).toHaveBeenCalledWith({
      httpUrl: 'https://relay.example.invalid/',
      assertion: { sub: 'user-a' },
      deviceId: 'device-a',
      publicKey: 'pub-a',
    })
    expect(listDevices).toHaveBeenCalledWith({
      httpUrl: 'https://relay.example.invalid/',
      assertion: { sub: 'user-a' },
    })
    expect(connect).not.toHaveBeenCalled()
  })

  it('drains queued sealed mail, opens it, and acks only queued ids', async () => {
    const queued = { id: 'msg-1', kind: 'prompt' }
    const live = { id: 'msg-2', kind: 'presence' }
    const connection = {
      sessionId: 'sess-1',
      userId: 'user-a',
      deviceId: 'device-a',
      grantedCapabilities: ['session.prompt'],
      send: vi.fn(),
      reclaim: vi.fn(async () => [queued]),
      receive: vi.fn(async () => [live]),
      acknowledge: vi.fn(async () => ({
        envelopeId: 'msg-1',
        toDeviceId: 'device-a',
        outcome: 'delivered' as const,
      })),
      close: vi.fn(),
    }
    const identity = {
      openSealed: vi.fn((envelope: unknown) => (
        envelope === queued
          ? { kind: 'prompt' as const, sessionId: 'sess-1', text: 'review the login form' }
          : { kind: 'presence' as const, state: 'online' as const }
      )),
    }
    await expect(drainDesktopRelayMail({ connection, identity })).resolves.toEqual({
      payloads: [
        { kind: 'prompt', sessionId: 'sess-1', text: 'review the login form' },
        { kind: 'presence', state: 'online' },
      ],
    })
    expect(connection.acknowledge).toHaveBeenCalledOnce()
    expect(connection.acknowledge).toHaveBeenCalledWith({ envelopeId: 'msg-1' })
  })

  it('opens a duplicated live push once and acks only the queued copy', async () => {
    const queued = { id: 'msg-1', kind: 'prompt' }
    const connection = {
      sessionId: 'sess-1',
      userId: 'user-a',
      deviceId: 'device-a',
      grantedCapabilities: ['session.prompt'],
      send: vi.fn(),
      reclaim: vi.fn(async () => [queued]),
      receive: vi.fn(async () => [queued]),
      acknowledge: vi.fn(async () => ({
        envelopeId: 'msg-1',
        toDeviceId: 'device-a',
        outcome: 'delivered' as const,
      })),
      close: vi.fn(),
    }
    const identity = {
      openSealed: vi.fn(() => ({
        kind: 'prompt' as const,
        sessionId: 'sess-1',
        text: 'review the login form',
      })),
    }
    await expect(drainDesktopRelayMail({ connection, identity })).resolves.toEqual({
      payloads: [
        { kind: 'prompt', sessionId: 'sess-1', text: 'review the login form' },
      ],
    })
    expect(identity.openSealed).toHaveBeenCalledOnce()
    expect(connection.acknowledge).toHaveBeenCalledOnce()
  })

  it('refuses to drain mail that has no envelope id', async () => {
    const connection = {
      sessionId: 'sess-1',
      userId: 'user-a',
      deviceId: 'device-a',
      grantedCapabilities: ['session.prompt'],
      send: vi.fn(),
      reclaim: vi.fn(async () => [{ kind: 'prompt' }]),
      receive: vi.fn(async () => {
        throw new Error('timeout')
      }),
      acknowledge: vi.fn(),
      close: vi.fn(),
    }
    await expect(drainDesktopRelayMail({
      connection,
      identity: { openSealed: vi.fn() },
    })).rejects.toMatchObject({ code: 'malformed' })
    expect(connection.acknowledge).not.toHaveBeenCalled()
  })

  it('applies PWA follow-ups locally and ignores desktop-originated events', async () => {
    const followUp = vi.fn(async () => undefined)
    const approval = vi.fn(async () => undefined)
    const cancel = vi.fn(async () => undefined)
    const secret = 'review the login form'
    await expect(applyDesktopRelayPayloads({
      payloads: [
        { kind: 'prompt', sessionId: 'sess-1', text: secret },
        { kind: 'approval', sessionId: 'sess-1', requestId: 'req-1', approved: true },
        { kind: 'cancel', sessionId: 'sess-1', requestId: 'req-1' },
        { kind: 'session-event', sessionId: 'sess-1', type: 'assistant.delta', detail: 'Looking' },
        { kind: 'presence', state: 'online' },
      ],
      followUp,
      approval,
      cancel,
    })).resolves.toEqual({ applied: 3, ignored: 2 })
    expect(followUp).toHaveBeenCalledWith({ sessionId: 'sess-1', text: secret })
    expect(approval).toHaveBeenCalledWith({
      sessionId: 'sess-1',
      requestId: 'req-1',
      approved: true,
    })
    expect(cancel).toHaveBeenCalledWith({ sessionId: 'sess-1', requestId: 'req-1' })
  })

  it('ignores approval and cancel when the desktop has not wired those sinks', async () => {
    const followUp = vi.fn(async () => undefined)
    await expect(applyDesktopRelayPayloads({
      payloads: [
        { kind: 'approval', sessionId: 'sess-1', requestId: 'req-1', approved: false },
        { kind: 'cancel', sessionId: 'sess-1', requestId: 'req-1' },
      ],
      followUp,
    })).resolves.toEqual({ applied: 0, ignored: 2 })
    expect(followUp).not.toHaveBeenCalled()
  })

  it('refuses empty and oversized follow-up text before the local sink runs', async () => {
    const followUp = vi.fn(async () => undefined)
    await expect(applyDesktopRelayPayloads({
      payloads: [{ kind: 'prompt', sessionId: 'sess-1', text: '' }],
      followUp,
    })).rejects.toMatchObject({ code: 'malformed' })
    await expect(applyDesktopRelayPayloads({
      payloads: [{
        kind: 'prompt',
        sessionId: 'sess-1',
        text: 'x'.repeat(MAX_DESKTOP_RELAY_FOLLOW_UP_CHARS + 1),
      }],
      followUp,
    })).rejects.toMatchObject({ code: 'malformed' })
    expect(followUp).not.toHaveBeenCalled()
  })

  it('applies queued follow-ups then acks only after the local sink succeeds', async () => {
    const queued = { id: 'msg-1', kind: 'prompt' }
    const connection = {
      sessionId: 'sess-1',
      userId: 'user-a',
      deviceId: 'device-a',
      grantedCapabilities: ['session.prompt'],
      send: vi.fn(),
      reclaim: vi.fn(async () => [queued]),
      receive: vi.fn(async () => []),
      acknowledge: vi.fn(async () => ({
        envelopeId: 'msg-1',
        toDeviceId: 'device-a',
        outcome: 'delivered' as const,
      })),
      close: vi.fn(),
    }
    const identity = {
      openSealed: vi.fn(() => ({
        kind: 'prompt' as const,
        sessionId: 'sess-1',
        text: 'review the login form',
      })),
    }
    const followUp = vi.fn(async () => undefined)
    await expect(processDesktopRelayMail({
      connection,
      identity,
      followUp,
    })).resolves.toEqual({ applied: 1, ignored: 0 })
    expect(followUp).toHaveBeenCalledWith({ sessionId: 'sess-1', text: 'review the login form' })
    expect(connection.acknowledge).toHaveBeenCalledOnce()
    expect(connection.acknowledge).toHaveBeenCalledWith({ envelopeId: 'msg-1' })
  })

  it('does not ack queued mail when the follow-up is refused', async () => {
    const queued = { id: 'msg-1', kind: 'prompt' }
    const connection = {
      sessionId: 'sess-1',
      userId: 'user-a',
      deviceId: 'device-a',
      grantedCapabilities: ['session.prompt'],
      send: vi.fn(),
      reclaim: vi.fn(async () => [queued]),
      receive: vi.fn(async () => []),
      acknowledge: vi.fn(),
      close: vi.fn(),
    }
    await expect(processDesktopRelayMail({
      connection,
      identity: {
        openSealed: vi.fn(() => ({ kind: 'prompt' as const, sessionId: 'sess-1', text: '' })),
      },
      followUp: vi.fn(async () => undefined),
    })).rejects.toMatchObject({ code: 'malformed' })
    expect(connection.acknowledge).not.toHaveBeenCalled()
  })

  it('refuses to process mail before the outbound socket is connected', async () => {
    const handle = prepareDesktopRelay(idleConfig({
      enabled: true,
      url: 'wss://relay.example.invalid/v1',
    }), vi.fn())
    await expect(handle?.processMail({
      identity: { openSealed: vi.fn() },
      followUp: vi.fn(async () => undefined),
    })).rejects.toMatchObject({ code: 'malformed' })
    await expect(handle?.sendProgress({
      destinationDeviceId: 'pwa-1',
      identity: { sealTo: vi.fn() },
      id: 'evt-1',
      sentAt: 1_700_000_000_000,
      userId: 'user-a',
      recipientEncryptionPublicKey: 'enc-pwa',
      sessionId: 'sess-1',
      type: 'notify.tool',
      detail: 'Waiting for approval',
    })).rejects.toMatchObject({ code: 'malformed' })
  })

  it('submits follow-ups only to the matching live desktop session', async () => {
    const submit = vi.fn(async () => undefined)
    const other = vi.fn(async () => undefined)
    const followUp = createDesktopRelayFollowUpSink({
      getSession: sessionId => {
        if (sessionId === 'sess-1') return { submit }
        if (sessionId === 'sess-other') return { submit: other }
        return undefined
      },
    })
    await followUp({ sessionId: 'sess-1', text: 'review the login form' })
    expect(submit).toHaveBeenCalledWith('review the login form')
    expect(other).not.toHaveBeenCalled()
    await expect(followUp({
      sessionId: 'sess-missing',
      text: 'review the login form',
    })).rejects.toMatchObject({ code: 'malformed' })
  })

  it('refuses empty approval and cancel ids before the local sink runs', async () => {
    const approval = vi.fn(async () => undefined)
    const cancel = vi.fn(async () => undefined)
    await expect(applyDesktopRelayPayloads({
      payloads: [{ kind: 'approval', sessionId: 'sess-1', requestId: '', approved: true }],
      followUp: vi.fn(async () => undefined),
      approval,
    })).rejects.toMatchObject({ code: 'malformed' })
    await expect(applyDesktopRelayPayloads({
      payloads: [{ kind: 'cancel', sessionId: 'sess-1', requestId: '' }],
      followUp: vi.fn(async () => undefined),
      cancel,
    })).rejects.toMatchObject({ code: 'malformed' })
    expect(approval).not.toHaveBeenCalled()
    expect(cancel).not.toHaveBeenCalled()
  })

  it('decides and cancels only the matching live desktop request', async () => {
    const decide = vi.fn(async () => undefined)
    const otherDecide = vi.fn(async () => undefined)
    const cancel = vi.fn(async () => undefined)
    const otherCancel = vi.fn(async () => undefined)
    const approval = createDesktopRelayApprovalSink({
      getRequest: request => {
        if (request.sessionId === 'sess-1' && request.requestId === 'req-1') return { decide }
        return { decide: otherDecide }
      },
    })
    const cancelSink = createDesktopRelayCancelSink({
      getRequest: request => {
        if (request.sessionId === 'sess-1' && request.requestId === 'req-1') return { cancel }
        return { cancel: otherCancel }
      },
    })
    await approval({ sessionId: 'sess-1', requestId: 'req-1', approved: true })
    await cancelSink({ sessionId: 'sess-1', requestId: 'req-1' })
    expect(decide).toHaveBeenCalledWith(true)
    expect(cancel).toHaveBeenCalledOnce()
    expect(otherDecide).not.toHaveBeenCalled()
    expect(otherCancel).not.toHaveBeenCalled()
    await expect(createDesktopRelayApprovalSink({
      getRequest: () => undefined,
    })({ sessionId: 'sess-1', requestId: 'req-missing', approved: false })).rejects.toMatchObject({
      code: 'malformed',
    })
    await expect(createDesktopRelayCancelSink({
      getRequest: () => undefined,
    })({ sessionId: 'sess-1', requestId: 'req-missing' })).rejects.toMatchObject({
      code: 'malformed',
    })
  })

  it('seals allowed session progress to a PWA without prompt text', async () => {
    const envelope = { id: 'evt-1', kind: 'session-event' }
    const sealTo = vi.fn(() => envelope)
    expect(sealDesktopRelaySessionEvent({
      identity: { sealTo },
      id: 'evt-1',
      sentAt: 1_700_000_000_000,
      userId: 'user-a',
      recipientEncryptionPublicKey: 'enc-pwa',
      sessionId: 'sess-1',
      type: 'notify.tool',
      detail: 'Waiting for approval',
    })).toBe(envelope)
    expect(sealTo).toHaveBeenCalledWith({
      id: 'evt-1',
      sentAt: 1_700_000_000_000,
      userId: 'user-a',
      recipientEncryptionPublicKey: 'enc-pwa',
      payload: {
        kind: 'session-event',
        sessionId: 'sess-1',
        type: 'notify.tool',
        detail: 'Waiting for approval',
      },
    })
    expectRelayError(
      () => sealDesktopRelaySessionEvent({
        identity: { sealTo },
        id: 'evt-2',
        sentAt: 1_700_000_000_000,
        userId: 'user-a',
        recipientEncryptionPublicKey: 'enc-pwa',
        sessionId: 'sess-1',
        type: 'prompt',
        detail: 'review the login form',
      }),
      'malformed',
    )
    expectRelayError(
      () => sealDesktopRelaySessionEvent({
        identity: { sealTo },
        id: 'evt-3',
        sentAt: 1_700_000_000_000,
        userId: 'user-a',
        recipientEncryptionPublicKey: 'enc-pwa',
        sessionId: 'sess-1',
        type: 'assistant.delta',
        detail: 'x'.repeat(MAX_DESKTOP_RELAY_PROGRESS_DETAIL_CHARS + 1),
      }),
      'malformed',
    )
    expect(sealTo).toHaveBeenCalledOnce()
  })

  it('sends sealed progress over the outbound socket without listening', async () => {
    const envelope = { id: 'evt-1', kind: 'session-event' }
    const connection = {
      sessionId: 'sess-1',
      userId: 'user-a',
      deviceId: 'device-a',
      grantedCapabilities: ['session.prompt'],
      send: vi.fn(async () => ({
        envelopeId: 'evt-1',
        toDeviceId: 'pwa-1',
        outcome: 'delivered' as const,
      })),
      reclaim: vi.fn(),
      receive: vi.fn(),
      acknowledge: vi.fn(),
      close: vi.fn(),
    }
    await expect(sendDesktopRelaySessionEvent({
      connection,
      destinationDeviceId: 'pwa-1',
      identity: { sealTo: vi.fn(() => envelope) },
      id: 'evt-1',
      sentAt: 1_700_000_000_000,
      userId: 'user-a',
      recipientEncryptionPublicKey: 'enc-pwa',
      sessionId: 'sess-1',
      type: 'assistant.done',
      detail: 'Complete',
    })).resolves.toEqual({
      envelopeId: 'evt-1',
      toDeviceId: 'pwa-1',
      outcome: 'delivered',
    })
    expect(connection.send).toHaveBeenCalledWith({
      envelope,
      destinationDeviceId: 'pwa-1',
    })
  })

  it('sends progress through the connected outbound handle', async () => {
    const envelope = { id: 'evt-1', kind: 'session-event' }
    const connection = {
      sessionId: 'sess-1',
      userId: 'user-a',
      deviceId: 'device-a',
      grantedCapabilities: ['session.prompt'],
      send: vi.fn(async () => ({
        envelopeId: 'evt-1',
        toDeviceId: 'pwa-1',
        outcome: 'queued' as const,
      })),
      reclaim: vi.fn(),
      receive: vi.fn(),
      acknowledge: vi.fn(),
      close: vi.fn(),
    }
    const handle = prepareDesktopRelay(idleConfig({
      enabled: true,
      url: 'wss://relay.example.invalid/v1',
    }), vi.fn(async () => connection))
    await handle?.connect({
      accessToken: 'tok-live',
      envelope: { protocolVersion: 1, id: 'hs-1', kind: 'handshake' },
    })
    await expect(handle?.sendProgress({
      destinationDeviceId: 'pwa-1',
      identity: { sealTo: vi.fn(() => envelope) },
      id: 'evt-1',
      sentAt: 1_700_000_000_000,
      userId: 'user-a',
      recipientEncryptionPublicKey: 'enc-pwa',
      sessionId: 'sess-1',
      type: 'tool.progress',
      detail: 'reading src/main.ts',
    })).resolves.toEqual({
      envelopeId: 'evt-1',
      toDeviceId: 'pwa-1',
      outcome: 'queued',
    })
    handle?.dispose()
    expect(connection.close).toHaveBeenCalledOnce()
  })

  it('seals presence to a PWA and refuses unknown states', () => {
    const envelope = { id: 'pres-1', kind: 'presence' }
    const sealTo = vi.fn(() => envelope)
    expect(sealDesktopRelayPresence({
      identity: { sealTo },
      id: 'pres-1',
      sentAt: 1_700_000_000_000,
      userId: 'user-a',
      recipientEncryptionPublicKey: 'enc-pwa',
      state: 'offline',
    })).toBe(envelope)
    expect(sealTo).toHaveBeenCalledWith({
      id: 'pres-1',
      sentAt: 1_700_000_000_000,
      userId: 'user-a',
      recipientEncryptionPublicKey: 'enc-pwa',
      payload: { kind: 'presence', state: 'offline' },
    })
    expectRelayError(
      () => sealDesktopRelayPresence({
        identity: { sealTo },
        id: 'pres-2',
        sentAt: 1_700_000_000_000,
        userId: 'user-a',
        recipientEncryptionPublicKey: 'enc-pwa',
        state: 'away' as 'online',
      }),
      'malformed',
    )
    expect(sealTo).toHaveBeenCalledOnce()
  })

  it('sends sealed presence over the outbound socket without listening', async () => {
    const envelope = { id: 'pres-1', kind: 'presence' }
    const connection = {
      sessionId: 'sess-1',
      userId: 'user-a',
      deviceId: 'device-a',
      grantedCapabilities: ['session.prompt'],
      send: vi.fn(async () => ({
        envelopeId: 'pres-1',
        toDeviceId: 'pwa-1',
        outcome: 'delivered' as const,
      })),
      reclaim: vi.fn(),
      receive: vi.fn(),
      acknowledge: vi.fn(),
      close: vi.fn(),
    }
    await expect(sendDesktopRelayPresence({
      connection,
      destinationDeviceId: 'pwa-1',
      identity: { sealTo: vi.fn(() => envelope) },
      id: 'pres-1',
      sentAt: 1_700_000_000_000,
      userId: 'user-a',
      recipientEncryptionPublicKey: 'enc-pwa',
      state: 'online',
    })).resolves.toEqual({
      envelopeId: 'pres-1',
      toDeviceId: 'pwa-1',
      outcome: 'delivered',
    })
  })

  it('refuses to send presence before the outbound socket is connected', async () => {
    const handle = prepareDesktopRelay(idleConfig({
      enabled: true,
      url: 'wss://relay.example.invalid/v1',
    }), vi.fn())
    await expect(handle?.sendPresence({
      destinationDeviceId: 'pwa-1',
      identity: { sealTo: vi.fn() },
      id: 'pres-1',
      sentAt: 1_700_000_000_000,
      userId: 'user-a',
      recipientEncryptionPublicKey: 'enc-pwa',
      state: 'online',
    })).rejects.toMatchObject({ code: 'malformed' })
  })
})
