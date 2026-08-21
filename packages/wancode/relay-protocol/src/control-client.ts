/** Outbound HTTP client for device registration, tokens, and revocation. Never listens. */

import { assertNoPlaintextRelayFields } from './envelope.ts'
import { RelayAuthorizationError, isRelayErrorCode } from './errors.ts'
import { assertDeviceEncryptionPublicKey, assertDevicePublicKey } from './device-keys.ts'
import { assertOutboundRelayUrl } from './url.ts'

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1', '[::1]'])
const MAX_BODY_BYTES = 65_536
const MAX_REDIRECTS = 3
const PRIVATE_KEY_FIELDS = ['privateKey', 'encryptionPrivateKey'] as const

/**
 * Accept a desktop-dialed relay control-plane URL.
 * `https:` is allowed for any host. `http:` is allowed only to loopback.
 * Credentials must not appear in the URL.
 */
export function assertOutboundRelayHttpUrl(url: string): URL {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    throw new RelayAuthorizationError('malformed', 'relay control url is not a valid http url')
  }
  if (parsed.username !== '' || parsed.password !== '') {
    throw new RelayAuthorizationError('plaintext', 'relay control url must not embed credentials')
  }
  for (const key of parsed.searchParams.keys()) {
    if (/token|secret|credential|password|authorization/iu.test(key)) {
      throw new RelayAuthorizationError('plaintext', 'relay control url must not carry credentials')
    }
  }
  if (parsed.protocol === 'https:') return parsed
  if (parsed.protocol === 'http:' && LOOPBACK_HOSTS.has(parsed.hostname)) return parsed
  if (parsed.protocol === 'http:') {
    throw new RelayAuthorizationError(
      'cleartext-transport',
      'cleartext relay control is only allowed to loopback',
    )
  }
  throw new RelayAuthorizationError('malformed', 'relay control url must use https or loopback http')
}

/**
 * Derive the outbound HTTP origin from a fail-closed WebSocket relay URL.
 * `wss:` maps to `https:`. Loopback `ws:` maps to `http:`.
 */
export function httpUrlFromOutboundRelayUrl(url: string): URL {
  const websocket = assertOutboundRelayUrl(url)
  const protocol = websocket.protocol === 'wss:' ? 'https:' : 'http:'
  return assertOutboundRelayHttpUrl(`${protocol}//${websocket.host}`)
}

/**
 * Derive the outbound WebSocket URL from a fail-closed HTTP control origin.
 * `https:` maps to `wss:`. Loopback `http:` maps to `ws:`. A bare origin uses `/v1`.
 */
export function outboundRelayUrlFromHttpUrl(url: string): URL {
  const http = assertOutboundRelayHttpUrl(url)
  const protocol = http.protocol === 'https:' ? 'wss:' : 'ws:'
  const path = http.pathname === '/' || http.pathname === '' ? '/v1' : http.pathname
  return assertOutboundRelayUrl(`${protocol}//${http.host}${path}`)
}

/** Minimal POST used by the outbound control client. Tests inject a fake transport. */
export interface RelayControlFetch {
  (
    url: string,
    init: {
      readonly method: 'POST'
      readonly redirect: 'manual'
      readonly headers: {
        readonly accept: string
        readonly 'content-type': string
      }
      readonly body: string
    },
  ): Promise<{
    readonly ok: boolean
    readonly status: number
    readonly headers: { get(name: string): string | null }
    arrayBuffer(): Promise<ArrayBuffer>
  }>
}

/** Inputs shared by outbound device, token, and revoke calls. */
export interface OutboundRelayControlInput {
  readonly httpUrl: string
  readonly assertion: unknown
  readonly deviceId: string
  readonly fetchImpl?: RelayControlFetch
}

/** Inputs used to register one device over outbound HTTPS. */
export interface RegisterOutboundRelayDeviceInput extends OutboundRelayControlInput {
  readonly publicKey: string
  readonly encryptionPublicKey: string
}

/** Public device returned after a successful outbound registration. */
export interface OutboundRelayDevice {
  readonly deviceId: string
  readonly userId: string
  readonly publicKey: string
  readonly encryptionPublicKey: string
}

