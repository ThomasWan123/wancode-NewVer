/** Desktop-initiated outbound relay connection. This module never binds a port. */

import { RelayAuthorizationError, isRelayErrorCode } from './errors.ts'
import { assertNoPlaintextRelayFields, parseRelayEnvelope, type RelayEnvelope } from './envelope.ts'
import { parseHandshakeAck, type HandshakeAck, type RelayCapability } from './handshake.ts'
import { utf8FromSocketData } from './text.ts'
import { assertOutboundRelayUrl } from './url.ts'
import { NodeWebSocket, type RelayWebSocket } from './ws-runtime.ts'

const DEFAULT_TIMEOUT_MS = 5_000

/** Inputs used by desktop to dial the relay and present a signed handshake. */
export interface ConnectOutboundRelayInput {
  readonly url: string
  readonly accessToken: string
  readonly envelope: unknown
  readonly timeoutMs?: number
}

/** Authorized outbound session plus the live socket the desktop opened. */
export interface OutboundRelayConnection {
  readonly sessionId: string
  readonly userId: string
  readonly deviceId: string
  readonly grantedCapabilities: readonly RelayCapability[]
  readonly ack: RelayEnvelope
  close(): void
}

/**
 * Dial the relay over WebSocket, send the signed handshake as the first JSON
 * frame, and wait for handshake-ack. The client never listens.
 */
export async function connectOutboundRelay(
  input: ConnectOutboundRelayInput,
): Promise<OutboundRelayConnection> {
  const url = assertOutboundRelayUrl(input.url)
  const envelope = parseRelayEnvelope(input.envelope)
  if (envelope.kind !== 'handshake') {
    throw new RelayAuthorizationError('malformed', 'outbound session requires a handshake envelope')
  }
  const timeoutMs = input.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const socket = new NodeWebSocket(url)
  try {
    await waitForOpen(socket, timeoutMs)
    socket.send(JSON.stringify({
      accessToken: input.accessToken,
      envelope: input.envelope,
    }))
    const ack = parseReply(await waitForMessage(socket, timeoutMs))
    return {
      sessionId: ack.sessionId,
      userId: ack.envelope.actor.userId,
      deviceId: ack.envelope.actor.deviceId,
      grantedCapabilities: ack.grantedCapabilities,
      ack: ack.envelope,
      close() {
        socket.close()
      },
    }
  } catch (cause) {
    socket.close()
    throw cause
  }
}

function parseReply(raw: string): HandshakeAck {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    throw new RelayAuthorizationError('malformed', 'relay handshake reply is not json')
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new RelayAuthorizationError('malformed', 'relay handshake reply must be an object')
  }
  const record = parsed as Record<string, unknown>
  assertNoPlaintextRelayFields(record, 'relay handshake reply')
  if ('error' in record) throwWireFailure(record)
  return parseHandshakeAck(parsed)
}

function throwWireFailure(record: Record<string, unknown>): never {
  const error = record.error
  if (error === null || typeof error !== 'object' || Array.isArray(error)) {
    throw new RelayAuthorizationError('malformed', 'relay handshake error is invalid')
  }
  const body = error as Record<string, unknown>
  if (typeof body.code !== 'string' || !isRelayErrorCode(body.code) || typeof body.message !== 'string') {
    throw new RelayAuthorizationError('malformed', 'relay handshake error is invalid')
  }
  throw new RelayAuthorizationError(body.code, body.message)
}

function waitForOpen(socket: RelayWebSocket, timeoutMs: number): Promise<void> {
  if (socket.readyState === NodeWebSocket.OPEN) return Promise.resolve()
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup()
      reject(new Error('relay websocket open timed out'))
    }, timeoutMs)
    const onOpen = () => {
      cleanup()
      resolve()
    }
    const onError = (cause: Error) => {
      cleanup()
      reject(cause)
    }
    const cleanup = () => {
      clearTimeout(timer)
      socket.off('open', onOpen)
      socket.off('error', onError)
    }
    socket.once('open', onOpen)
    socket.once('error', onError)
  })
}

function waitForMessage(socket: RelayWebSocket, timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup()
      reject(new Error('relay handshake timed out'))
    }, timeoutMs)
    const onMessage = (data: unknown) => {
      cleanup()
      resolve(utf8FromSocketData(data))
    }
    const onError = (cause: Error) => {
      cleanup()
      reject(cause)
    }
    const onClose = () => {
      cleanup()
      reject(new Error('relay websocket closed before handshake ack'))
    }
    const cleanup = () => {
      clearTimeout(timer)
      socket.off('message', onMessage)
      socket.off('error', onError)
      socket.off('close', onClose)
    }
    socket.once('message', onMessage)
    socket.once('error', onError)
    socket.once('close', onClose)
  })
}
