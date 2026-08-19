/** Device-to-device sealed application payloads. The relay never opens these boxes. */

import {
  createCipheriv,
  createDecipheriv,
  diffieHellman,
  hkdfSync,
  randomBytes,
} from 'node:crypto'
import {
  assertDeviceEncryptionPublicKey,
  encryptionPrivateKeyFrom,
  encryptionPublicKeyFrom,
  type DeviceKeyPair,
} from './device-keys.ts'
import {
  assertNoPlaintextRelayFields,
  parseRelayEnvelope,
  type RelayActor,
  type RelayEnvelope,
  type RelayFrameKind,
} from './envelope.ts'
import { RelayAuthorizationError } from './errors.ts'

const BOX_PREFIX = 'v1:box:'
const HKDF_INFO = 'wancode-relay-v1'
const APPLICATION_KINDS = new Set<RelayFrameKind>([
  'session-event',
  'prompt',
  'approval',
  'cancel',
  'presence',
])

export type RelayApplicationKind = 'session-event' | 'prompt' | 'approval' | 'cancel' | 'presence'

/** Application object sealed inside ciphertext. Field names avoid envelope plaintext keys. */
export type RelayApplicationPayload =
  | { readonly kind: 'prompt', readonly sessionId: string, readonly text: string }
  | { readonly kind: 'approval', readonly sessionId: string, readonly requestId: string, readonly approved: boolean }
  | { readonly kind: 'cancel', readonly sessionId: string, readonly requestId: string }
  | { readonly kind: 'session-event', readonly sessionId: string, readonly type: string, readonly detail: string }
  | { readonly kind: 'presence', readonly state: 'online' | 'offline' }

/** Inputs used by a device to mint a sealed application envelope. */
export interface SealedRelayEnvelopeInput {
  readonly id: string
  readonly sentAt: number
  readonly actor: RelayActor
  readonly kind: RelayApplicationKind
  readonly sender: DeviceKeyPair
  readonly recipientEncryptionPublicKey: string
  readonly payload: RelayApplicationPayload
}

/**
 * Parse one application envelope and refuse anything that is not a sealed box.
 * The relay does not decrypt; it only checks that ciphertext is a v1 box.
 */
export function assertSealedApplicationEnvelope(envelope: unknown): RelayEnvelope {
  const parsed = parseRelayEnvelope(envelope)
  if (!APPLICATION_KINDS.has(parsed.kind)) {
    throw new RelayAuthorizationError('malformed', 'relay application envelope kind is required')
  }
  parseSealedBox(parsed.ciphertext)
  return parsed
}

/**
 * Build one application envelope whose ciphertext is readable only by the
 * recipient encryption private key. The relay stores this blob opaquely.
 */
export function createSealedRelayEnvelope(input: SealedRelayEnvelopeInput): Record<string, unknown> {
  if (input.payload.kind !== input.kind) {
    throw new RelayAuthorizationError('malformed', 'relay sealed payload kind must match the envelope kind')
  }
  if (!APPLICATION_KINDS.has(input.kind)) {
    throw new RelayAuthorizationError('malformed', 'relay sealed envelope kind is not an application frame')
  }
  assertDeviceEncryptionPublicKey(input.sender.encryptionPublicKey)
  assertDeviceEncryptionPublicKey(input.recipientEncryptionPublicKey)
  const payload = parseApplicationPayload(input.payload)
  const aad = associatedData({
    id: input.id,
    kind: input.kind,
    sentAt: input.sentAt,
    actor: input.actor,
  })
  const key = deriveBoxKey(
    input.sender.encryptionPrivateKey,
    input.recipientEncryptionPublicKey,
    input.id,
  )
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', key, iv)
  cipher.setAAD(aad)
  const encrypted = Buffer.concat([cipher.update(JSON.stringify(payload), 'utf8'), cipher.final()])
  const box = {
    alg: 'x25519-hkdf-aes-256-gcm',
    senderEncryptionPublicKey: input.sender.encryptionPublicKey,
    iv: iv.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'),
    ciphertext: encrypted.toString('base64'),
  }
  assertNoPlaintextRelayFields(box, 'relay sealed box')
  return {
    protocolVersion: 1,
    id: input.id,
    kind: input.kind,
    sentAt: input.sentAt,
    actor: input.actor,
    ciphertext: `${BOX_PREFIX}${Buffer.from(JSON.stringify(box), 'utf8').toString('base64')}`,
  }
}

/**
 * Open a sealed application envelope with the recipient encryption private key.
 * The wrong key, a mutated box, or plaintext application fields fail closed.
 */