/** Short-lived token returned after a successful outbound mint. */
export interface OutboundRelayAccessToken {
  readonly accessToken: string
  readonly expiresAt: number
}

/** Revocation receipt returned after a successful outbound revoke. */
export interface OutboundRelayRevocation {
  readonly deviceId: string
  readonly revokedAt: number
}

/**
 * POST `/v1/devices` over HTTPS (or loopback HTTP). Redirects are re-checked
 * and the request never carries credentials or private keys. An X25519
 * encryption public key is required so sealed mail has a recipient.
 */
export async function registerOutboundRelayDevice(
  input: RegisterOutboundRelayDeviceInput,
): Promise<OutboundRelayDevice> {
  const json = await postRelayControl(input, '/v1/devices', {
    assertion: input.assertion,
    deviceId: input.deviceId,
    publicKey: input.publicKey,
    encryptionPublicKey: input.encryptionPublicKey,
  })
  const device = json.device
  if (device === null || typeof device !== 'object' || Array.isArray(device)) {
    throw new RelayAuthorizationError('malformed', 'relay control device is required')
  }
  return parsePublicDevice(device as Record<string, unknown>)
}

/** Inputs used to enroll a desktop on loopback without an OIDC assertion. */
export interface EnrollOutboundRelayLoopbackDeviceInput {
  readonly httpUrl: string
  readonly deviceId: string
  readonly publicKey: string
  readonly encryptionPublicKey: string
  readonly fetchImpl?: RelayControlFetch
}

/** Loopback enroll returns the public device and a short-lived access token. */
export interface OutboundRelayLoopbackEnrollment {
  readonly device: OutboundRelayDevice
  readonly accessToken: string
  readonly expiresAt: number
}

/**
 * POST `/v1/devices` to loopback HTTP(S) without an assertion. Public hosts
 * fail closed. The returned token is device-bound and is not a JWT paste target.
 */
export async function enrollOutboundRelayLoopbackDevice(
  input: EnrollOutboundRelayLoopbackDeviceInput,
): Promise<OutboundRelayLoopbackEnrollment> {
  const parsed = assertOutboundRelayHttpUrl(input.httpUrl)
  if (!LOOPBACK_HOSTS.has(parsed.hostname)) {
    throw new RelayAuthorizationError('malformed', 'relay loopback enroll is only allowed to loopback')
  }
  const json = await postRelayControl(input, '/v1/devices', {
    deviceId: input.deviceId,
    publicKey: input.publicKey,
    encryptionPublicKey: input.encryptionPublicKey,
  })
  const device = json.device
  if (device === null || typeof device !== 'object' || Array.isArray(device)) {
    throw new RelayAuthorizationError('malformed', 'relay control device is required')
  }
  if (typeof json.accessToken !== 'string' || json.accessToken.length === 0) {
    throw new RelayAuthorizationError('malformed', 'relay control access token is required')
  }
  if (typeof json.expiresAt !== 'number' || !Number.isFinite(json.expiresAt)) {
    throw new RelayAuthorizationError('malformed', 'relay control token expiry is required')
  }
  return {
    device: parsePublicDevice(device as Record<string, unknown>),
    accessToken: json.accessToken,
    expiresAt: json.expiresAt,
  }
}

/**
 * POST `/v1/tokens` over HTTPS (or loopback HTTP) for one registered device.
 */
export async function issueOutboundRelayToken(
  input: OutboundRelayControlInput,
): Promise<OutboundRelayAccessToken> {
  const json = await postRelayControl(input, '/v1/tokens', {
    assertion: input.assertion,
    deviceId: input.deviceId,
  })
  if (typeof json.accessToken !== 'string' || json.accessToken.length === 0) {
    throw new RelayAuthorizationError('malformed', 'relay control access token is required')
  }
  if (typeof json.expiresAt !== 'number' || !Number.isFinite(json.expiresAt)) {
    throw new RelayAuthorizationError('malformed', 'relay control token expiry is required')
  }
  return { accessToken: json.accessToken, expiresAt: json.expiresAt }
}

