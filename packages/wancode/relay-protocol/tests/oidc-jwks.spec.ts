import { generateKeyPairSync, sign, type KeyObject } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import {
  RelayAuthorizationError,
  assertOidcJwksUrl,
  createJwksOidcIdentityProvider,
  createMemoryRelayStore,
  fetchOidcJwks,
  generateDeviceKeyPair,
  parseRelayJsonWebKeySet,
  registerRelayDevice,
} from '../src/index.ts'

const NOW = 1_700_000_000_000
const ISSUER = 'https://idp.wancode.example/realms/wancode'
const AUDIENCE = 'wancode-relay'

async function expectRelayErrorAsync(run: () => Promise<unknown>, code: string): Promise<void> {
  try {
    await run()
    expect.unreachable('expected a relay authorization error')
  } catch (cause) {
    expect(cause).toBeInstanceOf(RelayAuthorizationError)
    expect((cause as RelayAuthorizationError).code).toBe(code)
  }
}

function jsonResponse(
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
) {
  const bytes = Buffer.from(typeof body === 'string' ? body : JSON.stringify(body))
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: {
      get(name: string) {
        return headers[name.toLowerCase()] ?? null
      },
    },
    async arrayBuffer() {
      return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)
    },
  }
}

function expectRelayError(run: () => unknown, code: string): void {
  try {
    run()
    expect.unreachable('expected a relay authorization error')
  } catch (cause) {
    expect(cause).toBeInstanceOf(RelayAuthorizationError)
    expect((cause as RelayAuthorizationError).code).toBe(code)
  }
}

function claims(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    iss: ISSUER,
    aud: AUDIENCE,
    sub: 'user-a',
    exp: Math.floor((NOW + 60_000) / 1000),
    ...overrides,
  }
}

function publicJwk(key: KeyObject, kid: string, alg: string): Record<string, unknown> {
  return {
    ...key.export({ format: 'jwk' }) as Record<string, unknown>,
    kid,
    alg,
    use: 'sig',
  }
}

function es256Pair(kid = 'ec-1') {
  const pair = generateKeyPairSync('ec', { namedCurve: 'P-256' })
  return {
    privateKey: pair.privateKey,
    jwk: publicJwk(pair.publicKey, kid, 'ES256'),
  }
}

function rs256Pair(kid = 'rsa-1') {
  const pair = generateKeyPairSync('rsa', { modulusLength: 2048 })
  return {
    privateKey: pair.privateKey,
    jwk: publicJwk(pair.publicKey, kid, 'RS256'),
  }
}

function compactJwt(
  privateKey: KeyObject,
  header: Record<string, unknown>,
  payload: Record<string, unknown>,
  encoding?: 'ieee-p1363',
): string {
  const encodedHeader = Buffer.from(JSON.stringify(header), 'utf8').toString('base64url')
  const encodedPayload = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url')
  const signingInput = `${encodedHeader}.${encodedPayload}`
  const signature = encoding === 'ieee-p1363'
    ? sign('SHA256', Buffer.from(signingInput), { key: privateKey, dsaEncoding: 'ieee-p1363' })
    : sign('SHA256', Buffer.from(signingInput), privateKey)
  return `${signingInput}.${signature.toString('base64url')}`
}

describe('oidc jwks url policy', () => {
  it('allows production https and loopback http', () => {
    expect(assertOidcJwksUrl('https://idp.wancode.example/realms/wancode/protocol/openid-connect/certs').protocol).toBe('https:')
    expect(assertOidcJwksUrl('http://127.0.0.1:9/jwks').hostname).toBe('127.0.0.1')
  })

  it('rejects cleartext jwks to a non-loopback host', () => {
    expectRelayError(() => assertOidcJwksUrl('http://idp.example.invalid/jwks'), 'cleartext-transport')
  })

  it('rejects credentials placed on the jwks url', () => {
    expectRelayError(() => assertOidcJwksUrl('https://user:tok@idp.example.invalid/jwks'), 'plaintext')
    expectRelayError(() => assertOidcJwksUrl('https://idp.example.invalid/jwks?accessToken=tok'), 'plaintext')
  })
})

