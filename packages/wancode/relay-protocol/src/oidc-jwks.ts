/** JWKS-backed OIDC verifier. JWT verify stays synchronous; fetch is opt-in. */

import { createPublicKey, verify as verifySignature, type KeyObject } from 'node:crypto'
import { assertNoPlaintextRelayFields } from './envelope.ts'
import { RelayAuthorizationError } from './errors.ts'
import {
  parseOidcIdentityAssertion,
  type OidcIdentityProviderConfig,
  type RelayIdentityProvider,
} from './identity.ts'

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1', '[::1]'])
const SIGNING_ALGS = new Set(['ES256', 'RS256'])

/** One JWK set returned by a caller-supplied resolver. */
export interface RelayJsonWebKeySet {
  readonly keys: readonly Record<string, unknown>[]
}

/** Expected issuer, audience, and a synchronous JWKS resolver. */
export interface JwksOidcIdentityProviderConfig extends OidcIdentityProviderConfig {
  readonly resolveJwks: () => RelayJsonWebKeySet
}

/**
 * Accept an OIDC JWKS URL that a later fetcher may load.
 * Production uses `https:`. Cleartext `http:` is loopback-only. Credentials
 * must not appear on the URL.
 */
export function assertOidcJwksUrl(url: string): URL {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    throw new RelayAuthorizationError('malformed', 'relay identity jwks url is not a valid url')
  }
  if (parsed.username !== '' || parsed.password !== '') {
    throw new RelayAuthorizationError('plaintext', 'relay identity jwks url must not embed credentials')
  }
  for (const key of parsed.searchParams.keys()) {
    if (/token|secret|credential|password|authorization/iu.test(key)) {
      throw new RelayAuthorizationError('plaintext', 'relay identity jwks url must not carry credentials')
    }
  }
  if (parsed.protocol === 'https:') return parsed
  if (parsed.protocol === 'http:' && LOOPBACK_HOSTS.has(parsed.hostname)) return parsed
  if (parsed.protocol === 'http:') {
    throw new RelayAuthorizationError(
      'cleartext-transport',
      'cleartext jwks is only allowed to loopback',
    )
  }
  throw new RelayAuthorizationError('malformed', 'relay identity jwks url must use https or loopback http')
}

const MAX_JWKS_BYTES = 65_536
const MAX_JWKS_REDIRECTS = 3

/** Minimal GET used by `fetchOidcJwks`. Tests inject a fake transport. */
export interface RelayJwksFetch {
  (
    url: string,
    init: {
      readonly method: 'GET'
      readonly redirect: 'manual'
      readonly headers: { readonly accept: string }
    },
  ): Promise<{
    readonly ok: boolean
    readonly status: number
    readonly headers: { get(name: string): string | null }
    arrayBuffer(): Promise<ArrayBuffer>
  }>
}

/**
 * Load one JWKS over HTTPS (or loopback HTTP). Redirects are re-checked
 * against the same URL policy. The request never carries credentials.
 */
export async function fetchOidcJwks(
  url: string,
  fetchImpl: RelayJwksFetch = globalThis.fetch as RelayJwksFetch,
): Promise<RelayJsonWebKeySet> {
  let current = assertOidcJwksUrl(url)
  for (let hop = 0; hop <= MAX_JWKS_REDIRECTS; hop++) {
    let response: Awaited<ReturnType<RelayJwksFetch>>
    try {
      response = await fetchImpl(current.href, {
        method: 'GET',
        redirect: 'manual',
        headers: { accept: 'application/json, application/jwk-set+json' },
      })
    } catch {
      throw new RelayAuthorizationError('untrusted-identity', 'relay identity jwks could not be fetched')
    }
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get('location')
      if (typeof location !== 'string' || location.length === 0) {
        throw new RelayAuthorizationError('malformed', 'relay identity jwks redirect is missing')
      }
      current = assertOidcJwksUrl(new URL(location, current).href)
      continue
    }
    if (!response.ok) {
      throw new RelayAuthorizationError('untrusted-identity', 'relay identity jwks fetch was not successful')
    }
    const bytes = Buffer.from(await response.arrayBuffer())
    if (bytes.byteLength === 0 || bytes.byteLength > MAX_JWKS_BYTES) {
      throw new RelayAuthorizationError('malformed', 'relay identity jwks body is invalid')
    }
    return parseRelayJsonWebKeySet(bytes.toString('utf8'))
  }
  throw new RelayAuthorizationError('untrusted-identity', 'relay identity jwks redirected too many times')
}

