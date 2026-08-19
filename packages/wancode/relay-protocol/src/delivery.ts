/** Offline mailbox and reconnect drain. Queues ciphertext only. */

import { RelayAuthorizationError } from './errors.ts'
import type { RelayAuditLog } from './audit.ts'
import {
  type RelayEnvelope,
  type RelayStore,
} from './envelope.ts'
import { assertSealedApplicationEnvelope } from './payload.ts'
import {
  routeRelayEnvelope,
  type RouteRelayEnvelopeInput,
} from './route.ts'

export type RelayDeliveryOutcome = 'delivered' | 'queued' | 'duplicate'

/** Result of one authorized live or queued delivery. */
export interface RelayDelivery {
  readonly envelopeId: string
  readonly toDeviceId: string
  readonly outcome: RelayDeliveryOutcome
}

/** Per-device ciphertext mailbox. Acknowledgement removes a frame. */
export interface RelayMailbox {
  enqueue(deviceId: string, envelope: RelayEnvelope): void
  list(deviceId: string): readonly RelayEnvelope[]
  acknowledge(deviceId: string, envelopeId: string): boolean
  drop(deviceId: string): void
}

/** Live presence for a registered device's current outbound session. */
export interface RelayPresence {
  setOnline(deviceId: string, sessionId: string): void
  setOffline(deviceId: string): void
  isOnline(deviceId: string): boolean
}

/** Optional socket fan-out used by a loopback or cloud acceptor. Never opens the box. */
export interface RelayLiveSink {
  push(deviceId: string, envelope: RelayEnvelope): boolean
}

/** Inputs for routing then delivering or queueing one envelope. */
export interface DeliverRelayEnvelopeInput extends RouteRelayEnvelopeInput {
  readonly mailbox: RelayMailbox
  readonly presence: RelayPresence
  readonly live?: RelayLiveSink
}

/** Inputs for reconnect drain of one device mailbox. */
export interface ReclaimRelayMailboxInput {
  readonly accessToken: string
  readonly deviceId: string
  readonly store: RelayStore
  readonly mailbox: RelayMailbox
  readonly now: number
  readonly audit?: RelayAuditLog
}

/** Inputs for acknowledging one queued envelope after reconnect. */
export interface AcknowledgeRelayMailboxInput extends ReclaimRelayMailboxInput {
  readonly envelopeId: string
}

function requiredId(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.length === 0 || /[\0\r\n]/u.test(value)) {
    throw new RelayAuthorizationError('malformed', `relay ${field} is required`)
  }
  return value
}

function authorizeMailboxDevice(input: ReclaimRelayMailboxInput): void {
  const deviceId = requiredId(input.deviceId, 'deviceId')
  const token = input.store.getAccessToken(input.accessToken)
  if (token === undefined || token.expiresAt <= input.now) {
    throw new RelayAuthorizationError('expired-token', 'relay access token is unknown or expired')
  }
  if (token.deviceId !== deviceId) {
    throw new RelayAuthorizationError('cross-account', 'relay mailbox does not belong to the presented device')
  }
  const device = input.store.getDevice(deviceId)
  if (device === undefined || (device.revokedAt !== undefined && device.revokedAt <= input.now)) {
    input.mailbox.drop(deviceId)
    throw new RelayAuthorizationError('revoked-device', 'relay device is unknown or revoked')
  }
  if (device.userId !== token.userId) {
    throw new RelayAuthorizationError('cross-account', 'relay mailbox does not belong to the presented device')
  }
}

function appendAudit(
  audit: RelayAuditLog | undefined,
  event: Parameters<RelayAuditLog['append']>[0],
): void {
  audit?.append(event)
}

/**
 * Authorize a same-account route, then deliver live or queue ciphertext.
 * Identical retries stay idempotent and do not duplicate the mailbox.
 */