/** Inputs used to list same-account devices over outbound HTTPS. */
export interface ListOutboundRelayDevicesInput {
  readonly httpUrl: string
  readonly assertion?: unknown
  readonly accessToken?: string
  readonly fetchImpl?: RelayControlFetch
}

/** Inputs used to revoke one device over outbound HTTPS. */
export interface RevokeOutboundRelayDeviceInput {
  readonly httpUrl: string
  readonly assertion?: unknown
  readonly accessToken?: string
  readonly deviceId: string
  readonly fetchImpl?: RelayControlFetch
}

/**
 * POST `/v1/devices/revoke` over HTTPS (or loopback HTTP). The device id
 * cannot be reused after a successful revoke. Present exactly one of an OIDC
 * assertion or a device-bound access token. A token may only revoke itself.
 */
export async function revokeOutboundRelayDevice(
  input: RevokeOutboundRelayDeviceInput,
): Promise<OutboundRelayRevocation> {
  const json = await postRelayControl(input, '/v1/devices/revoke', {
    ...assertionOrAccessTokenBody(input, 'relay device revoke'),
    deviceId: input.deviceId,
  })
  if (typeof json.deviceId !== 'string' || json.deviceId.length === 0) {
    throw new RelayAuthorizationError('malformed', 'relay control revoked device id is required')
  }
  if (typeof json.revokedAt !== 'number' || !Number.isFinite(json.revokedAt)) {
    throw new RelayAuthorizationError('malformed', 'relay control revokedAt is required')
  }
  return { deviceId: json.deviceId, revokedAt: json.revokedAt }
}

/**
 * POST `/v1/devices/list` over HTTPS (or loopback HTTP). Only live devices on
 * the presented account are returned. Private keys are refused. Listed signing
 * and encryption keys must be Ed25519 and X25519. Listed devices must include
 * an X25519 encryption public key. Present exactly one of an OIDC assertion
 * or a device-bound access token.
 */
export async function listOutboundRelayDevices(
  input: ListOutboundRelayDevicesInput,
): Promise<readonly OutboundRelayDevice[]> {
  const json = await postRelayControl(input, '/v1/devices/list', assertionOrAccessTokenBody(
    input,
    'relay device list',
  ))
  if (!Array.isArray(json.devices)) {
    throw new RelayAuthorizationError('malformed', 'relay control device list is required')
  }
  return json.devices.map(item => {
    if (item === null || typeof item !== 'object' || Array.isArray(item)) {
      throw new RelayAuthorizationError('malformed', 'relay control device is required')
    }
    return parsePublicDevice(item as Record<string, unknown>)
  })
}

/** Inputs used to mint a one-time pairing grant from an enrolled desktop. */
export interface MintOutboundRelayPairingGrantInput {
  readonly httpUrl: string
  readonly assertion?: unknown
  readonly accessToken?: string
  readonly deviceId: string
  readonly fetchImpl?: RelayControlFetch
}

/** Pairing code shown once after an outbound mint. */
export interface OutboundRelayPairingGrant {
  readonly pairingCode: string
  readonly expiresAt: number
  readonly desktopDeviceId: string
}

/**
 * POST `/v1/pairing/grants` over HTTPS (or loopback HTTP). The desktop must
 * already be registered. Present exactly one of an OIDC assertion or a
 * device-bound access token. The typed code is returned once and is not a JWT.
 */
export async function mintOutboundRelayPairingGrant(
  input: MintOutboundRelayPairingGrantInput,
): Promise<OutboundRelayPairingGrant> {
  const json = await postRelayControl(input, '/v1/pairing/grants', pairingGrantBody(input))
  if (typeof json.pairingCode !== 'string' || json.pairingCode.length === 0) {
    throw new RelayAuthorizationError('malformed', 'relay control pairing code is required')
  }
  if (typeof json.expiresAt !== 'number' || !Number.isFinite(json.expiresAt)) {
    throw new RelayAuthorizationError('malformed', 'relay control pairing expiry is required')
  }
  if (typeof json.desktopDeviceId !== 'string' || json.desktopDeviceId.length === 0) {
    throw new RelayAuthorizationError('malformed', 'relay control pairing desktop is required')
  }
  return {
    pairingCode: json.pairingCode,
    expiresAt: json.expiresAt,
    desktopDeviceId: json.desktopDeviceId,
  }
}

