/** Ed25519 signing keys and X25519 encryption keys for Wan Code devices. */

import {
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  randomBytes,
  sign,
  verify,
} from 'node:crypto'
import { assertNoPlaintextRelayFields } from './envelope.ts'
import { RelayAuthorizationError } from './errors.ts'

/** Desktop-held device identity. Private keys never leave the device. */
export interface DeviceKeyPair {
  readonly publicKey: string
  readonly privateKey: string
  readonly encryptionPublicKey: string
  readonly encryptionPrivateKey: string
}

/**
 * Create one Ed25519 signing identity plus an X25519 encryption identity.
 * @returns SPKI/PKCS8 keys encoded as standard base64.
 */
export function generateDeviceKeyPair(): DeviceKeyPair {
  const signing = generateKeyPairSync('ed25519')
  const encryption = generateKeyPairSync('x25519')
  return {
    publicKey: signing.publicKey.export({ type: 'spki', format: 'der' }).toString('base64'),
    privateKey: signing.privateKey.export({ type: 'pkcs8', format: 'der' }).toString('base64'),
    encryptionPublicKey: encryption.publicKey.export({ type: 'spki', format: 'der' }).toString('base64'),
    encryptionPrivateKey: encryption.privateKey.export({ type: 'pkcs8', format: 'der' }).toString('base64'),
  }
}

/**
 * Sign canonical UTF-8 bytes with the device private key.
 * @param privateKey - PKCS8 Ed25519 key as standard base64.
 * @param payload - canonical bytes that will later be verified.
 */
export function signDevicePayload(privateKey: string, payload: Uint8Array): string {
  return sign(null, payload, privateKeyFrom(privateKey)).toString('base64')
}

/**
 * Verify a device signature against a registered public key.
 * @param publicKey - SPKI Ed25519 key as standard base64.
 * @param payload - canonical bytes that were signed.
 * @param signature - standard-base64 Ed25519 signature.
 */
export function verifyDevicePayload(publicKey: string, payload: Uint8Array, signature: string): boolean {
  try {
    return verify(null, payload, publicKeyFrom(publicKey), Buffer.from(signature, 'base64'))
  } catch {
    return false
  }
}

/**
 * Refuse a device public key that is not a valid Ed25519 SPKI blob.
 * @param publicKey - SPKI Ed25519 key as standard base64.
 */
export function assertDevicePublicKey(publicKey: string): void {
  assertKey(publicKey, 'ed25519', 'relay device public key')
}

/**
 * Refuse an encryption public key that is not a valid X25519 SPKI blob.
 * @param publicKey - SPKI X25519 key as standard base64.
 */
export function assertDeviceEncryptionPublicKey(publicKey: string): void {
  assertKey(publicKey, 'x25519', 'relay device encryption public key')
}

/** Durable desktop identity. Private keys stay on the device. */
export interface StoredDeviceIdentity {
  readonly deviceId: string
  readonly keyPair: DeviceKeyPair
}

/** Public device fields that may leave the secure store. */
export interface PublicDeviceIdentity {
  readonly deviceId: string
  readonly publicKey: string
  readonly encryptionPublicKey: string
}

/**
 * Create one stored identity. A caller-supplied device id must be 32 hex chars.
 */
export function createStoredDeviceIdentity(
  keyPair: DeviceKeyPair = generateDeviceKeyPair(),
  deviceId: string = randomBytes(16).toString('hex'),
): StoredDeviceIdentity {
  return parseStoredDeviceIdentity(JSON.stringify({
    protocolVersion: 1,
    deviceId,
    publicKey: keyPair.publicKey,
    privateKey: keyPair.privateKey,
    encryptionPublicKey: keyPair.encryptionPublicKey,
    encryptionPrivateKey: keyPair.encryptionPrivateKey,
  }))
}

/**
 * Encode one stored identity for a secure store. This blob contains private keys.
 */
export function serializeStoredDeviceIdentity(identity: StoredDeviceIdentity): string {
  return JSON.stringify({
    protocolVersion: 1,
    deviceId: identity.deviceId,
    publicKey: identity.keyPair.publicKey,
    privateKey: identity.keyPair.privateKey,
    encryptionPublicKey: identity.keyPair.encryptionPublicKey,
    encryptionPrivateKey: identity.keyPair.encryptionPrivateKey,
  })
}

/**
 * Parse one stored identity. Plaintext application fields, missing private
 * keys, and public keys that do not match the private material fail closed.
 */
