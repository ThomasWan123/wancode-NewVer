import type { Context } from '@deepseek-ai/cordis'
import { describe, expect, it, vi } from 'vitest'
import {
  apply,
  drainDesktopRelayMail,
  prepareDesktopRelay,
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
})