/** Inputs used to redeem a pairing code into a registered PWA device. */
export interface RedeemOutboundRelayPairingGrantInput {
  readonly httpUrl: string
  readonly pairingCode: string
  readonly deviceId: string
  readonly publicKey: string
  readonly encryptionPublicKey: string
  readonly fetchImpl?: RelayControlFetch
}

/** Redeemed pairing grant: PWA device, minting desktop, and a short-lived token. */
export interface OutboundRelayPairingRedemption {
  readonly device: OutboundRelayDevice
  readonly desktop: OutboundRelayDevice
  readonly accessToken: string
  readonly expiresAt: number
}

/**
 * POST `/v1/pairing/redeem` over HTTPS (or loopback HTTP). No OIDC assertion
 * is sent. The pairing code is spent and a device-bound token is returned.
 */
export async function redeemOutboundRelayPairingGrant(
  input: RedeemOutboundRelayPairingGrantInput,
): Promise<OutboundRelayPairingRedemption> {
  const json = await postRelayControl(input, '/v1/pairing/redeem', {
    pairingCode: input.pairingCode,
    deviceId: input.deviceId,
    publicKey: input.publicKey,
    encryptionPublicKey: input.encryptionPublicKey,
  })
  if (json.device === null || typeof json.device !== 'object' || Array.isArray(json.device)) {
    throw new RelayAuthorizationError('malformed', 'relay control device is required')
  }
  if (json.desktop === null || typeof json.desktop !== 'object' || Array.isArray(json.desktop)) {
    throw new RelayAuthorizationError('malformed', 'relay control pairing desktop is required')
  }
  if (typeof json.accessToken !== 'string' || json.accessToken.length === 0) {
    throw new RelayAuthorizationError('malformed', 'relay control access token is required')
  }
  if (typeof json.expiresAt !== 'number' || !Number.isFinite(json.expiresAt)) {
    throw new RelayAuthorizationError('malformed', 'relay control token expiry is required')
  }
  return {
    device: parsePublicDevice(json.device as Record<string, unknown>),
    desktop: parsePublicDevice(json.desktop as Record<string, unknown>),
    accessToken: json.accessToken,
    expiresAt: json.expiresAt,
  }
}

function pairingGrantBody(input: MintOutboundRelayPairingGrantInput): Record<string, unknown> {
  return {
    ...assertionOrAccessTokenBody(input, 'relay pairing grant'),
    deviceId: input.deviceId,
  }
}

function assertionOrAccessTokenBody(
  input: { readonly assertion?: unknown, readonly accessToken?: string },
  purpose: string,
): Record<string, unknown> {
  const hasAssertion = input.assertion !== undefined
  const hasToken = typeof input.accessToken === 'string' && input.accessToken.length > 0
  if (hasAssertion === hasToken) {
    throw new RelayAuthorizationError('malformed', `${purpose} requires an assertion or access token`)
  }
  return hasToken
    ? { accessToken: input.accessToken }
    : { assertion: input.assertion }
}

