/** Desktop-initiated outbound handshake. The relay never dials the device. */

import {
  signDevicePayload,
  verifyDevicePayload,
  type DeviceKeyPair,
} from './device-keys.ts'
import { RelayAuthorizationError } from './errors.ts'
import {
  dispatchRelayEnvelope,
  parseRelayEnvelope,
  type RelayActor,
  type RelayDispatchInput,
  type RelayEnvelope,
} from './envelope.ts'

const HANDSHAKE_PREFIX = 'v1:hs:'
const ACK_PREFIX = 'v1:ack:'

/** Closed capability names a desktop handshake may request. */
export const RELAY_CAPABILITIES = [
  'session.observe',
  'session.prompt',
  'session.approve',
  'session.cancel',
] as const

export type RelayCapability = (typeof RELAY_CAPABILITIES)[number]

const ALLOWED_CAPABILITIES = new Set<string>(RELAY_CAPABILITIES)

/** Direction claimed by a handshake. Only outbound desktop dials are accepted. */
export type RelayHandshakeDirection = 'outbound' | 'inbound'

/** Public handshake claims signed by the device private key. */
export interface OutboundHandshakeClaims {
  readonly direction: RelayHandshakeDirection
  readonly nonce: string
  readonly publicKey: string
  readonly capabilities: readonly string[]
}

/** Authorized outbound session returned after a verified handshake. */
export interface OutboundSession {
  readonly sessionId: string
  readonly userId: string
  readonly deviceId: string
  readonly grantedCapabilities: readonly RelayCapability[]
  readonly ack: RelayEnvelope
}

/** Inputs used by desktop to mint a signed handshake envelope. */
export interface SignedHandshakeEnvelopeInput {
  readonly id: string
  readonly sentAt: number
  readonly actor: RelayActor
  readonly keyPair: DeviceKeyPair
  readonly nonce: string
  readonly capabilities: readonly string[]
  readonly direction?: RelayHandshakeDirection
}

/**
 * Build a version-1 handshake envelope signed by the device private key.
 * Sensitive application data is not included; the blob is a signed claim set.
 */
export function createSignedHandshakeEnvelope(
  input: SignedHandshakeEnvelopeInput,
): Record<string, unknown> {
  const claims: OutboundHandshakeClaims = {
    direction: input.direction ?? 'outbound',
    nonce: input.nonce,
    publicKey: input.keyPair.publicKey,
    capabilities: [...input.capabilities],
  }
  const signature = signDevicePayload(input.keyPair.privateKey, canonicalClaims(claims))
  return {
    protocolVersion: 1,
    id: input.id,
    kind: 'handshake',
    sentAt: input.sentAt,
    actor: input.actor,
    ciphertext: `${HANDSHAKE_PREFIX}${Buffer.from(JSON.stringify({ claims, signature }), 'utf8').toString('base64')}`,
  }
}

/**
 * Verify a desktop-outbound handshake and open a session.
 * Inbound claims, untrusted keys, unknown capabilities, and nonce reuse fail closed.
 */
export function openOutboundSession(input: RelayDispatchInput): OutboundSession {
  const envelope = parseRelayEnvelope(input.envelope)
  if (envelope.kind !== 'handshake') {
    throw new RelayAuthorizationError('malformed', 'outbound session requires a handshake envelope')
  }
  const device = authorizeHandshakeDevice(envelope, input)
  const handshake = parseSignedHandshake(envelope.ciphertext)
  if (handshake.claims.direction !== 'outbound') {
    throw new RelayAuthorizationError('inbound-forbidden', 'relay does not open inbound connections to devices')
  }
  if (handshake.claims.publicKey !== device.publicKey) {
    throw new RelayAuthorizationError('untrusted-key', 'handshake public key does not match the registered device')
  }
  if (!verifyDevicePayload(device.publicKey, canonicalClaims(handshake.claims), handshake.signature)) {
    throw new RelayAuthorizationError('untrusted-key', 'handshake signature is not valid for the registered device')
  }
  const granted = grantedCapabilities(handshake.claims.capabilities)
  const previous = input.store.getDispatch(envelope.id)
  if (input.store.hasNonce(envelope.actor.deviceId, handshake.claims.nonce) && previous === undefined) {
    throw new RelayAuthorizationError('replay', 'handshake nonce was reused')
  }
  const dispatched = dispatchRelayEnvelope(input)
  if (dispatched.outcome === 'duplicate') {
    const session = input.store.getSession(envelope.id)
    if (session === undefined) {
      throw new RelayAuthorizationError('malformed', 'duplicate handshake is missing its session')
    }
    return session
  }
  const session = createSession(envelope, granted, handshake.claims.nonce, input.now)
  input.store.putNonce(envelope.actor.deviceId, handshake.claims.nonce)
  input.store.putSession(envelope.id, session)
  return session
}

