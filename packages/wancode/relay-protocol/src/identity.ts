/** Replaceable OIDC identity seam. Production swaps this for a JWKS verifier. */

import { assertNoPlaintextRelayFields } from './envelope.ts'
import { RelayAuthorizationError } from './errors.ts'

/** Verified account identity after an identity provider accepts an assertion. */
export interface RelayIdentityClaims {
  readonly issuer: string
  readonly audience: string
  readonly userId: string
  readonly expiresAt: number
}

/** Pluggable identity verifier. Desktop and cloud share this contract. */
export interface RelayIdentityProvider {
  verify(assertion: unknown, now: number): RelayIdentityClaims
}

/** Expected issuer and audience for one static OIDC verifier. */
export interface OidcIdentityProviderConfig {
  readonly issuer: string
  readonly audience: string
}

function requiredText(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.length === 0 || /[\0\r\n]/u.test(value)) {
    throw new RelayAuthorizationError('malformed', `relay identity ${field} is required`)
  }
  return value
}

function requiredIssuerAudience(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.length === 0 || /[\0\r\n]/u.test(value)) {
    throw new RelayAuthorizationError('untrusted-identity', `relay identity ${field} is required`)
  }
  return value
}

/**
 * Parse one untrusted OIDC assertion object. `exp` is Unix seconds.
 * Signature verification belongs to the production JWKS provider.
 */
export function parseOidcIdentityAssertion(
  value: unknown,
  config: OidcIdentityProviderConfig,
  now: number,
): RelayIdentityClaims {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new RelayAuthorizationError('malformed', 'relay identity assertion must be an object')
  }
  const record = value as Record<string, unknown>
  assertNoPlaintextRelayFields(record, 'relay identity assertion')
  const issuer = requiredIssuerAudience(record.iss, 'iss')
  const audience = requiredIssuerAudience(record.aud, 'aud')
  if (issuer !== config.issuer || audience !== config.audience) {
    throw new RelayAuthorizationError('untrusted-identity', 'relay identity issuer or audience is not trusted')
  }
  if (typeof record.exp !== 'number' || !Number.isFinite(record.exp) || record.exp <= 0) {
    throw new RelayAuthorizationError('malformed', 'relay identity exp is required')
  }
  const expiresAt = Math.trunc(record.exp) * 1000
  if (expiresAt <= now) {
    throw new RelayAuthorizationError('expired-token', 'relay identity assertion is expired')
  }
  return {
    issuer,
    audience,
    userId: requiredText(record.sub, 'sub'),
    expiresAt,
  }
}

/**
 * In-memory OIDC verifier that accepts a parsed assertion object.
 * Replace this with a JWKS-backed JWT verifier in production.
 */
export function createStaticOidcIdentityProvider(
  config: OidcIdentityProviderConfig,
): RelayIdentityProvider {
  const issuer = requiredIssuerAudience(config.issuer, 'issuer')
  const audience = requiredIssuerAudience(config.audience, 'audience')
  return {
    verify(assertion, now) {
      return parseOidcIdentityAssertion(assertion, { issuer, audience }, now)
    },
  }
}