export function parseStoredDeviceIdentity(raw: string): StoredDeviceIdentity {
  if (typeof raw !== 'string' || raw.length === 0) {
    throw new RelayAuthorizationError('malformed', 'relay stored device identity is required')
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    throw new RelayAuthorizationError('malformed', 'relay stored device identity is not json')
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new RelayAuthorizationError('malformed', 'relay stored device identity must be an object')
  }
  const record = parsed as Record<string, unknown>
  assertNoPlaintextRelayFields(record, 'relay stored device identity')
  if (record.protocolVersion !== 1) {
    throw new RelayAuthorizationError('unknown-protocol', 'relay stored device identity version is not supported')
  }
  if (typeof record.deviceId !== 'string' || !/^[0-9a-f]{32}$/u.test(record.deviceId)) {
    throw new RelayAuthorizationError('malformed', 'relay stored device id is required')
  }
  const keyPair = {
    publicKey: requiredKey(record.publicKey, 'publicKey'),
    privateKey: requiredKey(record.privateKey, 'privateKey'),
    encryptionPublicKey: requiredKey(record.encryptionPublicKey, 'encryptionPublicKey'),
    encryptionPrivateKey: requiredKey(record.encryptionPrivateKey, 'encryptionPrivateKey'),
  }
  assertMatchingKeyPair(keyPair.privateKey, keyPair.publicKey, 'ed25519', 'relay device')
  assertMatchingKeyPair(
    keyPair.encryptionPrivateKey,
    keyPair.encryptionPublicKey,
    'x25519',
    'relay device encryption',
  )
  return { deviceId: record.deviceId, keyPair }
}

/** Return the fields that may be registered or logged. Private keys stay out. */
export function publicDeviceIdentity(identity: StoredDeviceIdentity): PublicDeviceIdentity {
  return {
    deviceId: identity.deviceId,
    publicKey: identity.keyPair.publicKey,
    encryptionPublicKey: identity.keyPair.encryptionPublicKey,
  }
}

function requiredKey(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.length === 0 || /[\0\r\n]/u.test(value)) {
    throw new RelayAuthorizationError('untrusted-key', `relay device ${field} is required`)
  }
  return value
}

function assertMatchingKeyPair(
  privateKey: string,
  publicKey: string,
  type: 'ed25519' | 'x25519',
  label: string,
): void {
  let derived: string
  try {
    const key = privateKeyFrom(privateKey)
    if (key.asymmetricKeyType !== type) {
      throw new Error(`not ${type}`)
    }
    derived = createPublicKey(key).export({ type: 'spki', format: 'der' }).toString('base64')
  } catch (cause) {
    if (cause instanceof RelayAuthorizationError) throw cause
    throw new RelayAuthorizationError('untrusted-key', `${label} private key is not a valid ${type.toUpperCase()} PKCS8 key`)
  }
  assertKey(publicKey, type, `${label} public key`)
  if (derived !== publicKey) {
    throw new RelayAuthorizationError('untrusted-key', `${label} public key does not match the private key`)
  }
}

function assertKey(publicKey: string, type: 'ed25519' | 'x25519', label: string): void {
  if (typeof publicKey !== 'string' || publicKey.length === 0 || /[\0\r\n]/u.test(publicKey)) {
    throw new RelayAuthorizationError('untrusted-key', `${label} is required`)
  }
  try {
    const key = publicKeyFrom(publicKey)
    if (key.asymmetricKeyType !== type) {
      throw new Error(`not ${type}`)
    }
  } catch (cause) {
    if (cause instanceof RelayAuthorizationError) throw cause
    throw new RelayAuthorizationError('untrusted-key', `${label} is not a valid ${type.toUpperCase()} SPKI key`)
  }
}

export function encryptionPrivateKeyFrom(privateKey: string): ReturnType<typeof createPrivateKey> {
  return privateKeyFrom(privateKey)
}

export function encryptionPublicKeyFrom(publicKey: string): ReturnType<typeof createPublicKey> {
  return publicKeyFrom(publicKey)
}

function privateKeyFrom(privateKey: string): ReturnType<typeof createPrivateKey> {
  return createPrivateKey({
    key: Buffer.from(privateKey, 'base64'),
    format: 'der',
    type: 'pkcs8',
  })
}

function publicKeyFrom(publicKey: string): ReturnType<typeof createPublicKey> {
  return createPublicKey({
    key: Buffer.from(publicKey, 'base64'),
    format: 'der',
    type: 'spki',
  })
}