export function openSealedRelayPayload(
  envelope: unknown,
  recipient: DeviceKeyPair,
): RelayApplicationPayload {
  const parsed = parseRelayEnvelope(envelope)
  const box = parseSealedBox(parsed.ciphertext)
  assertDeviceEncryptionPublicKey(box.senderEncryptionPublicKey)
  assertDeviceEncryptionPublicKey(recipient.encryptionPublicKey)
  const aad = associatedData(parsed)
  const key = deriveBoxKey(
    recipient.encryptionPrivateKey,
    box.senderEncryptionPublicKey,
    parsed.id,
  )
  try {
    const decipher = createDecipheriv(
      'aes-256-gcm',
      key,
      Buffer.from(box.iv, 'base64'),
    )
    decipher.setAAD(aad)
    decipher.setAuthTag(Buffer.from(box.tag, 'base64'))
    const plain = Buffer.concat([
      decipher.update(Buffer.from(box.ciphertext, 'base64')),
      decipher.final(),
    ]).toString('utf8')
    const record = JSON.parse(plain) as unknown
    if (record === null || typeof record !== 'object' || Array.isArray(record)) {
      throw new RelayAuthorizationError('malformed', 'relay sealed payload must be an object')
    }
    assertNoPlaintextRelayFields(record as Record<string, unknown>, 'relay sealed payload')
    const payload = parseApplicationPayload(record)
    if (payload.kind !== parsed.kind) {
      throw new RelayAuthorizationError('malformed', 'relay sealed payload kind must match the envelope kind')
    }
    return payload
  } catch (cause) {
    if (cause instanceof RelayAuthorizationError) throw cause
    throw new RelayAuthorizationError('untrusted-key', 'relay sealed payload cannot be opened with this device key')
  }
}

function parseSealedBox(ciphertext: string): {
  alg: string
  senderEncryptionPublicKey: string
  iv: string
  tag: string
  ciphertext: string
} {
  if (!ciphertext.startsWith(BOX_PREFIX)) {
    throw new RelayAuthorizationError('malformed', 'relay sealed ciphertext is required')
  }
  let record: Record<string, unknown>
  try {
    record = JSON.parse(Buffer.from(ciphertext.slice(BOX_PREFIX.length), 'base64').toString('utf8')) as Record<string, unknown>
  } catch {
    throw new RelayAuthorizationError('malformed', 'relay sealed ciphertext is required')
  }
  if (record === null || typeof record !== 'object' || Array.isArray(record)) {
    throw new RelayAuthorizationError('malformed', 'relay sealed ciphertext is required')
  }
  assertNoPlaintextRelayFields(record, 'relay sealed box')
  if (record.alg !== 'x25519-hkdf-aes-256-gcm') {
    throw new RelayAuthorizationError('unknown-protocol', 'relay sealed algorithm is not supported')
  }
  for (const field of ['senderEncryptionPublicKey', 'iv', 'tag', 'ciphertext'] as const) {
    if (typeof record[field] !== 'string' || record[field].length === 0) {
      throw new RelayAuthorizationError('malformed', `relay sealed ${field} is required`)
    }
  }
  return {
    alg: 'x25519-hkdf-aes-256-gcm',
    senderEncryptionPublicKey: record.senderEncryptionPublicKey as string,
    iv: record.iv as string,
    tag: record.tag as string,
    ciphertext: record.ciphertext as string,
  }
}

function parseApplicationPayload(value: unknown): RelayApplicationPayload {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new RelayAuthorizationError('malformed', 'relay sealed payload must be an object')
  }
  const record = value as Record<string, unknown>
  assertNoPlaintextRelayFields(record, 'relay sealed payload')
  const kind = record.kind
  if (kind === 'prompt') {
    return {
      kind,
      sessionId: requiredText(record.sessionId, 'sessionId'),
      text: requiredText(record.text, 'text'),
    }
  }
  if (kind === 'approval') {
    if (typeof record.approved !== 'boolean') {
      throw new RelayAuthorizationError('malformed', 'relay sealed approved is required')
    }
    return {
      kind,
      sessionId: requiredText(record.sessionId, 'sessionId'),
      requestId: requiredText(record.requestId, 'requestId'),
      approved: record.approved,
    }
  }
  if (kind === 'cancel') {
    return {
      kind,
      sessionId: requiredText(record.sessionId, 'sessionId'),
      requestId: requiredText(record.requestId, 'requestId'),
    }
  }
  if (kind === 'session-event') {
    return {
      kind,
      sessionId: requiredText(record.sessionId, 'sessionId'),
      type: requiredText(record.type, 'type'),
      detail: requiredText(record.detail, 'detail'),
    }
  }
  if (kind === 'presence') {
    if (record.state !== 'online' && record.state !== 'offline') {
      throw new RelayAuthorizationError('malformed', 'relay sealed presence state is invalid')
    }
    return { kind, state: record.state }
  }
  throw new RelayAuthorizationError('malformed', 'relay sealed payload kind is not supported')
}

function requiredText(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.length === 0 || /[\0\r\n]/u.test(value)) {
    throw new RelayAuthorizationError('malformed', `relay sealed ${field} is required`)
  }
  return value
}

function associatedData(envelope: {
  id: string
  kind: RelayFrameKind | RelayApplicationKind
  sentAt: number
  actor: RelayActor
}): Buffer {
  return Buffer.from([
    envelope.id,
    envelope.kind,
    String(envelope.sentAt),
    envelope.actor.userId,
    envelope.actor.deviceId,
    envelope.actor.sessionId ?? '',
  ].join('\n'), 'utf8')
}

function deriveBoxKey(
  privateKey: string,
  peerPublicKey: string,
  envelopeId: string,
): Buffer {
  const shared = diffieHellman({
    privateKey: encryptionPrivateKeyFrom(privateKey),
    publicKey: encryptionPublicKeyFrom(peerPublicKey),
  })
  return Buffer.from(hkdfSync('sha256', shared, Buffer.from(envelopeId, 'utf8'), HKDF_INFO, 32))
}
