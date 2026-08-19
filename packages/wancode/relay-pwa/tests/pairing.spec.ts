import { afterEach, describe, expect, it } from 'vitest'
import {
  RelayAuthorizationError,
  createMemoryRelayStore,
  createStaticOidcIdentityProvider,
  createStoredDeviceIdentity,
  openSealedRelayPayload,
} from '../../relay-protocol/src/index.ts'
import { startRelayCloud, type RelayCloud } from '../../relay-protocol/src/cloud.ts'
import { createPwaRelayController } from '../src/index.ts'

const NOW = 1_700_000_000_000
const ISSUER = 'https://idp.wancode.example/realms/wancode'
const AUDIENCE = 'wancode-relay'

function assertion(): Record<string, unknown> {
  return {
    iss: ISSUER,
    aud: AUDIENCE,
    sub: 'user-a',
    exp: Math.floor((NOW + 60_000) / 1000),
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

describe('PWA relay pairing', () => {
  const clouds: RelayCloud[] = []

  afterEach(async () => {
    const pending = clouds.splice(0)
    await Promise.all(pending.map(cloud => cloud.close()))
  })

  it('sends a sealed follow-up to a paired desktop without holding model credentials', async () => {
    const pwa = createStoredDeviceIdentity()
    const desktop = createStoredDeviceIdentity()
    const cloud = await startRelayCloud({
      store: createMemoryRelayStore(),
      identity: createStaticOidcIdentityProvider({ issuer: ISSUER, audience: AUDIENCE }),
      now: NOW,
    })
    clouds.push(cloud)

    await fetch(`${cloud.httpUrl}/v1/devices`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        assertion: assertion(),
        deviceId: desktop.deviceId,
        publicKey: desktop.keyPair.publicKey,
        encryptionPublicKey: desktop.keyPair.encryptionPublicKey,
      }),
    })

    const controller = await createPwaRelayController({
      httpUrl: cloud.httpUrl,
      url: cloud.url,
      assertion: assertion(),
      identity: pwa,
      desktop: {
        deviceId: desktop.deviceId,
        encryptionPublicKey: desktop.keyPair.encryptionPublicKey,
      },
      now: NOW,
    })
    expect(JSON.stringify(controller)).not.toContain(pwa.keyPair.privateKey)
    expect(controller.deviceId).toBe(pwa.deviceId)
    expect(controller.desktopDeviceId).toBe(desktop.deviceId)

    const secret = 'review the login form'
    expect(await controller.sendFollowUp({
      id: 'msg-1',
      sessionId: 'sess-1',
      text: secret,
    })).toEqual({
      envelopeId: 'msg-1',
      toDeviceId: desktop.deviceId,
      outcome: 'queued',
    })
    const queued = cloud.mailbox.list(desktop.deviceId)
    expect(JSON.stringify(queued)).not.toContain(secret)
    expect(openSealedRelayPayload(queued[0], desktop.keyPair)).toEqual({
      kind: 'prompt',
      sessionId: 'sess-1',
      text: secret,
    })
    expect(controller.project({
      kind: 'session-event',
      sessionId: 'sess-1',
      type: 'assistant.delta',
      detail: 'Looking at the form',
    })).toEqual({
      kind: 'progress',
      sessionId: 'sess-1',
      type: 'assistant.delta',
      detail: 'Looking at the form',
    })
    controller.close()
  })

  it('refuses to pair when a model credential is supplied', async () => {
    const pwa = createStoredDeviceIdentity()
    const desktop = createStoredDeviceIdentity()
    await expectRelayErrorAsync(() => createPwaRelayController({
      httpUrl: 'http://127.0.0.1:9',
      url: 'ws://127.0.0.1:9',
      assertion: assertion(),
      identity: pwa,
      desktop: {
        deviceId: desktop.deviceId,
        encryptionPublicKey: desktop.keyPair.encryptionPublicKey,
      },
      DEEPSEEK_API_KEY: 'sk-secret',
    } as never), 'plaintext')
  })
})