describe('jwks-backed oidc identity', () => {
  it('verifies an ES256 jwt and registers the account device', () => {
    const keys = es256Pair()
    const identity = createJwksOidcIdentityProvider({
      issuer: ISSUER,
      audience: AUDIENCE,
      resolveJwks: () => ({ keys: [keys.jwk] }),
    })
    const verified = identity.verify(compactJwt(keys.privateKey, {
      alg: 'ES256',
      typ: 'JWT',
      kid: 'ec-1',
    }, claims(), 'ieee-p1363'), NOW)
    expect(verified).toEqual({
      issuer: ISSUER,
      audience: AUDIENCE,
      userId: 'user-a',
      expiresAt: NOW + 60_000,
    })
    const deviceKeys = generateDeviceKeyPair()
    expect(registerRelayDevice({
      identity: verified,
      deviceId: 'device-a',
      publicKey: deviceKeys.publicKey,
      encryptionPublicKey: deviceKeys.encryptionPublicKey,
      now: NOW,
      store: createMemoryRelayStore(),
    }).userId).toBe('user-a')
  })

  it('verifies an RS256 jwt from the matching kid', () => {
    const keys = rs256Pair()
    const identity = createJwksOidcIdentityProvider({
      issuer: ISSUER,
      audience: AUDIENCE,
      resolveJwks: () => ({ keys: [keys.jwk] }),
    })
    expect(identity.verify(compactJwt(keys.privateKey, {
      alg: 'RS256',
      kid: 'rsa-1',
    }, claims()), NOW).userId).toBe('user-a')
  })

  it('fails closed on a foreign key, unknown kid, or private jwk', () => {
    const trusted = es256Pair()
    const attacker = es256Pair('ec-2')
    const identity = createJwksOidcIdentityProvider({
      issuer: ISSUER,
      audience: AUDIENCE,
      resolveJwks: () => ({ keys: [trusted.jwk] }),
    })
    expectRelayError(() => identity.verify(compactJwt(attacker.privateKey, {
      alg: 'ES256',
      kid: 'ec-1',
    }, claims(), 'ieee-p1363'), NOW), 'untrusted-identity')
    expectRelayError(() => identity.verify(compactJwt(trusted.privateKey, {
      alg: 'ES256',
      kid: 'missing',
    }, claims(), 'ieee-p1363'), NOW), 'untrusted-identity')
    expectRelayError(() => createJwksOidcIdentityProvider({
      issuer: ISSUER,
      audience: AUDIENCE,
      resolveJwks: () => ({
        keys: [{
          ...trusted.jwk,
          ...trusted.privateKey.export({ format: 'jwk' }) as Record<string, unknown>,
        }],
      }),
    }).verify(compactJwt(trusted.privateKey, {
      alg: 'ES256',
      kid: 'ec-1',
    }, claims(), 'ieee-p1363'), NOW), 'untrusted-identity')
  })

  it('rejects none, hmac, expired, future nbf, and plaintext claims', () => {
    const keys = es256Pair()
    const identity = createJwksOidcIdentityProvider({
      issuer: ISSUER,
      audience: AUDIENCE,
      resolveJwks: () => ({ keys: [keys.jwk] }),
    })
    const unsigned = compactJwt(keys.privateKey, {
      alg: 'ES256',
      kid: 'ec-1',
    }, claims(), 'ieee-p1363').split('.')
    expectRelayError(() => identity.verify(`${unsigned[0]}.${unsigned[1]}.`, NOW), 'malformed')
    expectRelayError(() => identity.verify(compactJwt(keys.privateKey, {
      alg: 'none',
      kid: 'ec-1',
    }, claims(), 'ieee-p1363'), NOW), 'untrusted-identity')
    expectRelayError(() => identity.verify(compactJwt(keys.privateKey, {
      alg: 'HS256',
      kid: 'ec-1',
    }, claims(), 'ieee-p1363'), NOW), 'untrusted-identity')
    expectRelayError(() => identity.verify(compactJwt(keys.privateKey, {
      alg: 'ES256',
      kid: 'ec-1',
    }, claims({ exp: Math.floor(NOW / 1000) }), 'ieee-p1363'), NOW), 'expired-token')
    expectRelayError(() => identity.verify(compactJwt(keys.privateKey, {
      alg: 'ES256',
      kid: 'ec-1',
    }, claims({ nbf: Math.floor((NOW + 60_000) / 1000) }), 'ieee-p1363'), NOW), 'expired-token')
    expectRelayError(() => identity.verify(compactJwt(keys.privateKey, {
      alg: 'ES256',
      kid: 'ec-1',
    }, claims({ prompt: 'delete all files' }), 'ieee-p1363'), NOW), 'plaintext')
    expectRelayError(() => identity.verify(claims(), NOW), 'malformed')
  })

  it('fails closed when the jwks resolver throws or returns no keys', () => {
    expectRelayError(() => createJwksOidcIdentityProvider({
      issuer: ISSUER,
      audience: AUDIENCE,
      resolveJwks: () => {
        throw new Error('offline')
      },
    }).verify(compactJwt(es256Pair().privateKey, {
      alg: 'ES256',
      kid: 'ec-1',
    }, claims(), 'ieee-p1363'), NOW), 'untrusted-identity')
    expectRelayError(() => createJwksOidcIdentityProvider({
      issuer: ISSUER,
      audience: AUDIENCE,
      resolveJwks: () => ({ keys: [] }),
    }).verify(compactJwt(es256Pair().privateKey, {
      alg: 'ES256',
      kid: 'ec-1',
    }, claims(), 'ieee-p1363'), NOW), 'untrusted-identity')
  })
})

describe('oidc jwks fetch', () => {
  it('loads a public jwks over https without following an untrusted redirect', async () => {
    const keys = es256Pair()
    const jwks = { keys: [keys.jwk] }
    expect(parseRelayJsonWebKeySet(JSON.stringify(jwks))).toEqual(jwks)
    expect(await fetchOidcJwks('https://idp.wancode.example/jwks', async () => jsonResponse(200, jwks))).toEqual(jwks)
    await expectRelayErrorAsync(() => fetchOidcJwks('https://user:tok@idp.example.invalid/jwks', async () => {
      throw new Error('fetch must not run')
    }), 'plaintext')
    await expectRelayErrorAsync(() => fetchOidcJwks('https://idp.wancode.example/jwks', async () => jsonResponse(302, '', {
      location: 'http://evil.example.invalid/jwks',
    })), 'cleartext-transport')
  })

  it('follows an https redirect and refuses private key material', async () => {
    const keys = es256Pair()
    const jwks = { keys: [keys.jwk] }
    const fetched = await fetchOidcJwks('https://idp.wancode.example/start', async (url) => {
      if (url === 'https://idp.wancode.example/start') {
        return jsonResponse(302, '', { location: 'https://idp.wancode.example/jwks' })
      }
      return jsonResponse(200, jwks)
    })
    expect(fetched).toEqual(jwks)
    await expectRelayErrorAsync(() => fetchOidcJwks('https://idp.wancode.example/jwks', async () => jsonResponse(200, {
      keys: [{ ...keys.jwk, d: 'private' }],
    })), 'untrusted-identity')
  })
})
