/** Fail-closed authorization outcomes for the WanCodeNewVer relay protocol. */

/** Stable fail-closed authorization outcomes. */
export const RELAY_ERROR_CODES = [
  'replay',
  'expired-token',
  'revoked-device',
  'cross-account',
  'unknown-protocol',
  'malformed',
  'plaintext',
  'untrusted-key',
  'untrusted-identity',
  'inbound-forbidden',
  'unknown-capability',
  'cleartext-transport',
  'rate-limited',
] as const

export type RelayErrorCode = (typeof RELAY_ERROR_CODES)[number]

const ERROR_CODES = new Set<string>(RELAY_ERROR_CODES)

/** True when `code` is a documented fail-closed relay outcome. */
export function isRelayErrorCode(code: string): code is RelayErrorCode {
  return ERROR_CODES.has(code)
}

/** Authorization or envelope rejection that must not continue dispatch. */
export class RelayAuthorizationError extends Error {
  readonly code: RelayErrorCode

  constructor(code: RelayErrorCode, message: string) {
    super(message)
    this.name = 'RelayAuthorizationError'
    this.code = code
  }
}
