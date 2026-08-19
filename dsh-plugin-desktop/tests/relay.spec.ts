import type { Context } from '@deepseek-ai/cordis'
import { describe, expect, it, vi } from 'vitest'
import {
  apply,
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
})