async function postRelayControl(
  input: { readonly httpUrl: string, readonly fetchImpl?: RelayControlFetch },
  path: string,
  body: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  refusePrivateKeyMaterial(input as unknown as Record<string, unknown>, 'relay control request')
  refusePrivateKeyMaterial(body, 'relay control request')
  if (body.assertion !== null && typeof body.assertion === 'object' && !Array.isArray(body.assertion)) {
    assertNoPlaintextRelayFields(body.assertion as Record<string, unknown>, 'relay control assertion')
    refusePrivateKeyMaterial(body.assertion as Record<string, unknown>, 'relay control assertion')
  }
  assertNoPlaintextRelayFields(body, 'relay control request')
  const payload = JSON.stringify(body)
  if (Buffer.byteLength(payload) > MAX_BODY_BYTES) {
    throw new RelayAuthorizationError('malformed', 'relay control request body is too large')
  }
  const fetchImpl = input.fetchImpl ?? (globalThis.fetch as RelayControlFetch)
  let current = new URL(path, assertOutboundRelayHttpUrl(input.httpUrl))
  current = assertOutboundRelayHttpUrl(current.href)
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    let response: Awaited<ReturnType<RelayControlFetch>>
    try {
      response = await fetchImpl(current.href, {
        method: 'POST',
        redirect: 'manual',
        headers: {
          accept: 'application/json',
          'content-type': 'application/json',
        },
        body: payload,
      })
    } catch (cause) {
      if (cause instanceof RelayAuthorizationError) throw cause
      throw new RelayAuthorizationError('malformed', 'relay control request could not be sent')
    }
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get('location')
      if (typeof location !== 'string' || location.length === 0) {
        throw new RelayAuthorizationError('malformed', 'relay control redirect is missing')
      }
      current = assertOutboundRelayHttpUrl(new URL(location, current).href)
      continue
    }
    const json = await readJsonResponse(response)
    if (!response.ok) throw controlFailure(json)
    return json
  }
  throw new RelayAuthorizationError('malformed', 'relay control redirected too many times')
}

async function readJsonResponse(
  response: Awaited<ReturnType<RelayControlFetch>>,
): Promise<Record<string, unknown>> {
  const bytes = Buffer.from(await response.arrayBuffer())
  if (bytes.byteLength === 0 || bytes.byteLength > MAX_BODY_BYTES) {
    throw new RelayAuthorizationError('malformed', 'relay control response body is invalid')
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(bytes.toString('utf8'))
  } catch {
    throw new RelayAuthorizationError('malformed', 'relay control response is not json')
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new RelayAuthorizationError('malformed', 'relay control response must be an object')
  }
  const record = parsed as Record<string, unknown>
  assertNoPlaintextRelayFields(record, 'relay control response')
  refusePrivateKeyMaterial(record, 'relay control response')
  return record
}

function controlFailure(json: Record<string, unknown>): RelayAuthorizationError {
  const error = json.error
  if (error !== null && typeof error === 'object' && !Array.isArray(error)) {
    const record = error as Record<string, unknown>
    if (typeof record.code === 'string' && isRelayErrorCode(record.code)) {
      const message = typeof record.message === 'string' && record.message.length > 0
        ? record.message
        : 'relay control request failed'
      return new RelayAuthorizationError(record.code, message)
    }
  }
  return new RelayAuthorizationError('malformed', 'relay control request failed')
}

function parsePublicDevice(record: Record<string, unknown>): OutboundRelayDevice {
  assertNoPlaintextRelayFields(record, 'relay control device')
  refusePrivateKeyMaterial(record, 'relay control device')
  if (typeof record.deviceId !== 'string' || record.deviceId.length === 0 || /[\0\r\n]/u.test(record.deviceId)) {
    throw new RelayAuthorizationError('malformed', 'relay control device id is required')
  }
  if (typeof record.userId !== 'string' || record.userId.length === 0 || /[\0\r\n]/u.test(record.userId)) {
    throw new RelayAuthorizationError('malformed', 'relay control user id is required')
  }
  if (typeof record.publicKey !== 'string' || record.publicKey.length === 0 || /[\0\r\n]/u.test(record.publicKey)) {
    throw new RelayAuthorizationError('malformed', 'relay control public key is required')
  }
  assertDevicePublicKey(record.publicKey)
  if (typeof record.encryptionPublicKey !== 'string' || record.encryptionPublicKey.length === 0 || /[\0\r\n]/u.test(record.encryptionPublicKey)) {
    throw new RelayAuthorizationError('malformed', 'relay control encryption public key is required')
  }
  assertDeviceEncryptionPublicKey(record.encryptionPublicKey)
  return {
    deviceId: record.deviceId,
    userId: record.userId,
    publicKey: record.publicKey,
    encryptionPublicKey: record.encryptionPublicKey,
  }
}

function refusePrivateKeyMaterial(record: Record<string, unknown>, label: string): void {
  for (const field of PRIVATE_KEY_FIELDS) {
    if (field in record) {
      throw new RelayAuthorizationError('plaintext', `${label} must not carry ${field}`)
    }
  }
}
