/** Ed25519 device keys used to sign outbound Wan Code relay handshakes. */

import {
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  sign,
  verify,
} from 'node:crypto'
import { RelayAuthorizationError } from './errors.ts'

/** Desktop-held device identity. The private key never leaves the device. */
export interface DeviceKeyPair {
  readonly publicKey: string
  readonly privateKey: string
}

/**
 * Create one Ed25519 device identity.
 * @returns SPKI/PKCS8 keys encoded as standard base64.
 */
export function generateDeviceKeyPair(): DeviceKeyPair {
  const pair = generateKeyPairSync('ed25519')
  return {
    publicKey: pair.publicKey.export({ type: 'spki', format: 'der' }).toString('base64'),
    privateKey: pair.privateKey.export({ type: 'pkcs8', format: 'der' }).toString('base64'),
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
  if (typeof publicKey !== 'string' || publicKey.length === 0 || /[\0\r\n]/u.test(publicKey)) {
    throw new RelayAuthorizationError('untrusted-key', 'relay device public key is required')
  }
  try {
    const key = publicKeyFrom(publicKey)
    if (key.asymmetricKeyType !== 'ed25519') {
      throw new Error('not ed25519')
    }
  } catch (cause) {
    if (cause instanceof RelayAuthorizationError) throw cause
    throw new RelayAuthorizationError('untrusted-key', 'relay device public key is not a valid Ed25519 SPKI key')
  }
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