export function deliverRelayEnvelope(input: DeliverRelayEnvelopeInput): RelayDelivery {
  const destinationDeviceId = requiredId(input.destinationDeviceId, 'destinationDeviceId')
  const route = routeRelayEnvelope(input)
  if (route.outcome === 'duplicate') {
    appendAudit(input.audit, {
      at: input.now,
      action: 'deliver',
      userId: route.userId,
      deviceId: route.fromDeviceId,
      outcome: 'duplicate',
      envelopeId: route.envelopeId,
      destinationDeviceId,
    })
    return { envelopeId: route.envelopeId, toDeviceId: destinationDeviceId, outcome: 'duplicate' }
  }
  if (input.presence.isOnline(destinationDeviceId)) {
    const sealed = assertSealedApplicationEnvelope(input.envelope)
    if (input.live === undefined || input.live.push(destinationDeviceId, sealed)) {
      appendAudit(input.audit, {
        at: input.now,
        action: 'deliver',
        userId: route.userId,
        deviceId: route.fromDeviceId,
        outcome: 'accepted',
        envelopeId: route.envelopeId,
        destinationDeviceId,
      })
      return { envelopeId: route.envelopeId, toDeviceId: destinationDeviceId, outcome: 'delivered' }
    }
  }
  input.mailbox.enqueue(destinationDeviceId, assertSealedApplicationEnvelope(input.envelope))
  appendAudit(input.audit, {
    at: input.now,
    action: 'queue',
    userId: route.userId,
    deviceId: route.fromDeviceId,
    outcome: 'accepted',
    envelopeId: route.envelopeId,
    destinationDeviceId,
  })
  return { envelopeId: route.envelopeId, toDeviceId: destinationDeviceId, outcome: 'queued' }
}

/**
 * Return queued envelopes for a reconnecting device. The mailbox is unchanged
 * until acknowledgement, so a repeated drain stays idempotent.
 */
export function reclaimRelayMailbox(input: ReclaimRelayMailboxInput): readonly RelayEnvelope[] {
  authorizeMailboxDevice(input)
  const queued = input.mailbox.list(input.deviceId)
  appendAudit(input.audit, {
    at: input.now,
    action: 'reclaim',
    userId: input.store.getAccessToken(input.accessToken)?.userId ?? 'unknown',
    deviceId: input.deviceId,
    outcome: 'accepted',
  })
  return queued
}

/**
 * Remove one queued envelope after the reconnecting device acknowledges it.
 * Repeat acknowledgements of the same id stay idempotent.
 */
export function acknowledgeRelayMailbox(input: AcknowledgeRelayMailboxInput): RelayDelivery {
  authorizeMailboxDevice(input)
  const envelopeId = requiredId(input.envelopeId, 'envelopeId')
  const removed = input.mailbox.acknowledge(input.deviceId, envelopeId)
  const outcome = removed ? 'delivered' : 'duplicate'
  appendAudit(input.audit, {
    at: input.now,
    action: 'ack',
    userId: input.store.getAccessToken(input.accessToken)?.userId ?? 'unknown',
    deviceId: input.deviceId,
    outcome: removed ? 'accepted' : 'duplicate',
    envelopeId,
    destinationDeviceId: input.deviceId,
  })
  return { envelopeId, toDeviceId: input.deviceId, outcome }
}

/** In-memory mailbox for protocol tests and headless control-plane proofs. */
export function createMemoryRelayMailbox(): RelayMailbox {
  const items = new Map<string, RelayEnvelope>()
  const keyFor = (deviceId: string, envelopeId: string) => `${deviceId}\0${envelopeId}`
  return {
    enqueue(deviceId, envelope) {
      const key = keyFor(deviceId, envelope.id)
      const previous = items.get(key)
      if (previous !== undefined) {
        if (previous.ciphertext !== envelope.ciphertext) {
          throw new RelayAuthorizationError('replay', 'relay mailbox id was reused with a different payload')
        }
        return
      }
      items.set(key, envelope)
    },
    list(deviceId) {
      const prefix = `${deviceId}\0`
      return [...items.entries()]
        .filter(([key]) => key.startsWith(prefix))
        .map(([, envelope]) => envelope)
    },
    acknowledge(deviceId, envelopeId) {
      return items.delete(keyFor(deviceId, envelopeId))
    },
    drop(deviceId) {
      const prefix = `${deviceId}\0`
      for (const key of [...items.keys()]) {
        if (key.startsWith(prefix)) items.delete(key)
      }
    },
  }
}

/** In-memory presence map for protocol tests and headless control-plane proofs. */
export function createMemoryRelayPresence(): RelayPresence {
  const online = new Map<string, string>()
  return {
    setOnline(deviceId, sessionId) { online.set(deviceId, sessionId) },
    setOffline(deviceId) { online.delete(deviceId) },
    isOnline(deviceId) { return online.has(deviceId) },
  }
}