/** Parse one JWKS JSON document. Private key material fails closed. */
export function parseRelayJsonWebKeySet(raw: string): RelayJsonWebKeySet {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    throw new RelayAuthorizationError('malformed', 'relay identity jwks is not json')
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new RelayAuthorizationError('malformed', 'relay identity jwks must be an object')
  }
  const record = parsed as Record<string, unknown>
  assertNoPlaintextRelayFields(record, 'relay identity jwks')
  if (!Array.isArray(record.keys)) {
    throw new RelayAuthorizationError('untrusted-identity', 'relay identity jwks is invalid')
  }
  const keys = record.keys.map(key => {
    if (key === null || typeof key !== 'object' || Array.isArray(key)) {
      throw new RelayAuthorizationError('untrusted-identity', 'relay identity jwk is invalid')
    }
    const jwk = key as Record<string, unknown>
    assertNoPlaintextRelayFields(jwk, 'relay identity jwk')
    if ('d' in jwk || 'p' in jwk || 'q' in jwk || 'dp' in jwk || 'dq' in jwk || 'qi' in jwk || 'k' in jwk) {
      throw new RelayAuthorizationError('untrusted-identity', 'relay identity jwk must be a public signing key')
    }
    return jwk
  })
  return { keys }
}

/**
 * Verify a compact OIDC JWT against a caller-supplied JWKS.
 * Unknown algorithms, unknown kids, and bad signatures fail closed. The
 * resolver is synchronous; callers load JWKS with `fetchOidcJwks` first.
 */
export function createJwksOidcIdentityProvider(
  config: JwksOidcIdentityProviderConfig,
): RelayIdentityProvider {
  if (typeof config.resolveJwks !== 'function') {
    throw new RelayAuthorizationError('malformed', 'relay identity jwks resolver is required')
  }
  const issuer = requiredIssuerAudience(config.issuer, 'issuer')
  const audience = requiredIssuerAudience(config.audience, 'audience')
  return {
    verify(assertion, now) {
      const jwt = parseCompactJwt(assertion)
      assertNoPlaintextRelayFields(jwt.header, 'relay identity jwt header')
      const alg = jwt.header.alg
      if (typeof alg !== 'string' || !SIGNING_ALGS.has(alg)) {
        throw new RelayAuthorizationError('untrusted-identity', 'relay identity jwt algorithm is not trusted')
      }
      if (jwt.header.typ !== undefined && String(jwt.header.typ).toUpperCase() !== 'JWT') {
        throw new RelayAuthorizationError('untrusted-identity', 'relay identity jwt type is not trusted')
      }
      const kid = jwt.header.kid
      if (typeof kid !== 'string' || kid.length === 0 || /[\0\r\n]/u.test(kid)) {
        throw new RelayAuthorizationError('untrusted-identity', 'relay identity jwt kid is required')
      }
      const jwk = lookupSigningKey(resolveJwks(config.resolveJwks), kid, alg)
      if (!verifyJwtSignature(alg, jwt.signingInput, jwt.signature, importSigningKey(jwk))) {
        throw new RelayAuthorizationError('untrusted-identity', 'relay identity jwt signature is not trusted')
      }
      if (typeof jwt.payload.nbf === 'number' && Number.isFinite(jwt.payload.nbf) && jwt.payload.nbf * 1000 > now) {
        throw new RelayAuthorizationError('expired-token', 'relay identity assertion is not yet valid')
      }
      return parseOidcIdentityAssertion(jwt.payload, { issuer, audience }, now)
    },
  }
}

function requiredIssuerAudience(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.length === 0 || /[\0\r\n]/u.test(value)) {
    throw new RelayAuthorizationError('untrusted-identity', `relay identity ${field} is required`)
  }
  return value
}