function authorizeHandshakeDevice(envelope: RelayEnvelope, input: RelayDispatchInput): { publicKey: string } {
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
  return device
}

function parseSignedHandshake(ciphertext: string): {
  claims: OutboundHandshakeClaims
  signature: string
} {
  if (!ciphertext.startsWith(HANDSHAKE_PREFIX)) {
    throw new RelayAuthorizationError('malformed', 'handshake ciphertext is not a signed claim set')
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(Buffer.from(ciphertext.slice(HANDSHAKE_PREFIX.length), 'base64').toString('utf8'))
  } catch {
    throw new RelayAuthorizationError('malformed', 'handshake ciphertext is not a signed claim set')
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new RelayAuthorizationError('malformed', 'handshake ciphertext is not a signed claim set')
  }
  const record = parsed as Record<string, unknown>
  if (typeof record.signature !== 'string' || record.signature.length === 0) {
    throw new RelayAuthorizationError('malformed', 'handshake signature is required')
  }
  return {
    claims: parseClaims(record.claims),
    signature: record.signature,
  }
}

function parseClaims(value: unknown): OutboundHandshakeClaims {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new RelayAuthorizationError('malformed', 'handshake claims are required')
  }
  const record = value as Record<string, unknown>
  if (record.direction !== 'outbound' && record.direction !== 'inbound') {
    throw new RelayAuthorizationError('malformed', 'handshake direction is required')
  }
  if (typeof record.nonce !== 'string' || record.nonce.length === 0 || /[\0\r\n]/u.test(record.nonce) || record.nonce.length > 128) {
    throw new RelayAuthorizationError('malformed', 'handshake nonce is required')
  }
  if (typeof record.publicKey !== 'string' || record.publicKey.length === 0) {
    throw new RelayAuthorizationError('malformed', 'handshake public key is required')
  }
  if (!Array.isArray(record.capabilities) || record.capabilities.some(item => typeof item !== 'string')) {
    throw new RelayAuthorizationError('malformed', 'handshake capabilities are required')
  }
  return {
    direction: record.direction,
    nonce: record.nonce,
    publicKey: record.publicKey,
    capabilities: record.capabilities,
  }
}

function grantedCapabilities(requested: readonly string[]): readonly RelayCapability[] {
  const granted: RelayCapability[] = []
  for (const capability of requested) {
    if (!ALLOWED_CAPABILITIES.has(capability)) {
      throw new RelayAuthorizationError('unknown-capability', `handshake capability ${capability} is not supported`)
    }
    if (!granted.includes(capability as RelayCapability)) granted.push(capability as RelayCapability)
  }
  return granted
}

function createSession(
  envelope: RelayEnvelope,
  grantedCapabilities: readonly RelayCapability[],
  nonce: string,
  now: number,
): OutboundSession {
  const sessionId = `sess:${envelope.actor.deviceId}:${nonce}`
  const ackBody = Buffer.from(JSON.stringify({
    sessionId,
    grantedCapabilities,
    nonce,
  }), 'utf8').toString('base64')
  return {
    sessionId,
    userId: envelope.actor.userId,
    deviceId: envelope.actor.deviceId,
    grantedCapabilities,
    ack: {
      protocolVersion: 1,
      id: `${envelope.id}:ack`,
      kind: 'handshake-ack',
      sentAt: now,
      actor: {
        userId: envelope.actor.userId,
        deviceId: envelope.actor.deviceId,
        sessionId,
      },
      ciphertext: `${ACK_PREFIX}${ackBody}`,
    },
  }
}

function canonicalClaims(claims: OutboundHandshakeClaims): Uint8Array {
  return Buffer.from(JSON.stringify({
    direction: claims.direction,
    nonce: claims.nonce,
    publicKey: claims.publicKey,
    capabilities: [...claims.capabilities],
  }), 'utf8')
}
