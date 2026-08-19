/** Same-account device routing after token and device checks succeed. */

import {
  dispatchRelayEnvelope,
  type RelayRoute,
  type RelayStore,
} from './envelope.ts'
import { assertSealedApplicationEnvelope } from './payload.ts'
import { RelayAuthorizationError } from './errors.ts'
import type { RelayAuditLog } from './audit.ts'
import type { RelayRateLimiter } from './rate-limit.ts'

/** Store that can persist authorized routes. */
export type RelayRouteStore = RelayStore & {
  getRoute(envelopeId: string): RelayRoute | undefined
  putRoute(route: RelayRoute): void
}

/** Inputs for one device-to-device route. */
export interface RouteRelayEnvelopeInput {
  readonly envelope: unknown
  readonly accessToken: string
  readonly destinationDeviceId: string
  readonly store: RelayRouteStore
  readonly now: number
  readonly limiter?: RelayRateLimiter
  readonly audit?: RelayAuditLog
}

function requiredId(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.length === 0 || /[\0\r\n]/u.test(value)) {
    throw new RelayAuthorizationError('malformed', `relay ${field} is required`)
  }
  return value
}

function appendAudit(input: RouteRelayEnvelopeInput, event: Parameters<RelayAuditLog['append']>[0]): void {
  input.audit?.append(event)
}

/**
 * Authorize then route one envelope to another device owned by the same account.
 * Cross-account destinations, unknown devices, and rate-limit excess fail closed.
 * Identical retries stay idempotent and do not consume the rate limit.
 */
export function routeRelayEnvelope(input: RouteRelayEnvelopeInput): RelayRoute {
  const destinationDeviceId = requiredId(input.destinationDeviceId, 'destinationDeviceId')
  const envelope = assertSealedApplicationEnvelope(input.envelope)
  const token = input.store.getAccessToken(input.accessToken)
  const userId = token?.userId ?? ''
  const deviceId = token?.deviceId ?? ''
  try {
    if (token === undefined || token.expiresAt <= input.now) {
      throw new RelayAuthorizationError('expired-token', 'relay access token is unknown or expired')
    }
    const destination = input.store.getDevice(destinationDeviceId)
    if (destination === undefined || (destination.revokedAt !== undefined && destination.revokedAt <= input.now)) {
      throw new RelayAuthorizationError('revoked-device', 'relay destination device is unknown or revoked')
    }
    if (destination.userId !== token.userId) {
      throw new RelayAuthorizationError('cross-account', 'relay destination device belongs to another account')
    }

    const previous = input.store.getRoute(envelope.id)
    if (previous === undefined) {
      input.limiter?.consume(token.deviceId, input.now)
    }

    const dispatched = dispatchRelayEnvelope({
      envelope: input.envelope,
      accessToken: input.accessToken,
      store: input.store,
      now: input.now,
    })
    if (previous !== undefined) {
      if (previous.toDeviceId !== destinationDeviceId || previous.fromDeviceId !== token.deviceId) {
        throw new RelayAuthorizationError('replay', 'relay message id was reused with a different route')
      }
      const duplicate: RelayRoute = { ...previous, outcome: 'duplicate' }
      appendAudit(input, {
        at: input.now,
        action: 'route',
        userId: token.userId,
        deviceId: token.deviceId,
        outcome: 'duplicate',
        envelopeId: dispatched.id,
        destinationDeviceId,
      })
      return duplicate
    }

    const route: RelayRoute = {
      envelopeId: dispatched.id,
      userId: token.userId,
      fromDeviceId: token.deviceId,
      toDeviceId: destinationDeviceId,
      outcome: 'accepted',
    }
    input.store.putRoute(route)
    appendAudit(input, {
      at: input.now,
      action: 'route',
      userId: token.userId,
      deviceId: token.deviceId,
      outcome: 'accepted',
      envelopeId: dispatched.id,
      destinationDeviceId,
    })
    return route
  } catch (cause) {
    if (cause instanceof RelayAuthorizationError) {
      appendAudit(input, {
        at: input.now,
        action: 'route',
        userId: userId.length === 0 ? 'unknown' : userId,
        deviceId: deviceId.length === 0 ? 'unknown' : deviceId,
        outcome: 'rejected',
        envelopeId: envelope.id,
        destinationDeviceId,
        code: cause.code,
      })
    }
    throw cause
  }
}