function resolveJwks(resolve: () => RelayJsonWebKeySet): RelayJsonWebKeySet {
  let jwks: RelayJsonWebKeySet
  try {
    jwks = resolve()
  } catch {
    throw new RelayAuthorizationError('untrusted-identity', 'relay identity jwks could not be resolved')
  }
  if (jwks === null || typeof jwks !== 'object' || !Array.isArray(jwks.keys)) {
    throw new RelayAuthorizationError('untrusted-identity', 'relay identity jwks is invalid')
  }
  return jwks
}

function lookupSigningKey(
  jwks: RelayJsonWebKeySet,
  kid: string,
  alg: string,
): Record<string, unknown> {
  const matches = jwks.keys.filter(key => (
    key !== null
    && typeof key === 'object'
    && !Array.isArray(key)
    && key.kid === kid
  ))
  const [jwk] = matches
  if (jwk === undefined || matches.length !== 1) {
    throw new RelayAuthorizationError('untrusted-identity', 'relay identity jwks kid is unknown')
  }
  if (jwk.use !== undefined && jwk.use !== 'sig') {
    throw new RelayAuthorizationError('untrusted-identity', 'relay identity jwk use is not trusted')
  }
  if (jwk.alg !== undefined && jwk.alg !== alg) {
    throw new RelayAuthorizationError('untrusted-identity', 'relay identity jwk algorithm is not trusted')
  }
  return jwk
}

function importSigningKey(jwk: Record<string, unknown>): KeyObject {
  if ('d' in jwk || 'p' in jwk || 'q' in jwk || 'dp' in jwk || 'dq' in jwk || 'qi' in jwk || 'k' in jwk) {
    throw new RelayAuthorizationError('untrusted-identity', 'relay identity jwk must be a public signing key')
  }
  try {
    return createPublicKey({ key: jwk, format: 'jwk' })
  } catch {
    throw new RelayAuthorizationError('untrusted-identity', 'relay identity jwk is not a public signing key')
  }
}

function verifyJwtSignature(
  alg: string,
  signingInput: string,
  signature: Buffer,
  key: KeyObject,
): boolean {
  const data = Buffer.from(signingInput, 'utf8')
  try {
    if (alg === 'ES256') {
      return verifySignature('SHA256', data, { key, dsaEncoding: 'ieee-p1363' }, signature)
    }
    return verifySignature('SHA256', data, key, signature)
  } catch {
    return false
  }
}

function parseCompactJwt(value: unknown): {
  readonly header: Record<string, unknown>
  readonly payload: Record<string, unknown>
  readonly signingInput: string
  readonly signature: Buffer
} {
  if (typeof value !== 'string' || value.length === 0 || /[\0\s]/u.test(value)) {
    throw new RelayAuthorizationError('malformed', 'relay identity assertion must be a compact jwt')
  }
  const [headerPart, payloadPart, signaturePart] = value.split('.')
  if (
    headerPart === undefined
    || payloadPart === undefined
    || signaturePart === undefined
    || headerPart.length === 0
    || payloadPart.length === 0
    || signaturePart.length === 0
    || value.split('.').length !== 3
  ) {
    throw new RelayAuthorizationError('malformed', 'relay identity assertion must be a compact jwt')
  }
  return {
    header: decodeJwtJson(headerPart, 'relay identity jwt header'),
    payload: decodeJwtJson(payloadPart, 'relay identity jwt payload'),
    signingInput: `${headerPart}.${payloadPart}`,
    signature: decodeJwtBytes(signaturePart, 'relay identity jwt signature'),
  }
}

function decodeJwtJson(part: string, label: string): Record<string, unknown> {
  let parsed: unknown
  try {
    parsed = JSON.parse(decodeJwtUtf8(part, label))
  } catch {
    throw new RelayAuthorizationError('malformed', `${label} is not json`)
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new RelayAuthorizationError('malformed', `${label} must be an object`)
  }
  return parsed as Record<string, unknown>
}

function decodeJwtUtf8(part: string, label: string): string {
  const bytes = decodeJwtBytes(part, label)
  return bytes.toString('utf8')
}

function decodeJwtBytes(part: string, label: string): Buffer {
  if (!/^[A-Za-z0-9_-]+$/u.test(part)) {
    throw new RelayAuthorizationError('malformed', `${label} is not base64url`)
  }
  const bytes = Buffer.from(part, 'base64url')
  if (bytes.length === 0) {
    throw new RelayAuthorizationError('malformed', `${label} is not base64url`)
  }
  return bytes
}
