/** Desktop-initiated outbound relay connection. This module never binds a port. */

import { RelayAuthorizationError, isRelayErrorCode } from './errors.ts'
import {
  assertNoPlaintextRelayFields,
  parseRelayEnvelope,
  type RelayEnvelope,
} from './envelope.ts'
import type { RelayDelivery } from './delivery.ts'
import { parseHandshakeAck, type HandshakeAck, type RelayCapability } from './handshake.ts'
import { assertSealedApplicationEnvelope } from './payload.ts'
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
  send(input: SendOutboundRelayFrameInput): Promise<RelayDelivery>
  reclaim(input?: { readonly timeoutMs?: number }): Promise<readonly RelayEnvelope[]>
  acknowledge(input: AcknowledgeOutboundRelayFrameInput): Promise<RelayDelivery>
  receive(input?: { readonly timeoutMs?: number }): Promise<readonly RelayEnvelope[]>
  close(): void
}

/** Inputs used to send one sealed application envelope after handshake. */
export interface SendOutboundRelayFrameInput {
  readonly envelope: unknown
  readonly destinationDeviceId: string
  readonly timeoutMs?: number
}

/** Inputs used to acknowledge one drained mailbox envelope. */
export interface AcknowledgeOutboundRelayFrameInput {
  readonly envelopeId: string
  readonly timeoutMs?: number
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
    const session = startOutboundSession(socket)
    return {
      sessionId: ack.sessionId,
      userId: ack.envelope.actor.userId,
      deviceId: ack.envelope.actor.deviceId,
      grantedCapabilities: ack.grantedCapabilities,
      ack: ack.envelope,
      async send(frame) {
        return parseDeliveryReply(await session.request({
          accessToken: input.accessToken,
          destinationDeviceId: frame.destinationDeviceId,
          envelope: frame.envelope,
        }, frame.timeoutMs ?? timeoutMs))
      },
      async reclaim(frame = {}) {
        return parseMailReply(await session.request({
          accessToken: input.accessToken,
          action: 'reclaim',
        }, frame.timeoutMs ?? timeoutMs))
      },
      async acknowledge(frame) {
        return parseDeliveryReply(await session.request({
          accessToken: input.accessToken,
          action: 'ack',
          envelopeId: frame.envelopeId,
        }, frame.timeoutMs ?? timeoutMs))
      },
      receive(frame = {}) {
        return session.receive(frame.timeoutMs ?? timeoutMs)
      },
      close() {
        session.close()
      },
    }
  } catch (cause) {
    socket.close()
    throw cause
  }
}

function parseMailReply(raw: string): readonly RelayEnvelope[] {
  const record = parseJsonObject(raw, 'relay mailbox reply')
  if ('error' in record) throwWireFailure(record)
  return parseSealedMail(record, 'relay mailbox reply')
}

function parseSealedMail(record: Record<string, unknown>, label: string): readonly RelayEnvelope[] {
  if (!Array.isArray(record.mail)) {
    throw new RelayAuthorizationError('malformed', `${label} is invalid`)
  }
  return record.mail.map(item => assertSealedApplicationEnvelope(item))
}

interface OutboundSession {
  request(payload: Record<string, unknown>, timeoutMs: number): Promise<string>
  receive(timeoutMs: number): Promise<readonly RelayEnvelope[]>
  close(): void
}

