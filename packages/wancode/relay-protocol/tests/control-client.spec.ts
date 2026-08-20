import { afterEach, describe, expect, it } from 'vitest'
import {
  RelayAuthorizationError,
  assertOutboundRelayHttpUrl,
  createMemoryRelayStore,
  createStaticOidcIdentityProvider,
  generateDeviceKeyPair,
  httpUrlFromOutboundRelayUrl,
  issueOutboundRelayToken,
  listOutboundRelayDevices,
  registerOutboundRelayDevice,
  revokeOutboundRelayDevice,
} from '../src/index.ts'
import {
  startRelayCloud,
  type RelayCloud,
} from '../src/cloud.ts'

const NOW = 1_700_000_000_000
const ISSUER = 'https://idp.wancode.example/realms/wancode'
const AUDIENCE = 'wancode-relay'
const DEVICE_ID = 'device-a'

function expectRelayError(run: () => unknown, code: string): void {
  try {
    run()
    expect.unreachable('expected a relay authorization error')
  } catch (cause) {
    expect(cause).toBeInstanceOf(RelayAuthorizationError)
    expect((cause as RelayAuthorizationError).code).toBe(code)
  }
}

async function expectRelayErrorAsync(run: () => Promise<unknown>, code: string): Promise<void> {
  try {
    await run()
    expect.unreachable('expected a relay authorization error')
  } catch (cause) {
    expect(cause).toBeInstanceOf(RelayAuthorizationError)
    expect((cause as RelayAuthorizationError).code).toBe(code)
  }
}

function assertion(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    iss: ISSUER,
    aud: AUDIENCE,
    sub: 'user-a',
    exp: Math.floor((NOW + 60_000) / 1000),
    ...overrides,
  }
}

describe('outbound relay HTTP url policy', () => {
  it('accepts https and loopback http, and refuses credentials or public cleartext', () => {
    expect(assertOutboundRelayHttpUrl('https://relay.wancode.example').href)
      .toBe('https://relay.wancode.example/')
    expect(assertOutboundRelayHttpUrl('http://127.0.0.1:4173/v1').href)
      .toBe('http://127.0.0.1:4173/v1')
    expect(httpUrlFromOutboundRelayUrl('wss://relay.wancode.example/v1').href)
      .toBe('https://relay.wancode.example/')
    expect(httpUrlFromOutboundRelayUrl('ws://127.0.0.1:4173/v1').href)
      .toBe('http://127.0.0.1:4173/')
    expectRelayError(() => assertOutboundRelayHttpUrl('http://relay.example.invalid/v1'), 'cleartext-transport')
    expectRelayError(() => assertOutboundRelayHttpUrl('https://user:secret@relay.example.invalid'), 'plaintext')
    expectRelayError(() => assertOutboundRelayHttpUrl('https://relay.example.invalid/?access_token=tok'), 'plaintext')
  })
})

