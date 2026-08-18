/** Fail-closed authorization outcomes for the Wan Code relay protocol. */

/** Stable fail-closed authorization outcomes. */
export type RelayErrorCode =
  | 'replay'
  | 'expired-token'
  | 'revoked-device'
  | 'cross-account'
  | 'unknown-protocol'
  | 'malformed'
  | 'plaintext'
  | 'untrusted-key'
  | 'inbound-forbidden'
  | 'unknown-capability'

/** Authorization or envelope rejection that must not continue dispatch. */
export class RelayAuthorizationError extends Error {
  readonly code: RelayErrorCode

  constructor(code: RelayErrorCode, message: string) {
    super(message)
    this.name = 'RelayAuthorizationError'
    this.code = code
  }
}
