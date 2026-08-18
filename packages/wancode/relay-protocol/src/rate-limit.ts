/** Per-device rate limits for accepted relay routes. Duplicates do not consume. */

import { RelayAuthorizationError } from './errors.ts'

/** Default: sixty accepted frames per device per minute. */
export const RELAY_RATE_LIMIT_WINDOW_MS = 60_000
export const RELAY_RATE_LIMIT_MAX_EVENTS = 60

/** Pluggable limiter. Production can swap this for a distributed counter. */
export interface RelayRateLimiter {
  consume(deviceId: string, now: number): void
}

/** Sliding-window configuration for the in-memory limiter. */
export interface MemoryRelayRateLimiterConfig {
  readonly windowMs?: number
  readonly maxEvents?: number
}

/**
 * In-memory sliding window. A non-positive window or max fails closed.
 */
export function createMemoryRelayRateLimiter(
  config: MemoryRelayRateLimiterConfig = {},
): RelayRateLimiter {
  const windowMs = config.windowMs ?? RELAY_RATE_LIMIT_WINDOW_MS
  const maxEvents = config.maxEvents ?? RELAY_RATE_LIMIT_MAX_EVENTS
  if (!Number.isFinite(windowMs) || windowMs <= 0 || !Number.isFinite(maxEvents) || maxEvents <= 0) {
    throw new RelayAuthorizationError('malformed', 'relay rate limit window and max must be positive')
  }
  const stamps = new Map<string, number[]>()
  return {
    consume(deviceId, now) {
      if (typeof deviceId !== 'string' || deviceId.length === 0) {
        throw new RelayAuthorizationError('malformed', 'relay rate limit deviceId is required')
      }
      const cutoff = now - windowMs
      const next = (stamps.get(deviceId) ?? []).filter(stamp => stamp > cutoff)
      if (next.length >= maxEvents) {
        throw new RelayAuthorizationError('rate-limited', 'relay device exceeded its rate limit')
      }
      next.push(now)
      stamps.set(deviceId, next)
    },
  }
}
