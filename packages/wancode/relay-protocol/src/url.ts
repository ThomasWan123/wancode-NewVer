/** Fail-closed outbound relay URL policy. Production uses WSS; cleartext is loopback-only. */

import { RelayAuthorizationError } from './errors.ts'

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1', '[::1]'])

/**
 * Accept a desktop-dialed relay URL.
 * `wss:` is allowed for any host. `ws:` is allowed only to loopback.
 * Credentials must not appear in the URL.
 */
export function assertOutboundRelayUrl(url: string): URL {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    throw new RelayAuthorizationError('malformed', 'relay url is not a valid websocket url')
  }
  if (parsed.username !== '' || parsed.password !== '') {
    throw new RelayAuthorizationError('plaintext', 'relay url must not embed credentials')
  }
  for (const key of parsed.searchParams.keys()) {
    if (/token|secret|credential|password|authorization/iu.test(key)) {
      throw new RelayAuthorizationError('plaintext', 'relay url must not carry credentials')
    }
  }
  if (parsed.protocol === 'wss:') return parsed
  if (parsed.protocol === 'ws:' && LOOPBACK_HOSTS.has(parsed.hostname)) return parsed
  if (parsed.protocol === 'ws:') {
    throw new RelayAuthorizationError(
      'cleartext-transport',
      'cleartext websocket is only allowed to loopback',
    )
  }
  throw new RelayAuthorizationError('malformed', 'relay url must use wss or loopback ws')
}
