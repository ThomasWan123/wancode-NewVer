/** Decode one WebSocket payload as UTF-8 text. */

import { RelayAuthorizationError } from './errors.ts'

/** Convert a `ws` message payload into UTF-8 text, or fail closed. */
export function utf8FromSocketData(data: unknown): string {
  if (typeof data === 'string') return data
  if (Buffer.isBuffer(data)) return data.toString('utf8')
  if (Array.isArray(data) && data.every(item => Buffer.isBuffer(item))) {
    return Buffer.concat(data).toString('utf8')
  }
  if (data instanceof ArrayBuffer) return Buffer.from(new Uint8Array(data)).toString('utf8')
  if (ArrayBuffer.isView(data)) {
    return Buffer.from(new Uint8Array(data.buffer, data.byteOffset, data.byteLength)).toString('utf8')
  }
  throw new RelayAuthorizationError('malformed', 'relay websocket payload is not text')
}
