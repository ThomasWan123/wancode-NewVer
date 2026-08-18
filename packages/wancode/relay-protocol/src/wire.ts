/** First outbound WebSocket JSON frame: a short-lived token plus handshake envelope. */

import { RelayAuthorizationError } from './errors.ts'
import { assertNoPlaintextRelayFields } from './envelope.ts'

/** Desktop-to-relay opening frame. Credentials stay off the URL. */
export interface RelayWireHandshake {
  readonly accessToken: string
  readonly envelope: unknown
}

/**
 * Parse the first JSON message on an outbound relay socket.
 * The token is a message field; query-string credentials and plaintext
 * application fields fail closed.
 */
export function parseRelayWireHandshake(value: unknown): RelayWireHandshake {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new RelayAuthorizationError('malformed', 'relay wire handshake must be an object')
  }
  const record = value as Record<string, unknown>
  assertNoPlaintextRelayFields(record, 'relay wire handshake')
  if (typeof record.accessToken !== 'string'
    || record.accessToken.length === 0
    || record.accessToken.length > 8192
    || /[\0\r\n]/u.test(record.accessToken)) {
    throw new RelayAuthorizationError('malformed', 'relay access token is required')
  }
  if (!('envelope' in record)) {
    throw new RelayAuthorizationError('malformed', 'relay wire handshake envelope is required')
  }
  return {
    accessToken: record.accessToken,
    envelope: record.envelope,
  }
}
