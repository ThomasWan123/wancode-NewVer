/** Ed25519 signing keys and X25519 encryption keys for Wan Code devices. */

import {
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  sign,
  verify,
} from 'node:crypto'
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
