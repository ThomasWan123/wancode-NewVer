/** Loopback-only cloud control plane. Never bind a public interface. */

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import {
  createMemoryRelayMailbox,
  createMemoryRelayPresence,
  type RelayMailbox,
  type RelayPresence,
} from './delivery.ts'
import { registerRelayDevice, revokeRelayDevice, listRelayAccountDevices, type RelayDeviceStore } from './devices.ts'
import { assertNoPlaintextRelayFields, type RelayAccessToken, type RelayDevice } from './envelope.ts'
import { RelayAuthorizationError } from './errors.ts'
import type { RelayIdentityProvider } from './identity.ts'
import {
  createMemoryRelayPairingGrantStore,
  mintRelayPairingGrant,
  redeemRelayPairingGrant,
  type RelayPairingGrantStore,
} from './pairing-grant.ts'
import type { RelayRouteStore } from './route.ts'
import { createMemoryRelayTokenIssuer, type RelayTokenIssuer } from './tokens.ts'
import { attachRelaySocket, createRelayLiveSink } from './acceptor.ts'
import { NodeWebSocketServer, type RelayWebSocket } from './ws-runtime.ts'

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1', '[::1]'])
const MAX_BODY_BYTES = 65_536

/** Store that can register devices, mint tokens, and route sealed mail. */
export type RelayCloudStore = RelayDeviceStore & RelayRouteStore & {
  putAccessToken(token: RelayAccessToken): void
}

/** Inputs for a 127.0.0.1 HTTP + WebSocket control plane. */
export interface StartRelayCloudInput {
  readonly store: RelayCloudStore
  readonly identity: RelayIdentityProvider
  readonly tokens?: RelayTokenIssuer
  readonly mailbox?: RelayMailbox
  readonly presence?: RelayPresence
  readonly pairingGrants?: RelayPairingGrantStore
  readonly now?: number
  readonly bindAddress?: string
  readonly port?: number
}

/** Listening loopback cloud. `url` is always `ws://127.0.0.1:<port>`. */
export interface RelayCloud {
  readonly url: string
  readonly httpUrl: string
  readonly address: string
  readonly port: number
  readonly mailbox: RelayMailbox
  readonly presence: RelayPresence
  close(): Promise<void>
}

/**
 * Accept only loopback bind addresses. Public interfaces fail closed here;
 * a later dedicated cloud process owns non-loopback listeners.
 */
export function assertRelayCloudBindAddress(address: string): string {
  if (typeof address !== 'string' || address.length === 0 || /[\0\r\n]/u.test(address)) {
    throw new RelayAuthorizationError('malformed', 'relay cloud bind address is required')
  }
  if (!LOOPBACK_HOSTS.has(address)) {
    throw new RelayAuthorizationError('inbound-forbidden', 'relay cloud must bind loopback')
  }
  return address === 'localhost' || address === '::1' || address === '[::1]' ? '127.0.0.1' : address
}

/**
 * Bind HTTP device/token routes and the outbound WebSocket acceptor on
 * 127.0.0.1. This is not a public production listener and is not a DSH plugin.
 */
export async function startRelayCloud(input: StartRelayCloudInput): Promise<RelayCloud> {
  const bindAddress = assertRelayCloudBindAddress(input.bindAddress ?? '127.0.0.1')
  const now = input.now ?? Date.now()
  const mailbox = input.mailbox ?? createMemoryRelayMailbox()
  const presence = input.presence ?? createMemoryRelayPresence()
  const tokens = input.tokens ?? createMemoryRelayTokenIssuer(input.store)
  const pairingGrants = input.pairingGrants ?? createMemoryRelayPairingGrantStore()
  const httpServer = createServer((request, response) => {
    void handleCloudHttp(request, response, {
      identity: input.identity,
      store: input.store,
      tokens,
      pairingGrants,
      now,
    })
  })
  const sockets = new Set<RelayWebSocket>()
  const liveSockets = new Map<string, RelayWebSocket>()
  const live = createRelayLiveSink(liveSockets)
  const wss = new NodeWebSocketServer({ server: httpServer })
  wss.on('connection', socket => {
    attachRelaySocket(socket, { store: input.store, mailbox, presence, now }, sockets, liveSockets, live)
  })

  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error) => reject(error)
    httpServer.once('error', onError)
    httpServer.listen(input.port ?? 0, bindAddress, () => {
      httpServer.off('error', onError)
      resolve()
    })
  })

  const address = httpServer.address()
  if (address === null || typeof address === 'string' || address.address !== '127.0.0.1') {
    httpServer.close()
    throw new Error('relay cloud must bind 127.0.0.1')
  }

  return {
    url: `ws://127.0.0.1:${address.port}`,
    httpUrl: `http://127.0.0.1:${address.port}`,
    address: address.address,
    port: address.port,
    mailbox,
    presence,
    async close() {
      for (const socket of sockets) socket.terminate()
      await new Promise<void>((resolve, reject) => {
        wss.close(error => {
          if (error) reject(error)
          else httpServer.close(closeError => closeError ? reject(closeError) : resolve())
        })
      })
    },
  }
}

interface CloudHttpContext {
  readonly identity: RelayIdentityProvider
  readonly store: RelayCloudStore
  readonly tokens: RelayTokenIssuer
  readonly pairingGrants: RelayPairingGrantStore
  readonly now: number
}

