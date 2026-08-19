/** Append-only relay audit log. Application plaintext never enters the log. */

import { assertNoPlaintextRelayFields } from './envelope.ts'
import { isRelayErrorCode, RelayAuthorizationError, type RelayErrorCode } from './errors.ts'

const AUDIT_ACTIONS = ['route', 'register', 'revoke', 'issue-token', 'deliver', 'queue', 'reclaim', 'ack'] as const
const AUDIT_OUTCOMES = ['accepted', 'duplicate', 'rejected'] as const

export type RelayAuditAction = (typeof AUDIT_ACTIONS)[number]
export type RelayAuditOutcome = (typeof AUDIT_OUTCOMES)[number]

/** Control-plane audit record. Ciphertext and application plaintext are absent. */
export interface RelayAuditEvent {
  readonly at: number
  readonly action: RelayAuditAction
  readonly userId: string
  readonly deviceId: string
  readonly outcome: RelayAuditOutcome
  readonly envelopeId?: string
  readonly destinationDeviceId?: string
  readonly code?: RelayErrorCode
}

/** Durable append-only audit sink. */
export interface RelayAuditLog {
  append(event: RelayAuditEvent): void
  list(): readonly RelayAuditEvent[]
}

function requiredText(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.length === 0 || /[\0\r\n]/u.test(value)) {
    throw new RelayAuthorizationError('malformed', `relay audit ${field} is required`)
  }
  return value
}

/**
 * Parse one untrusted audit record. Plaintext application fields fail closed.
 */
export function parseRelayAuditEvent(value: unknown): RelayAuditEvent {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new RelayAuthorizationError('malformed', 'relay audit event must be an object')
  }
  const record = value as Record<string, unknown>
  assertNoPlaintextRelayFields(record, 'relay audit event')
  if (typeof record.at !== 'number' || !Number.isFinite(record.at)) {
    throw new RelayAuthorizationError('malformed', 'relay audit at is required')
  }
  if (typeof record.action !== 'string' || !AUDIT_ACTIONS.includes(record.action as RelayAuditAction)) {
    throw new RelayAuthorizationError('malformed', 'relay audit action is not supported')
  }
  if (typeof record.outcome !== 'string' || !AUDIT_OUTCOMES.includes(record.outcome as RelayAuditOutcome)) {
    throw new RelayAuthorizationError('malformed', 'relay audit outcome is not supported')
  }
  const event: RelayAuditEvent = {
    at: record.at,
    action: record.action as RelayAuditAction,
    userId: requiredText(record.userId, 'userId'),
    deviceId: requiredText(record.deviceId, 'deviceId'),
    outcome: record.outcome as RelayAuditOutcome,
    ...(record.envelopeId === undefined ? {} : { envelopeId: requiredText(record.envelopeId, 'envelopeId') }),
    ...(record.destinationDeviceId === undefined
      ? {}
      : { destinationDeviceId: requiredText(record.destinationDeviceId, 'destinationDeviceId') }),
    ...(record.code === undefined ? {} : { code: parseAuditCode(record.code) }),
  }
  return event
}

function parseAuditCode(value: unknown): RelayErrorCode {
  if (typeof value !== 'string' || !isRelayErrorCode(value)) {
    throw new RelayAuthorizationError('malformed', 'relay audit code is not supported')
  }
  return value
}

/** Append one parsed audit event. */
export function recordRelayAuditEvent(log: RelayAuditLog, value: unknown): RelayAuditEvent {
  const event = parseRelayAuditEvent(value)
  log.append(event)
  return event
}

/** In-memory audit log for protocol tests and headless control-plane proofs. */
export function createMemoryRelayAuditLog(): RelayAuditLog {
  const events: RelayAuditEvent[] = []
  return {
    append(event) { events.push(event) },
    list() { return events },
  }
}
