/** Versioned envelopes, token checks, and replay-safe dispatch. */

import { RelayAuthorizationError } from './errors.ts'
import type { OutboundSession } from './handshake.ts'

export const RELAY_PROTOCOL_VERSION = 1 as const

/** Versioned remote-control frame kinds accepted by the relay. */
export type RelayFrameKind =
  | 'handshake'
  | 'handshake-ack'
  | 'session-event'
  | 'prompt'
  | 'approval'
  | 'cancel'
  | 'presence'
  | 'ack'
  | 'error'

/** Short-lived bearer presented by a registered desktop or PWA device. */
export interface RelayAccessToken {
  readonly tokenId: string
  readonly userId: string
  readonly deviceId: string
  readonly expiresAt: number
}

/** Registered device whose Ed25519 key verifies handshakes. */
export interface RelayDevice {
  readonly deviceId: string
  readonly userId: string
  readonly publicKey: string
  readonly encryptionPublicKey?: string
  readonly revokedAt?: number
}

/** Actor claimed by one envelope. */
export interface RelayActor {
  readonly userId: string
  readonly deviceId: string
  readonly sessionId?: string
}

/**
 * Version-1 relay envelope. Sensitive application data lives only in
 * `ciphertext`; plaintext prompt, credential, and tool-output fields are refused.
 */
export interface RelayEnvelope {
  readonly protocolVersion: typeof RELAY_PROTOCOL_VERSION
  readonly id: string
  readonly kind: RelayFrameKind
  readonly sentAt: number
  readonly actor: RelayActor
  readonly ciphertext: string
}

/** Result of one authorized dispatch, including idempotent retries. */
export interface RelayDispatchResult {
  readonly id: string
  readonly outcome: 'accepted' | 'duplicate'
}

/** Same-account device-to-device route after an envelope is authorized. */
export interface RelayRoute {
  readonly envelopeId: string
  readonly userId: string
  readonly fromDeviceId: string
  readonly toDeviceId: string
  readonly outcome: 'accepted' | 'duplicate'
}

/** Durable lookups required before a frame may enter the routing plane. */
export interface RelayStore {
  getAccessToken(tokenId: string): RelayAccessToken | undefined
  getDevice(deviceId: string): RelayDevice | undefined
  getDispatch(id: string): { readonly envelopeHash: string, readonly result: RelayDispatchResult } | undefined
  putDispatch(id: string, envelopeHash: string, result: RelayDispatchResult): void
  hasNonce(deviceId: string, nonce: string): boolean
  putNonce(deviceId: string, nonce: string): void
  getSession(envelopeId: string): OutboundSession | undefined
  putSession(envelopeId: string, session: OutboundSession): void
}

/** Inputs for one control-plane dispatch. */
export interface RelayDispatchInput {
  readonly envelope: unknown
  readonly accessToken: string
  readonly store: RelayStore
  readonly now: number
}

const FRAME_KINDS = new Set<RelayFrameKind>([
  'handshake',
  'handshake-ack',
  'session-event',
  'prompt',
  'approval',
  'cancel',
  'presence',
  'ack',
  'error',
])

const PLAINTEXT_FIELDS = ['prompt', 'credential', 'credentials', 'toolOutput', 'plaintext'] as const

/** Reject plaintext application fields on any untrusted relay JSON object. */
export function assertNoPlaintextRelayFields(
  record: Record<string, unknown>,
  label = 'relay envelope',
): void {
  for (const field of PLAINTEXT_FIELDS) {
    if (field in record) {
      throw new RelayAuthorizationError('plaintext', `${label} must not carry plaintext field ${field}`)
    }
  }
}

/**
 * Parse one untrusted envelope. Unknown versions, malformed shape, and plaintext
 * application fields fail closed before token checks run.
 */
export function parseRelayEnvelope(value: unknown): RelayEnvelope {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new RelayAuthorizationError('malformed', 'relay envelope must be an object')
  }
  const record = value as Record<string, unknown>
  assertNoPlaintextRelayFields(record)
  if (record.protocolVersion !== RELAY_PROTOCOL_VERSION) {
    throw new RelayAuthorizationError('unknown-protocol', 'relay envelope protocol version is not supported')
  }
  if (typeof record.id !== 'string' || record.id.length === 0 || /[\0\r\n]/u.test(record.id)) {
    throw new RelayAuthorizationError('malformed', 'relay envelope id is required')
  }
  if (typeof record.kind !== 'string' || !FRAME_KINDS.has(record.kind as RelayFrameKind)) {
    throw new RelayAuthorizationError('malformed', 'relay envelope kind is not supported')
  }
  if (typeof record.sentAt !== 'number' || !Number.isFinite(record.sentAt)) {
    throw new RelayAuthorizationError('malformed', 'relay envelope sentAt is required')
  }
  if (typeof record.ciphertext !== 'string' || record.ciphertext.length === 0) {
    throw new RelayAuthorizationError('malformed', 'relay envelope ciphertext is required')
  }
  const actor = parseActor(record.actor)
  return {
    protocolVersion: RELAY_PROTOCOL_VERSION,
    id: record.id,
    kind: record.kind as RelayFrameKind,
    sentAt: record.sentAt,
    actor,
    ciphertext: record.ciphertext,
  }
}

