/** Short-lived relay access tokens. Issuance is local and replaceable later by OIDC. */

import { randomBytes } from 'node:crypto'
import { RelayAuthorizationError } from './errors.ts'
import type { RelayAccessToken, RelayStore } from './envelope.ts'

/** Default desktop/PWA access-token lifetime: fifteen minutes. */
export const RELAY_ACCESS_TOKEN_TTL_MS = 15 * 60 * 1000

/** Inputs for minting one device-bound access token. */
export interface IssueRelayAccessTokenInput {
  readonly userId: string
  readonly deviceId: string
  readonly now: number
  readonly ttlMs?: number
}

/** Newly minted token plus the store record it must be saved as. */
export interface IssuedRelayAccessToken {
  readonly accessToken: string
  readonly record: RelayAccessToken
}

/** Pluggable token factory. Production can swap this for an OIDC-backed issuer. */
export interface RelayTokenIssuer {
  issue(input: IssueRelayAccessTokenInput): IssuedRelayAccessToken
}

/**
 * Mint a random opaque token bound to one user and device.
 * Non-positive lifetimes and empty actor ids fail closed.
 */
export function issueRelayAccessToken(input: IssueRelayAccessTokenInput): IssuedRelayAccessToken {
  if (typeof input.userId !== 'string' || input.userId.length === 0 || /[\0\r\n]/u.test(input.userId)) {
    throw new RelayAuthorizationError('malformed', 'relay token userId is required')
  }
  if (typeof input.deviceId !== 'string' || input.deviceId.length === 0 || /[\0\r\n]/u.test(input.deviceId)) {
    throw new RelayAuthorizationError('malformed', 'relay token deviceId is required')
  }
  const ttlMs = input.ttlMs ?? RELAY_ACCESS_TOKEN_TTL_MS
  if (typeof ttlMs !== 'number' || !Number.isFinite(ttlMs) || ttlMs <= 0) {
    throw new RelayAuthorizationError('expired-token', 'relay token lifetime must be positive')
  }
  const tokenId = randomBytes(32).toString('base64url')
  return {
    accessToken: tokenId,
    record: {
      tokenId,
      userId: input.userId,
      deviceId: input.deviceId,
      expiresAt: input.now + ttlMs,
    },
  }
}

/** In-memory issuer that writes tokens into a relay store. */
export function createMemoryRelayTokenIssuer(
  store: RelayStore & { putAccessToken(token: RelayAccessToken): void },
): RelayTokenIssuer {
  return {
    issue(input) {
      const issued = issueRelayAccessToken(input)
      store.putAccessToken(issued.record)
      return issued
    },
  }
}
