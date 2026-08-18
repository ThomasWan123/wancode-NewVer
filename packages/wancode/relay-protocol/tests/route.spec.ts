import { describe, expect, it } from 'vitest'
import {
  RelayAuthorizationError,
  createMemoryRelayAuditLog,
  createMemoryRelayRateLimiter,
  createMemoryRelayStore,
  parseRelayAuditEvent,
  routeRelayEnvelope,
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

function envelope(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    protocolVersion: 1,
    id: 'msg-1',
    kind: 'prompt',
    sentAt: NOW,
    actor: { userId: 'user-a', deviceId: 'pwa-a' },
    ciphertext: 'v1:opaque-ciphertext',
    ...overrides,
  }
}

function authorizedStore() {
  const store = createMemoryRelayStore()
  store.putAccessToken({
    tokenId: 'tok-pwa',
    userId: 'user-a',
    deviceId: 'pwa-a',
    expiresAt: NOW + 60_000,
  })
  store.putDevice({ deviceId: 'pwa-a', userId: 'user-a', publicKey: 'pwa-a-public' })
  store.putDevice({ deviceId: 'desktop-a', userId: 'user-a', publicKey: 'desktop-a-public' })
  store.putDevice({ deviceId: 'desktop-b', userId: 'user-b', publicKey: 'desktop-b-public' })
  return store
}

describe('relay routing, rate limits, and audit', () => {
  it('routes a prompt from a PWA to the same account desktop', () => {
    const store = authorizedStore()
    const audit = createMemoryRelayAuditLog()
    expect(routeRelayEnvelope({
      envelope: envelope(),
      accessToken: 'tok-pwa',
      destinationDeviceId: 'desktop-a',
      store,
      now: NOW,
      audit,
    })).toEqual({
      envelopeId: 'msg-1',
      userId: 'user-a',
      fromDeviceId: 'pwa-a',
      toDeviceId: 'desktop-a',
      outcome: 'accepted',
    })
    expect(audit.list()).toEqual([{
      at: NOW,
      action: 'route',
      userId: 'user-a',
      deviceId: 'pwa-a',
      outcome: 'accepted',
      envelopeId: 'msg-1',
      destinationDeviceId: 'desktop-a',
    }])
    expect(JSON.stringify(audit.list())).not.toMatch(/prompt|credential|toolOutput|ciphertext/u)
  })

  it('returns a duplicate for the same route and does not consume the rate limit', () => {
    const store = authorizedStore()
    const limiter = createMemoryRelayRateLimiter({ windowMs: 60_000, maxEvents: 1 })
    const first = routeRelayEnvelope({
      envelope: envelope(),
      accessToken: 'tok-pwa',
      destinationDeviceId: 'desktop-a',
      store,
      now: NOW,
      limiter,
    })
    const retry = routeRelayEnvelope({
      envelope: envelope(),
      accessToken: 'tok-pwa',
      destinationDeviceId: 'desktop-a',
      store,
      now: NOW + 1,
      limiter,
    })
    expect(first.outcome).toBe('accepted')
    expect(retry).toEqual({ ...first, outcome: 'duplicate' })
  })

  it('refuses a destination owned by another account or a revoked device', () => {
    const store = authorizedStore()
    store.putDevice({
      deviceId: 'desktop-revoked',
      userId: 'user-a',
      publicKey: 'desktop-revoked-public',
      revokedAt: NOW - 1,
    })
    expectRelayError(() => routeRelayEnvelope({
      envelope: envelope(),
      accessToken: 'tok-pwa',
      destinationDeviceId: 'desktop-b',
      store,
      now: NOW,
    }), 'cross-account')
    expectRelayError(() => routeRelayEnvelope({
      envelope: envelope({ id: 'msg-2' }),
      accessToken: 'tok-pwa',
      destinationDeviceId: 'desktop-revoked',
      store,
      now: NOW,
    }), 'revoked-device')
  })

  it('fails closed after the per-device rate limit is exceeded', () => {
    const store = authorizedStore()
    const limiter = createMemoryRelayRateLimiter({ windowMs: 60_000, maxEvents: 1 })
    routeRelayEnvelope({
      envelope: envelope(),
      accessToken: 'tok-pwa',
      destinationDeviceId: 'desktop-a',
      store,
      now: NOW,
      limiter,
    })
    expectRelayError(() => routeRelayEnvelope({
      envelope: envelope({ id: 'msg-2' }),
      accessToken: 'tok-pwa',
      destinationDeviceId: 'desktop-a',
      store,
      now: NOW + 1,
      limiter,
    }), 'rate-limited')
  })

  it('refuses plaintext application fields on an audit record', () => {
    expectRelayError(() => parseRelayAuditEvent({
      at: NOW,
      action: 'route',
      userId: 'user-a',
      deviceId: 'pwa-a',
      outcome: 'accepted',
      prompt: 'delete all files',
    }), 'plaintext')
  })
})