async function handleCloudHttp(
  request: IncomingMessage,
  response: ServerResponse,
  context: CloudHttpContext,
): Promise<void> {
  try {
    const [path = '/'] = (request.url ?? '/').split('?')
    if (request.method === 'GET' && path === '/health') {
      writeJson(response, 200, { ok: true })
      return
    }
    if (request.method !== 'POST') {
      throw new RelayAuthorizationError('malformed', 'relay cloud method is not supported')
    }
    const body = await readJsonBody(request)
    if (path === '/v1/devices/list') {
      const identity = context.identity.verify(body.assertion, context.now)
      writeJson(response, 200, {
        devices: listRelayAccountDevices({
          userId: identity.userId,
          now: context.now,
          store: context.store,
        }).map(publicDevice),
      })
      return
    }
    if (path === '/v1/devices') {
      writeJson(response, 201, { device: publicDevice(registerCloudDevice(body, context)) })
      return
    }
    if (path === '/v1/tokens') {
      writeJson(response, 200, issueCloudToken(body, context))
      return
    }
    if (path === '/v1/devices/revoke') {
      const device = revokeCloudDevice(body, context)
      writeJson(response, 200, { deviceId: device.deviceId, revokedAt: device.revokedAt })
      return
    }
    if (path === '/v1/pairing/grants') {
      const minted = mintRelayPairingGrant({
        identity: context.identity.verify(body.assertion, context.now),
        desktopDeviceId: requiredText(body.deviceId, 'deviceId'),
        now: context.now,
        devices: context.store,
        grants: context.pairingGrants,
      })
      writeJson(response, 201, {
        pairingCode: minted.pairingCode,
        expiresAt: minted.expiresAt,
        desktopDeviceId: minted.desktopDeviceId,
      })
      return
    }
    if (path === '/v1/pairing/redeem') {
      const redeemed = redeemRelayPairingGrant({
        pairingCode: body.pairingCode,
        deviceId: requiredText(body.deviceId, 'deviceId'),
        publicKey: requiredText(body.publicKey, 'publicKey'),
        encryptionPublicKey: requiredText(body.encryptionPublicKey, 'encryptionPublicKey'),
        now: context.now,
        devices: context.store,
        grants: context.pairingGrants,
        tokens: context.tokens,
      })
      writeJson(response, 201, {
        device: publicDevice(redeemed.device),
        desktop: publicDevice(redeemed.desktop),
        accessToken: redeemed.accessToken,
        expiresAt: redeemed.expiresAt,
      })
      return
    }
    throw new RelayAuthorizationError('malformed', 'relay cloud path is not supported')
  } catch (cause) {
    const code = cause instanceof RelayAuthorizationError ? cause.code : 'malformed'
    const message = cause instanceof Error ? cause.message : 'relay cloud request failed'
    const status = cause instanceof RelayAuthorizationError && cause.code === 'malformed' ? 400 : 403
    writeJson(response, status, { error: { code, message } })
  }
}

function registerCloudDevice(body: Record<string, unknown>, context: CloudHttpContext): RelayDevice {
  const deviceId = requiredText(body.deviceId, 'deviceId')
  const publicKey = requiredText(body.publicKey, 'publicKey')
  const encryptionPublicKey = requiredText(body.encryptionPublicKey, 'encryptionPublicKey')
  const identity = context.identity.verify(body.assertion, context.now)
  return registerRelayDevice({
    identity,
    deviceId,
    publicKey,
    encryptionPublicKey,
    now: context.now,
    store: context.store,
  })
}

function issueCloudToken(
  body: Record<string, unknown>,
  context: CloudHttpContext,
): { readonly accessToken: string, readonly expiresAt: number } {
  const deviceId = requiredText(body.deviceId, 'deviceId')
  const identity = context.identity.verify(body.assertion, context.now)
  const device = context.store.getDevice(deviceId)
  if (device === undefined || (device.revokedAt !== undefined && device.revokedAt <= context.now)) {
    throw new RelayAuthorizationError('revoked-device', 'relay device is unknown or revoked')
  }
  if (device.userId !== identity.userId) {
    throw new RelayAuthorizationError('cross-account', 'relay token does not belong to the presented account')
  }
  const issued = context.tokens.issue({
    userId: identity.userId,
    deviceId,
    now: context.now,
  })
  return { accessToken: issued.accessToken, expiresAt: issued.record.expiresAt }
}

function revokeCloudDevice(body: Record<string, unknown>, context: CloudHttpContext): RelayDevice {
  const identity = context.identity.verify(body.assertion, context.now)
  return revokeRelayDevice({
    userId: identity.userId,
    deviceId: requiredText(body.deviceId, 'deviceId'),
    now: context.now,
    store: context.store,
  })
}

function publicDevice(device: RelayDevice): {
  readonly deviceId: string
  readonly userId: string
  readonly publicKey: string
  readonly encryptionPublicKey?: string
} {
  return device.encryptionPublicKey === undefined
    ? { deviceId: device.deviceId, userId: device.userId, publicKey: device.publicKey }
    : {
      deviceId: device.deviceId,
      userId: device.userId,
      publicKey: device.publicKey,
      encryptionPublicKey: device.encryptionPublicKey,
    }
}

function requiredText(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.length === 0 || /[\0\r\n]/u.test(value)) {
    throw new RelayAuthorizationError('malformed', `relay cloud ${field} is required`)
  }
  return value
}

async function readJsonBody(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    size += buffer.byteLength
    if (size > MAX_BODY_BYTES) {
      throw new RelayAuthorizationError('malformed', 'relay cloud request body is too large')
    }
    chunks.push(buffer)
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch {
    throw new RelayAuthorizationError('malformed', 'relay cloud request is not json')
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new RelayAuthorizationError('malformed', 'relay cloud request must be an object')
  }
  const record = parsed as Record<string, unknown>
  assertNoPlaintextRelayFields(record, 'relay cloud request')
  return record
}

function writeJson(response: ServerResponse, status: number, body: Record<string, unknown>): void {
  assertNoPlaintextRelayFields(body, 'relay cloud response')
  const payload = JSON.stringify(body)
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
  })
  response.end(payload)
}
