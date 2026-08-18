/** Device registration and revocation after a verified identity. */

import { assertDevicePublicKey } from './device-keys.ts'
import type { RelayDevice, RelayStore } from './envelope.ts'
import { RelayAuthorizationError } from './errors.ts'
import type { RelayIdentityClaims } from './identity.ts'

/** Store that can persist registered devices. */
export type RelayDeviceStore = RelayStore & {
  putDevice(device: RelayDevice): void
}

/** Inputs for binding one device public key to a verified account. */
export interface RegisterRelayDeviceInput {
  readonly identity: RelayIdentityClaims
  readonly deviceId: string
  readonly publicKey: string
  readonly now: number
  readonly store: RelayDeviceStore
}

/** Inputs for immediately revoking one owned device. */
export interface RevokeRelayDeviceInput {
  readonly userId: string
  readonly deviceId: string
  readonly now: number
  readonly store: RelayDeviceStore
}

function requiredId(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.length === 0 || /[\0\r\n]/u.test(value)) {
    throw new RelayAuthorizationError('malformed', `relay ${field} is required`)
  }
  return value
}

/**
 * Register a desktop or PWA device for a verified identity.
 * A revoked device id cannot be reused. A live device cannot change accounts.
 */
export function registerRelayDevice(input: RegisterRelayDeviceInput): RelayDevice {
  if (input.identity.expiresAt <= input.now) {
    throw new RelayAuthorizationError('expired-token', 'relay identity assertion is expired')
  }
  const deviceId = requiredId(input.deviceId, 'deviceId')
  const userId = requiredId(input.identity.userId, 'userId')
  assertDevicePublicKey(input.publicKey)
  const existing = input.store.getDevice(deviceId)
  if (existing !== undefined) {
    if (existing.userId !== userId) {
      throw new RelayAuthorizationError('cross-account', 'relay device already belongs to another account')
    }
    if (existing.revokedAt !== undefined && existing.revokedAt <= input.now) {
      throw new RelayAuthorizationError('revoked-device', 'relay device id was revoked and cannot be reused')
    }
    if (existing.publicKey !== input.publicKey) {
      throw new RelayAuthorizationError('untrusted-key', 'relay device public key does not match the registered key')
    }
    return existing
  }
  const device: RelayDevice = {
    deviceId,
    userId,
    publicKey: input.publicKey,
  }
  input.store.putDevice(device)
  return device
}

/**
 * Revoke one owned device immediately. Repeat revokes of the same device stay idempotent.
 */
export function revokeRelayDevice(input: RevokeRelayDeviceInput): RelayDevice {
  const deviceId = requiredId(input.deviceId, 'deviceId')
  const userId = requiredId(input.userId, 'userId')
  const existing = input.store.getDevice(deviceId)
  if (existing === undefined) {
    throw new RelayAuthorizationError('revoked-device', 'relay device is unknown or revoked')
  }
  if (existing.userId !== userId) {
    throw new RelayAuthorizationError('cross-account', 'relay device already belongs to another account')
  }
  if (existing.revokedAt !== undefined && existing.revokedAt <= input.now) {
    return existing
  }
  const device: RelayDevice = {
    ...existing,
    revokedAt: input.now,
  }
  input.store.putDevice(device)
  return device
}