function startOutboundSession(socket: RelayWebSocket): OutboundSession {
  type ReplyWaiter = {
    resolve: (raw: string) => void
    reject: (cause: Error) => void
    timer: ReturnType<typeof setTimeout>
  }
  type MailWaiter = {
    resolve: (mail: readonly RelayEnvelope[]) => void
    reject: (cause: Error) => void
    timer: ReturnType<typeof setTimeout>
  }
  const replies: ReplyWaiter[] = []
  const mailWaiters: MailWaiter[] = []
  const incoming: RelayEnvelope[] = []
  let closed = false

  const failAll = (cause: Error) => {
    if (closed) return
    closed = true
    for (const waiter of replies.splice(0)) {
      clearTimeout(waiter.timer)
      waiter.reject(cause)
    }
    for (const waiter of mailWaiters.splice(0)) {
      clearTimeout(waiter.timer)
      waiter.reject(cause)
    }
  }

  const onMessage = (data: unknown) => {
    try {
      const raw = utf8FromSocketData(data)
      const record = parseJsonObject(raw, 'relay frame')
      if (record.push === true) {
        const mail = parseSealedMail(record, 'relay live push')
        const waiter = mailWaiters.shift()
        if (waiter !== undefined) {
          clearTimeout(waiter.timer)
          waiter.resolve(mail)
          return
        }
        incoming.push(...mail)
        return
      }
      const waiter = replies.shift()
      if (waiter === undefined) return
      clearTimeout(waiter.timer)
      waiter.resolve(raw)
    } catch (cause) {
      failAll(cause instanceof Error ? cause : new Error('relay frame is invalid'))
      socket.close()
    }
  }

  socket.on('message', onMessage)
  socket.once('error', failAll)
  socket.once('close', () => failAll(new Error('relay websocket closed')))

  return {
    request(payload, requestTimeoutMs) {
      if (closed) return Promise.reject(new Error('relay websocket closed'))
      return new Promise((resolve, reject) => {
        const waiter: ReplyWaiter = {
          resolve,
          reject,
          timer: setTimeout(() => {
            const index = replies.indexOf(waiter)
            if (index >= 0) replies.splice(index, 1)
            reject(new Error('relay command timed out'))
          }, requestTimeoutMs),
        }
        replies.push(waiter)
        socket.send(JSON.stringify(payload))
      })
    },
    receive(receiveTimeoutMs) {
      if (incoming.length > 0) return Promise.resolve(incoming.splice(0))
      if (closed) return Promise.reject(new Error('relay websocket closed'))
      return new Promise((resolve, reject) => {
        const waiter: MailWaiter = {
          resolve,
          reject,
          timer: setTimeout(() => {
            const index = mailWaiters.indexOf(waiter)
            if (index >= 0) mailWaiters.splice(index, 1)
            reject(new Error('relay live mail timed out'))
          }, receiveTimeoutMs),
        }
        mailWaiters.push(waiter)
      })
    },
    close() {
      socket.off('message', onMessage)
      socket.close()
    },
  }
}

function parseDeliveryReply(raw: string): RelayDelivery {
  const record = parseJsonObject(raw, 'relay delivery reply')
  if ('error' in record) throwWireFailure(record)
  const delivery = record.delivery
  if (delivery === null || typeof delivery !== 'object' || Array.isArray(delivery)) {
    throw new RelayAuthorizationError('malformed', 'relay delivery reply is invalid')
  }
  const body = delivery as Record<string, unknown>
  if (typeof body.envelopeId !== 'string' || body.envelopeId.length === 0) {
    throw new RelayAuthorizationError('malformed', 'relay delivery envelopeId is required')
  }
  if (typeof body.toDeviceId !== 'string' || body.toDeviceId.length === 0) {
    throw new RelayAuthorizationError('malformed', 'relay delivery toDeviceId is required')
  }
  if (body.outcome !== 'delivered' && body.outcome !== 'queued' && body.outcome !== 'duplicate') {
    throw new RelayAuthorizationError('malformed', 'relay delivery outcome is invalid')
  }
  return {
    envelopeId: body.envelopeId,
    toDeviceId: body.toDeviceId,
    outcome: body.outcome,
  }
}

function parseJsonObject(raw: string, label: string): Record<string, unknown> {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    throw new RelayAuthorizationError('malformed', `${label} is not json`)
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new RelayAuthorizationError('malformed', `${label} must be an object`)
  }
  const record = parsed as Record<string, unknown>
  assertNoPlaintextRelayFields(record, label)
  return record
}

function parseReply(raw: string): HandshakeAck {
  const record = parseJsonObject(raw, 'relay handshake reply')
  if ('error' in record) throwWireFailure(record)
  return parseHandshakeAck(record)
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
