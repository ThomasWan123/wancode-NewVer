import { afterEach, describe, expect, it } from 'vitest'
import {
  RelayAuthorizationError,
  connectOutboundRelay,
  createMemoryRelayStore,
  createSealedRelayEnvelope,
  createSignedHandshakeEnvelope,
  createStaticOidcIdentityProvider,
  createStoredDeviceIdentity,
  issueOutboundRelayToken,
  openSealedRelayPayload,
  registerOutboundRelayDevice,
  revokeOutboundRelayDevice,
} from '../../relay-protocol/src/index.ts'
import { startRelayCloud, type RelayCloud } from '../../relay-protocol/src/cloud.ts'
import { createPwaRelayController } from '../src/index.ts'

const NOW = 1_700_000_000_000
const ISSUER = 'https://idp.wancode.example/realms/wancode'
const AUDIENCE = 'wancode-relay'

function assertion(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    iss: ISSUER,
    aud: AUDIENCE,
    sub: 'user-a',
    exp: Math.floor((NOW + 60_000) / 1000),
    ...overrides,
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
    expect(await controller.sendPresence({
      id: 'msg-presence',
      state: 'online',
    })).toEqual({
      envelopeId: 'msg-presence',
      toDeviceId: desktop.deviceId,
      outcome: 'queued',
    })
    expect(openSealedRelayPayload(cloud.mailbox.list(desktop.deviceId)[1], desktop.keyPair)).toEqual({
      kind: 'presence',
      state: 'online',
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
    expect(controller.sessions()).toEqual([{
      sessionId: 'sess-1',
      status: 'running',
    }])
    controller.close()
    await expectRelayErrorAsync(() => controller.sendFollowUp({
      id: 'msg-closed',
      sessionId: 'sess-1',
      text: 'too late',
    }), 'malformed')
    await expectRelayErrorAsync(() => controller.drain(), 'malformed')
    expect(await controller.listDesktops()).toEqual([{
      deviceId: desktop.deviceId,
      userId: 'user-a',
      publicKey: desktop.keyPair.publicKey,
      encryptionPublicKey: desktop.keyPair.encryptionPublicKey,
    }])
  })

  it('lists same-account desktops, sends approval and cancel, and drains reconnect mail', async () => {
    const pwa = createStoredDeviceIdentity()
    const desktop = createStoredDeviceIdentity()
    const foreign = createStoredDeviceIdentity()
    const cloud = await startRelayCloud({
      store: createMemoryRelayStore(),
      identity: createStaticOidcIdentityProvider({ issuer: ISSUER, audience: AUDIENCE }),
      now: NOW,
    })
    clouds.push(cloud)

    await registerOutboundRelayDevice({
      httpUrl: cloud.httpUrl,
      assertion: assertion(),
      deviceId: desktop.deviceId,
      publicKey: desktop.keyPair.publicKey,
      encryptionPublicKey: desktop.keyPair.encryptionPublicKey,
    })
    await registerOutboundRelayDevice({
      httpUrl: cloud.httpUrl,
      assertion: assertion({ sub: 'user-b' }),
      deviceId: foreign.deviceId,
      publicKey: foreign.keyPair.publicKey,
      encryptionPublicKey: foreign.keyPair.encryptionPublicKey,
    })

    const controller = await createPwaRelayController({
      httpUrl: cloud.httpUrl,
      url: cloud.url,
      assertion: assertion(),
      identity: pwa,
      now: NOW,
    })
    await expectRelayErrorAsync(() => controller.sendFollowUp({
      id: 'msg-0',
      sessionId: 'sess-1',
      text: 'too early',
    }), 'malformed')
    await expectRelayErrorAsync(() => controller.sendApproval({
      id: 'msg-0a',
      sessionId: 'sess-1',
      requestId: 'req-0',
      approved: true,
    }), 'malformed')
    await expectRelayErrorAsync(() => controller.sendCancel({
      id: 'msg-0b',
      sessionId: 'sess-1',
      requestId: 'req-0',
    }), 'malformed')
    await expectRelayErrorAsync(() => controller.sendPresence({
      id: 'msg-0c',
      state: 'online',
    }), 'malformed')

    const desktops = await controller.listDesktops()
    expect(desktops).toEqual([{
      deviceId: desktop.deviceId,
      userId: 'user-a',
      publicKey: desktop.keyPair.publicKey,
      encryptionPublicKey: desktop.keyPair.encryptionPublicKey,
    }])
    expect(JSON.stringify(desktops)).not.toContain(desktop.keyPair.privateKey)
    controller.selectDesktop({
      deviceId: desktop.deviceId,
      encryptionPublicKey: desktop.keyPair.encryptionPublicKey,
    })
    expect(controller.desktopDeviceId).toBe(desktop.deviceId)

    expect(await controller.sendApproval({
      id: 'msg-2',
      sessionId: 'sess-1',
      requestId: 'req-1',
      approved: true,
    })).toEqual({
      envelopeId: 'msg-2',
      toDeviceId: desktop.deviceId,
      outcome: 'queued',
    })
    expect(openSealedRelayPayload(cloud.mailbox.list(desktop.deviceId)[0], desktop.keyPair)).toEqual({
      kind: 'approval',
      sessionId: 'sess-1',
      requestId: 'req-1',
      approved: true,
    })
    expect(await controller.sendCancel({
      id: 'msg-3',
      sessionId: 'sess-1',
      requestId: 'req-1',
    })).toEqual({
      envelopeId: 'msg-3',
      toDeviceId: desktop.deviceId,
      outcome: 'queued',
    })

    controller.close()
    const desktopToken = await issueOutboundRelayToken({
      httpUrl: cloud.httpUrl,
      assertion: assertion(),
      deviceId: desktop.deviceId,
    })
    const desktopConnection = await connectOutboundRelay({
      url: cloud.url,
      accessToken: desktopToken.accessToken,
      envelope: createSignedHandshakeEnvelope({
        id: 'hs-desktop',
        sentAt: NOW,
        actor: { userId: 'user-a', deviceId: desktop.deviceId },
        keyPair: desktop.keyPair,
        nonce: 'desktop-nonce-1',
        capabilities: ['session.observe', 'session.prompt'],
      }),
    })
    const secret = 'never-show-this-prompt-on-the-pwa'
    expect(await desktopConnection.send({
      envelope: createSealedRelayEnvelope({
        id: 'evt-1',
        sentAt: NOW,
        actor: { userId: 'user-a', deviceId: desktop.deviceId },
        kind: 'session-event',
        sender: desktop.keyPair,
        recipientEncryptionPublicKey: pwa.keyPair.encryptionPublicKey,
        payload: {
          kind: 'session-event',
          sessionId: 'sess-1',
          type: 'notify.tool',
          detail: 'Waiting for approval',
        },
      }),
      destinationDeviceId: pwa.deviceId,
    })).toEqual({
      envelopeId: 'evt-1',
      toDeviceId: pwa.deviceId,
      outcome: 'queued',
    })
    expect(JSON.stringify(cloud.mailbox.list(pwa.deviceId))).not.toContain(secret)
    desktopConnection.close()

    await controller.reconnect()
    const drained = await controller.drain()
    expect(drained.views).toEqual([{
      kind: 'progress',
      sessionId: 'sess-1',
      type: 'notify.tool',
      detail: 'Waiting for approval',
    }])
    expect(drained.notifications).toEqual([{
      kind: 'notification',
      sessionId: 'sess-1',
      type: 'notify.tool',
      detail: 'Waiting for approval',
    }])
    expect(drained.sessions).toEqual([{
      sessionId: 'sess-1',
      status: 'awaiting-approval',
      lastType: 'notify.tool',
      lastDetail: 'Waiting for approval',
      pendingRequestId: 'req-1',
      notification: {
        kind: 'notification',
        sessionId: 'sess-1',
        type: 'notify.tool',
        detail: 'Waiting for approval',
      },
    }])
    expect(JSON.stringify(drained)).not.toContain(secret)
    expect(await controller.drain()).toEqual({
      views: [],
      notifications: [],
      sessions: drained.sessions,
    })
    expect(await controller.sendFollowUp({
      id: 'msg-after-reconnect',
      sessionId: 'sess-1',
      text: 'again',
    })).toEqual({
      envelopeId: 'msg-after-reconnect',
      toDeviceId: desktop.deviceId,
      outcome: 'queued',
    })
    controller.close()
  })

  it('omits a revoked desktop and refuses to send follow-ups to it', async () => {
    const pwa = createStoredDeviceIdentity()
    const desktop = createStoredDeviceIdentity()
    const cloud = await startRelayCloud({
      store: createMemoryRelayStore(),
      identity: createStaticOidcIdentityProvider({ issuer: ISSUER, audience: AUDIENCE }),
      now: NOW,
    })
    clouds.push(cloud)
    await registerOutboundRelayDevice({
      httpUrl: cloud.httpUrl,
      assertion: assertion(),
      deviceId: desktop.deviceId,
      publicKey: desktop.keyPair.publicKey,
      encryptionPublicKey: desktop.keyPair.encryptionPublicKey,
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
    expect(await controller.listDesktops()).toHaveLength(1)
    await revokeOutboundRelayDevice({
      httpUrl: cloud.httpUrl,
      assertion: assertion(),
      deviceId: desktop.deviceId,
    })
    expect(await controller.listDesktops()).toEqual([])
    await expectRelayErrorAsync(() => controller.sendFollowUp({
      id: 'msg-revoked',
      sessionId: 'sess-1',
      text: 'too late',
    }), 'revoked-device')
    controller.close()
  })

  it('revokes the PWA device immediately so reconnect fails closed', async () => {
    const pwa = createStoredDeviceIdentity()
    const desktop = createStoredDeviceIdentity()
    const cloud = await startRelayCloud({
      store: createMemoryRelayStore(),
      identity: createStaticOidcIdentityProvider({ issuer: ISSUER, audience: AUDIENCE }),
      now: NOW,
    })
    clouds.push(cloud)
    await registerOutboundRelayDevice({
      httpUrl: cloud.httpUrl,
      assertion: assertion(),
      deviceId: desktop.deviceId,
      publicKey: desktop.keyPair.publicKey,
      encryptionPublicKey: desktop.keyPair.encryptionPublicKey,
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
    await expect(controller.revoke()).resolves.toEqual({
      deviceId: pwa.deviceId,
      revokedAt: NOW,
    })
    expect(await controller.listDesktops()).toEqual([{
      deviceId: desktop.deviceId,
      userId: 'user-a',
      publicKey: desktop.keyPair.publicKey,
      encryptionPublicKey: desktop.keyPair.encryptionPublicKey,
    }])
    await expectRelayErrorAsync(() => controller.reconnect(), 'revoked-device')
  })

  it('refuses empty and oversized follow-up text', async () => {
    const pwa = createStoredDeviceIdentity()
    const desktop = createStoredDeviceIdentity()
    const cloud = await startRelayCloud({
      store: createMemoryRelayStore(),
      identity: createStaticOidcIdentityProvider({ issuer: ISSUER, audience: AUDIENCE }),
      now: NOW,
    })
    clouds.push(cloud)
    await registerOutboundRelayDevice({
      httpUrl: cloud.httpUrl,
      assertion: assertion(),
      deviceId: desktop.deviceId,
      publicKey: desktop.keyPair.publicKey,
      encryptionPublicKey: desktop.keyPair.encryptionPublicKey,
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
    await expectRelayErrorAsync(() => controller.sendFollowUp({
      id: 'msg-empty',
      sessionId: 'sess-1',
      text: '',
    }), 'malformed')
    await expectRelayErrorAsync(() => controller.sendFollowUp({
      id: 'msg-huge',
      sessionId: 'sess-1',
      text: 'x'.repeat(8_193),
    }), 'malformed')
    await expectRelayErrorAsync(() => controller.sendFollowUp({
      id: 'msg-sess',
      sessionId: '',
      text: 'ok',
    }), 'malformed')
    await expectRelayErrorAsync(() => controller.sendApproval({
      id: 'msg-req',
      sessionId: 'sess-1',
      requestId: '',
      approved: true,
    }), 'malformed')
    await expectRelayErrorAsync(() => controller.sendCancel({
      id: 'msg-cancel',
      sessionId: 'sess-1',
      requestId: '',
    }), 'malformed')
    await expectRelayErrorAsync(() => controller.sendFollowUp({
      id: '',
      sessionId: 'sess-1',
      text: 'ok',
    }), 'malformed')
    await expectRelayErrorAsync(() => controller.sendPresence({
      id: '',
      state: 'online',
    }), 'malformed')
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

  it('refuses a desktop object that carries a private key', async () => {
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
        privateKey: desktop.keyPair.privateKey,
      } as never,
    }), 'plaintext')
  })

  it('refuses public cleartext origins before any enroll request is sent', async () => {
    const pwa = createStoredDeviceIdentity()
    const desktop = createStoredDeviceIdentity()
    await expectRelayErrorAsync(() => createPwaRelayController({
      httpUrl: 'http://relay.example.invalid/',
      url: 'ws://relay.example.invalid/v1',
      assertion: assertion(),
      identity: pwa,
      desktop: {
        deviceId: desktop.deviceId,
        encryptionPublicKey: desktop.keyPair.encryptionPublicKey,
      },
    }), 'cleartext-transport')
  })
})
