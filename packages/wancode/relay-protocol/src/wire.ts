/** First outbound WebSocket JSON frame: a short-lived token plus handshake envelope. */

import { RelayAuthorizationError } from './errors.ts'
import { assertNoPlaintextRelayFields } from './envelope.ts'

/** Desktop-to-relay opening frame. Credentials stay off the URL. */
export interface RelayWireHandshake {
  readonly accessToken: string
  readonly envelope: unknown
}

/** Post-handshake application frame. The relay still never opens the box. */
export interface RelayWireDelivery {
  readonly accessToken: string
  readonly destinationDeviceId: string
  readonly envelope: unknown
}

function requiredToken(record: Record<string, unknown>): string {
  if (typeof record.accessToken !== 'string'
    || record.accessToken.length === 0
    || record.accessToken.length > 8192
    || /[\0\r\n]/u.test(record.accessToken)) {
    throw new RelayAuthorizationError('malformed', 'relay access token is required')
  }
  return record.accessToken
}

function requiredEnvelope(record: Record<string, unknown>, label: string): unknown {
  if (!('envelope' in record)) {
    throw new RelayAuthorizationError('malformed', `${label} envelope is required`)
  }
  return record.envelope
}

function asWireRecord(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new RelayAuthorizationError('malformed', `${label} must be an object`)
  }
  const record = value as Record<string, unknown>
  assertNoPlaintextRelayFields(record, label)
  return record
}

/**
 * Parse the first JSON message on an outbound relay socket.
 * The token is a message field; query-string credentials and plaintext
 * application fields fail closed.
 */
export function parseRelayWireHandshake(value: unknown): RelayWireHandshake {
  const record = asWireRecord(value, 'relay wire handshake')
  return {
    accessToken: requiredToken(record),
    envelope: requiredEnvelope(record, 'relay wire handshake'),
  }
}

/**
 * Parse one post-handshake application frame. Opaque prompt ciphertext fails
 * closed later at the sealed-box gate, not here.
 */
export function parseRelayWireDelivery(value: unknown): RelayWireDelivery {
  const record = asWireRecord(value, 'relay wire delivery')
  if (typeof record.destinationDeviceId !== 'string'
    || record.destinationDeviceId.length === 0
    || /[\0\r\n]/u.test(record.destinationDeviceId)) {
    throw new RelayAuthorizationError('malformed', 'relay destinationDeviceId is required')
  }
  return {
    accessToken: requiredToken(record),
    destinationDeviceId: record.destinationDeviceId,
    envelope: requiredEnvelope(record, 'relay wire delivery'),
  }
}

/** Post-handshake mailbox command. Device id always comes from the token. */
export type RelayWireCommand =
  | { readonly kind: 'deliver', readonly frame: RelayWireDelivery }
  | { readonly kind: 'reclaim', readonly accessToken: string }
  | { readonly kind: 'ack', readonly accessToken: string, readonly envelopeId: string }

/**
 * Parse one post-handshake command. Reclaim and ack never carry a client-chosen
 * device id. Unknown actions and mixed deliver fields fail closed.
 */
export function parseRelayWireCommand(value: unknown): RelayWireCommand {
  const record = asWireRecord(value, 'relay wire command')
  if (record.action === 'reclaim') {
    if ('destinationDeviceId' in record || 'envelope' in record || 'envelopeId' in record) {
      throw new RelayAuthorizationError('malformed', 'relay reclaim command must not carry delivery fields')
    }
    return { kind: 'reclaim', accessToken: requiredToken(record) }
  }
  if (record.action === 'ack') {
    if ('destinationDeviceId' in record || 'envelope' in record) {
      throw new RelayAuthorizationError('malformed', 'relay ack command must not carry delivery fields')
    }
    if (typeof record.envelopeId !== 'string' || record.envelopeId.length === 0 || /[\0\r\n]/u.test(record.envelopeId)) {
      throw new RelayAuthorizationError('malformed', 'relay ack envelopeId is required')
    }
    return { kind: 'ack', accessToken: requiredToken(record), envelopeId: record.envelopeId }
  }
  if (record.action !== undefined) {
    throw new RelayAuthorizationError('malformed', 'relay wire action is not supported')
  }
  return { kind: 'deliver', frame: parseRelayWireDelivery(value) }
}