/**
 * Authorize one envelope against the presented token and registered device.
 * Identical retries of the same id stay idempotent; a mutated payload is replay.
 */
export function dispatchRelayEnvelope(input: RelayDispatchInput): RelayDispatchResult {
  const envelope = parseRelayEnvelope(input.envelope)
  const token = input.store.getAccessToken(input.accessToken)
  if (token === undefined || token.expiresAt <= input.now) {
    throw new RelayAuthorizationError('expired-token', 'relay access token is unknown or expired')
  }
  if (token.userId !== envelope.actor.userId || token.deviceId !== envelope.actor.deviceId) {
    throw new RelayAuthorizationError('cross-account', 'relay actor does not match the presented token')
  }
  const device = input.store.getDevice(envelope.actor.deviceId)
  if (device === undefined || (device.revokedAt !== undefined && device.revokedAt <= input.now)) {
    throw new RelayAuthorizationError('revoked-device', 'relay device is unknown or revoked')
  }
  if (device.userId !== envelope.actor.userId) {
    throw new RelayAuthorizationError('cross-account', 'relay actor does not match the presented token')
  }
  const envelopeHash = hashEnvelope(envelope)
  const previous = input.store.getDispatch(envelope.id)
  if (previous !== undefined) {
    if (previous.envelopeHash !== envelopeHash) {
      throw new RelayAuthorizationError('replay', 'relay message id was reused with a different payload')
    }
    return { id: envelope.id, outcome: 'duplicate' }
  }
  const result: RelayDispatchResult = { id: envelope.id, outcome: 'accepted' }
  input.store.putDispatch(envelope.id, envelopeHash, result)
  return result
}

/** In-memory store for protocol tests and headless control-plane proofs. */
export function createMemoryRelayStore(): RelayStore & {
  putAccessToken(token: RelayAccessToken): void
  putDevice(device: RelayDevice): void
  getRoute(envelopeId: string): RelayRoute | undefined
  putRoute(route: RelayRoute): void
} {
  const tokens = new Map<string, RelayAccessToken>()
  const devices = new Map<string, RelayDevice>()
  const dispatches = new Map<string, { envelopeHash: string, result: RelayDispatchResult }>()
  const nonces = new Set<string>()
  const sessions = new Map<string, OutboundSession>()
  const routes = new Map<string, RelayRoute>()
  return {
    putAccessToken(token) { tokens.set(token.tokenId, token) },
    putDevice(device) { devices.set(device.deviceId, device) },
    getAccessToken(tokenId) { return tokens.get(tokenId) },
    getDevice(deviceId) { return devices.get(deviceId) },
    getDispatch(id) { return dispatches.get(id) },
    putDispatch(id, envelopeHash, result) { dispatches.set(id, { envelopeHash, result }) },
    hasNonce(deviceId, nonce) { return nonces.has(`${deviceId}:${nonce}`) },
    putNonce(deviceId, nonce) { nonces.add(`${deviceId}:${nonce}`) },
    getSession(envelopeId) { return sessions.get(envelopeId) },
    putSession(envelopeId, session) { sessions.set(envelopeId, session) },
    getRoute(envelopeId) { return routes.get(envelopeId) },
    putRoute(route) { routes.set(route.envelopeId, route) },
  }
}

function parseActor(value: unknown): RelayActor {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new RelayAuthorizationError('malformed', 'relay actor must be an object')
  }
  const record = value as Record<string, unknown>
  if (typeof record.userId !== 'string' || record.userId.length === 0) {
    throw new RelayAuthorizationError('malformed', 'relay actor userId is required')
  }
  if (typeof record.deviceId !== 'string' || record.deviceId.length === 0) {
    throw new RelayAuthorizationError('malformed', 'relay actor deviceId is required')
  }
  if (record.sessionId !== undefined && (typeof record.sessionId !== 'string' || record.sessionId.length === 0)) {
    throw new RelayAuthorizationError('malformed', 'relay actor sessionId is invalid')
  }
  return record.sessionId === undefined
    ? { userId: record.userId, deviceId: record.deviceId }
    : { userId: record.userId, deviceId: record.deviceId, sessionId: record.sessionId }
}

function hashEnvelope(envelope: RelayEnvelope): string {
  return JSON.stringify([
    envelope.protocolVersion,
    envelope.id,
    envelope.kind,
    envelope.sentAt,
    envelope.actor.userId,
    envelope.actor.deviceId,
    envelope.actor.sessionId ?? '',
    envelope.ciphertext,
  ])
}
