/** PWA session projections. These views never carry model credentials or prompt text. */

import {
  RelayAuthorizationError,
  type RelayApplicationPayload,
} from '../../relay-protocol/src/index.ts'
import { assertPwaRelayRecord } from './credentials.ts'

/** Compact progress detail for low-bandwidth PWA links. Matches the desktop sender. */
export const MAX_PWA_PROGRESS_DETAIL_CHARS = 512

/** UI-neutral projection of one opened relay application payload. */
export type RelaySessionView =
  | { readonly kind: 'follow-up', readonly sessionId: string }
  | { readonly kind: 'progress', readonly sessionId: string, readonly type: string, readonly detail: string }
  | { readonly kind: 'approval', readonly sessionId: string, readonly requestId: string, readonly approved: boolean }
  | { readonly kind: 'cancel', readonly sessionId: string, readonly requestId: string }
  | { readonly kind: 'presence', readonly state: 'online' | 'offline' }

/** Low-bandwidth notification derived from a progress event. */
export type RelayNotificationView = {
  readonly kind: 'notification'
  readonly sessionId: string
  readonly type: string
  readonly detail: string
}

/**
 * Project one opened application payload for the mobile PWA.
 * Prompt text stays off the view so logs and UI snapshots cannot leak it.
 */
export function projectRelaySessionView(payload: RelayApplicationPayload): RelaySessionView {
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new RelayAuthorizationError('malformed', 'pwa session payload must be an object')
  }
  assertPwaRelayRecord(payload as unknown as Record<string, unknown>, 'pwa session payload')
  switch (payload.kind) {
    case 'prompt':
      assertPwaSessionId(payload.sessionId)
      return { kind: 'follow-up', sessionId: payload.sessionId }
    case 'session-event':
      assertPwaSessionId(payload.sessionId)
      assertPwaProgressDetail(payload.detail)
      return {
        kind: 'progress',
        sessionId: payload.sessionId,
        type: payload.type,
        detail: payload.detail,
      }
    case 'approval':
      assertPwaSessionId(payload.sessionId)
      return {
        kind: 'approval',
        sessionId: payload.sessionId,
        requestId: payload.requestId,
        approved: payload.approved,
      }
    case 'cancel':
      assertPwaSessionId(payload.sessionId)
      return {
        kind: 'cancel',
        sessionId: payload.sessionId,
        requestId: payload.requestId,
      }
    case 'presence':
      return { kind: 'presence', state: payload.state }
    default: {
      const exhaustive: never = payload
      throw new RelayAuthorizationError('malformed', `pwa session payload kind is not supported: ${String(exhaustive)}`)
    }
  }
}

/**
 * Derive a notification from a progress view. Only `notify.*` types qualify.
 * Prompt text never appears on this object.
 */
export function projectRelayNotification(view: RelaySessionView): RelayNotificationView | undefined {
  if (view.kind !== 'progress' || !view.type.startsWith('notify.')) return undefined
  return {
    kind: 'notification',
    sessionId: view.sessionId,
    type: view.type,
    detail: view.detail,
  }
}

export function assertPwaProgressDetail(detail: string): void {
  if (typeof detail !== 'string' || detail.length === 0 || /[\0\r\n]/u.test(detail)) {
    throw new RelayAuthorizationError('malformed', 'pwa progress detail is required')
  }
  if (detail.length > MAX_PWA_PROGRESS_DETAIL_CHARS) {
    throw new RelayAuthorizationError('malformed', 'pwa progress detail is too large')
  }
}

/**
 * Refuse an empty session id so snapshots cannot collapse unrelated events.
 */
export function assertPwaSessionId(sessionId: string): void {
  if (typeof sessionId !== 'string' || sessionId.length === 0 || /[\0\r\n]/u.test(sessionId)) {
    throw new RelayAuthorizationError('malformed', 'pwa session id is required')
  }
}
