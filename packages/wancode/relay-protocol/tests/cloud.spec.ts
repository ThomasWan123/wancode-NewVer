import { afterEach, describe, expect, it } from 'vitest'
import {
  RelayAuthorizationError,
  connectOutboundRelay,
  createMemoryRelayStore,
  createSealedRelayEnvelope,
  createSignedHandshakeEnvelope,
  createStaticOidcIdentityProvider,
  generateDeviceKeyPair,
  openSealedRelayPayload,
} from '../src/index.ts'
import {
  assertRelayCloudBindAddress,
  startRelayCloud,
  type RelayCloud,
} from '../src/cloud.ts'

const NOW = 1_700_000_000_000
const ISSUER = 'https://idp.wancode.example/realms/wancode'
const AUDIENCE = 'wancode-relay'
const ACTOR = { userId: 'user-a', deviceId: 'device-a' }
const DEST = { userId: 'user-a', deviceId: 'desktop-b' }

function expectRelayError(run: () => unknown, code: string): void {
  try {
    run()
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

async function postJson(url: string, body: unknown): Promise<{ status: number, json: Record<string, unknown> }> {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  return { status: response.status, json: await response.json() as Record<string, unknown> }
}

describe('relay cloud bind policy', () => {
  it('accepts loopback and refuses a public bind', () => {
    expect(assertRelayCloudBindAddress('127.0.0.1')).toBe('127.0.0.1')
    expect(assertRelayCloudBindAddress('localhost')).toBe('127.0.0.1')
    expectRelayError(() => assertRelayCloudBindAddress('0.0.0.0'), 'inbound-forbidden')
    expectRelayError(() => assertRelayCloudBindAddress('192.168.1.9'), 'inbound-forbidden')
  })
})

describe('relay cloud control plane', () => {
  const clouds: RelayCloud[] = []

  afterEach(async () => {
    const pending = clouds.splice(0)
    await Promise.all(pending.map(cloud => cloud.close()))
  })

  it('registers a device, mints a token, and dials sealed mail over loopback ws', async () => {
    const sender = generateDeviceKeyPair()
    const recipient = generateDeviceKeyPair()
    const identity = createStaticOidcIdentityProvider({ issuer: ISSUER, audience: AUDIENCE })
    const cloud = await startRelayCloud({
      store: createMemoryRelayStore(),
      identity,
      now: NOW,
    })
    clouds.push(cloud)
    expect(cloud.address).toBe('127.0.0.1')
    expect(cloud.url.startsWith('ws://127.0.0.1:')).toBe(true)

    const health = await fetch(`${cloud.httpUrl}/health`)
    expect(health.status).toBe(200)
    expect(await health.json()).toEqual({ ok: true })

    const registered = await postJson(`${cloud.httpUrl}/v1/devices`, {
      assertion: assertion(),
      deviceId: ACTOR.deviceId,
      publicKey: sender.publicKey,
      encryptionPublicKey: sender.encryptionPublicKey,
    })
    expect(registered.status).toBe(201)
    expect(registered.json).toEqual({
      device: {
        deviceId: ACTOR.deviceId,
        userId: ACTOR.userId,
        publicKey: sender.publicKey,
        encryptionPublicKey: sender.encryptionPublicKey,
      },
    })
    expect(JSON.stringify(registered.json)).not.toContain(sender.privateKey)

    expect((await postJson(`${cloud.httpUrl}/v1/devices`, {
      assertion: assertion(),
      deviceId: DEST.deviceId,
      publicKey: recipient.publicKey,
      encryptionPublicKey: recipient.encryptionPublicKey,
    })).status).toBe(201)

    const minted = await postJson(`${cloud.httpUrl}/v1/tokens`, {
      assertion: assertion(),
      deviceId: ACTOR.deviceId,
    })
    expect(minted.status).toBe(200)
    const accessToken = minted.json.accessToken
    expect(typeof accessToken).toBe('string')
    expect(minted.json.expiresAt).toBe(NOW + 15 * 60 * 1000)

    const connection = await connectOutboundRelay({
      url: cloud.url,
      accessToken: accessToken as string,
      envelope: createSignedHandshakeEnvelope({
        id: 'hs-1',
        sentAt: NOW,
        actor: ACTOR,
        keyPair: sender,
        nonce: 'nonce-1',
        capabilities: ['session.prompt'],
      }),
    })
    const secret = 'never-store-this-prompt-in-the-relay'
    expect(await connection.send({
      envelope: createSealedRelayEnvelope({
        id: 'msg-1',
        sentAt: NOW,
        actor: ACTOR,
        kind: 'prompt',
        sender,
        recipientEncryptionPublicKey: recipient.encryptionPublicKey,
        payload: { kind: 'prompt', sessionId: 'sess-1', text: secret },
      }),
      destinationDeviceId: DEST.deviceId,
    })).toEqual({
      envelopeId: 'msg-1',
      toDeviceId: DEST.deviceId,
      outcome: 'queued',
    })
    expect(JSON.stringify(cloud.mailbox.list(DEST.deviceId))).not.toContain(secret)
    expect(openSealedRelayPayload(cloud.mailbox.list(DEST.deviceId)[0], recipient)).toEqual({
      kind: 'prompt',
      sessionId: 'sess-1',
      text: secret,
    })
    connection.close()
  })

  it('fails closed on plaintext, expired identity, and cross-account tokens', async () => {
    const keys = generateDeviceKeyPair()
    const identity = createStaticOidcIdentityProvider({ issuer: ISSUER, audience: AUDIENCE })
    const cloud = await startRelayCloud({
      store: createMemoryRelayStore(),
      identity,
      now: NOW,
    })
    clouds.push(cloud)

    const plaintext = await postJson(`${cloud.httpUrl}/v1/devices`, {
      assertion: assertion(),
      deviceId: ACTOR.deviceId,
      publicKey: keys.publicKey,
      prompt: 'delete all files',
    })
    expect(plaintext.status).toBe(403)
    expect(plaintext.json).toEqual({
      error: { code: 'plaintext', message: 'relay cloud request must not carry plaintext field prompt' },
    })

    await postJson(`${cloud.httpUrl}/v1/devices`, {
      assertion: assertion(),
      deviceId: ACTOR.deviceId,
      publicKey: keys.publicKey,
    })
    const expired = await postJson(`${cloud.httpUrl}/v1/tokens`, {
      assertion: assertion({ exp: Math.floor(NOW / 1000) }),
      deviceId: ACTOR.deviceId,
    })
    expect(expired.status).toBe(403)
    expect((expired.json.error as { code: string }).code).toBe('expired-token')

    const foreign = await postJson(`${cloud.httpUrl}/v1/tokens`, {
      assertion: assertion({ sub: 'user-b' }),
      deviceId: ACTOR.deviceId,
    })
    expect(foreign.status).toBe(403)
    expect((foreign.json.error as { code: string }).code).toBe('cross-account')
  })
})