describe('outbound relay control client', () => {
  const clouds: RelayCloud[] = []

  afterEach(async () => {
    const pending = clouds.splice(0)
    await Promise.all(pending.map(cloud => cloud.close()))
  })

  it('registers a device, mints a token, and revokes without listening', async () => {
    const keys = generateDeviceKeyPair()
    const cloud = await startRelayCloud({
      store: createMemoryRelayStore(),
      identity: createStaticOidcIdentityProvider({ issuer: ISSUER, audience: AUDIENCE }),
      now: NOW,
    })
    clouds.push(cloud)

    const device = await registerOutboundRelayDevice({
      httpUrl: cloud.httpUrl,
      assertion: assertion(),
      deviceId: DEVICE_ID,
      publicKey: keys.publicKey,
      encryptionPublicKey: keys.encryptionPublicKey,
    })
    expect(device).toEqual({
      deviceId: DEVICE_ID,
      userId: 'user-a',
      publicKey: keys.publicKey,
      encryptionPublicKey: keys.encryptionPublicKey,
    })
    expect(JSON.stringify(device)).not.toContain(keys.privateKey)
    expect(JSON.stringify(device)).not.toContain(keys.encryptionPrivateKey)

    const minted = await issueOutboundRelayToken({
      httpUrl: cloud.httpUrl,
      assertion: assertion(),
      deviceId: DEVICE_ID,
    })
    expect(typeof minted.accessToken).toBe('string')
    expect(minted.expiresAt).toBe(NOW + 15 * 60 * 1000)

    const revoked = await revokeOutboundRelayDevice({
      httpUrl: cloud.httpUrl,
      assertion: assertion(),
      deviceId: DEVICE_ID,
    })
    expect(revoked).toEqual({ deviceId: DEVICE_ID, revokedAt: NOW })

    await expectRelayErrorAsync(() => issueOutboundRelayToken({
      httpUrl: cloud.httpUrl,
      assertion: assertion(),
      deviceId: DEVICE_ID,
    }), 'revoked-device')
  })

  it('lists live same-account devices and omits revoked or foreign rows', async () => {
    const own = generateDeviceKeyPair()
    const peer = generateDeviceKeyPair()
    const foreign = generateDeviceKeyPair()
    const cloud = await startRelayCloud({
      store: createMemoryRelayStore(),
      identity: createStaticOidcIdentityProvider({ issuer: ISSUER, audience: AUDIENCE }),
      now: NOW,
    })
    clouds.push(cloud)

    await registerOutboundRelayDevice({
      httpUrl: cloud.httpUrl,
      assertion: assertion(),
      deviceId: 'device-a',
      publicKey: own.publicKey,
      encryptionPublicKey: own.encryptionPublicKey,
    })
    await registerOutboundRelayDevice({
      httpUrl: cloud.httpUrl,
      assertion: assertion(),
      deviceId: 'desktop-b',
      publicKey: peer.publicKey,
      encryptionPublicKey: peer.encryptionPublicKey,
    })
    await registerOutboundRelayDevice({
      httpUrl: cloud.httpUrl,
      assertion: assertion({ sub: 'user-b' }),
      deviceId: 'device-b',
      publicKey: foreign.publicKey,
      encryptionPublicKey: foreign.encryptionPublicKey,
    })
    await revokeOutboundRelayDevice({
      httpUrl: cloud.httpUrl,
      assertion: assertion(),
      deviceId: 'device-a',
    })

    const listed = await listOutboundRelayDevices({
      httpUrl: cloud.httpUrl,
      assertion: assertion(),
    })
    expect(listed).toEqual([{
      deviceId: 'desktop-b',
      userId: 'user-a',
      publicKey: peer.publicKey,
      encryptionPublicKey: peer.encryptionPublicKey,
    }])
    expect(JSON.stringify(listed)).not.toContain(peer.privateKey)
    expect(listed.map(device => device.deviceId)).not.toContain('device-a')
    expect(listed.map(device => device.deviceId)).not.toContain('device-b')
  })

  it('refuses listed devices whose keys are not Ed25519 or X25519', async () => {
    await expectRelayErrorAsync(() => listOutboundRelayDevices({
      httpUrl: 'https://relay.wancode.example',
      assertion: assertion(),
      fetchImpl: async () => ({
        ok: true,
        status: 200,
        headers: { get: () => 'application/json' },
        arrayBuffer: async () => new TextEncoder().encode(JSON.stringify({
          devices: [{
            deviceId: 'desktop-bad',
            userId: 'user-a',
            publicKey: 'not-ed25519',
            encryptionPublicKey: 'not-x25519',
          }],
        })).buffer,
      }),
    }), 'untrusted-key')
  })

  it('refuses to send private key material and public cleartext control URLs', async () => {
    const keys = generateDeviceKeyPair()
    await expectRelayErrorAsync(() => registerOutboundRelayDevice({
      httpUrl: 'http://relay.example.invalid',
      assertion: assertion(),
      deviceId: DEVICE_ID,
      publicKey: keys.publicKey,
    }), 'cleartext-transport')
    await expectRelayErrorAsync(() => registerOutboundRelayDevice({
      httpUrl: 'https://relay.wancode.example',
      assertion: assertion(),
      deviceId: DEVICE_ID,
      publicKey: keys.publicKey,
      privateKey: keys.privateKey,
    } as never), 'plaintext')
  })

  it('re-checks redirects and never sends credentials', async () => {
    const keys = generateDeviceKeyPair()
    const seen: Array<{ url: string, headers: Record<string, string> }> = []
    await expectRelayErrorAsync(() => registerOutboundRelayDevice({
      httpUrl: 'https://relay.wancode.example',
      assertion: assertion(),
      deviceId: DEVICE_ID,
      publicKey: keys.publicKey,
      fetchImpl: async (url, init) => {
        seen.push({ url, headers: init.headers })
        expect(init.method).toBe('POST')
        expect(init.redirect).toBe('manual')
        expect('authorization' in init.headers).toBe(false)
        expect('cookie' in init.headers).toBe(false)
        return {
          ok: false,
          status: 302,
          headers: {
            get(name: string) {
              return name.toLowerCase() === 'location' ? 'http://relay.example.invalid/v1/devices' : null
            },
          },
          async arrayBuffer() {
            return new ArrayBuffer(0)
          },
        }
      },
    }), 'cleartext-transport')
    expect(seen).toHaveLength(1)
    expect(seen[0]?.url).toBe('https://relay.wancode.example/v1/devices')
  })
})
