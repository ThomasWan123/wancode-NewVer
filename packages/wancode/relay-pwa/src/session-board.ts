/** Low-bandwidth PWA session snapshots. Prompt text never appears on this board. */

import { assertPwaRelayRecord } from './credentials.ts'
import {
  assertPwaProgressDetail,
  assertPwaSessionId,
  projectRelayNotification,
  type RelayNotificationView,
  type RelaySessionView,
} from './session-view.ts'

/** Compact status for one desktop session the PWA is watching. */
export type PwaSessionStatus = 'idle' | 'running' | 'awaiting-approval' | 'cancelled' | 'complete'

/** Latest known state for one session. This is a snapshot, not an event log. */
export interface PwaSessionSnapshot {
  readonly sessionId: string
  readonly status: PwaSessionStatus
  readonly lastType?: string
  readonly lastDetail?: string
  readonly pendingRequestId?: string
  readonly notification?: RelayNotificationView
}

interface MutableSession {
  sessionId: string
  status: PwaSessionStatus
  lastType?: string
  lastDetail?: string
  pendingRequestId?: string
  notification?: RelayNotificationView
}

/** In-memory board that folds session views into snapshots. */
export interface PwaSessionBoard {
  apply(view: RelaySessionView): PwaSessionSnapshot | undefined
  snapshot(sessionId: string): PwaSessionSnapshot | undefined
  list(): readonly PwaSessionSnapshot[]
}

/**
 * Fold progress, approval, and cancel views into one snapshot per session.
 * Presence frames are ignored. Prompt text is already omitted by the view.
 */
export function createPwaSessionBoard(): PwaSessionBoard {
  const sessions = new Map<string, MutableSession>()

  return {
    apply(view) {
      assertPwaRelayRecord(view as unknown as Record<string, unknown>, 'pwa session view')
      if (view.kind === 'presence') return undefined
      assertPwaSessionId(view.sessionId)
      if (view.kind === 'progress') assertPwaProgressDetail(view.detail)
      const current = sessions.get(view.sessionId) ?? {
        sessionId: view.sessionId,
        status: 'idle' as const,
      }
      const next = foldView(current, view)
      sessions.set(view.sessionId, next)
      return publish(next)
    },
    snapshot(sessionId) {
      assertPwaSessionId(sessionId)
      const current = sessions.get(sessionId)
      return current === undefined ? undefined : publish(current)
    },
    list() {
      return [...sessions.values()]
        .map(publish)
        .sort((left, right) => left.sessionId.localeCompare(right.sessionId))
    },
  }
}

function foldView(current: MutableSession, view: RelaySessionView): MutableSession {
  switch (view.kind) {
    case 'follow-up':
      return {
        ...omitPending(current),
        status: 'running',
      }
    case 'progress': {
      const notification = projectRelayNotification(view)
      return {
        ...current,
        status: progressStatus(view.type),
        lastType: view.type,
        lastDetail: view.detail,
        ...(notification === undefined ? {} : { notification }),
      }
    }
    case 'approval':
      return {
        ...omitPending(current),
        status: view.approved ? 'running' : 'cancelled',
      }
    case 'cancel':
      return {
        ...current,
        status: 'cancelled',
        pendingRequestId: view.requestId,
      }
    default:
      return current
  }
}

function progressStatus(type: string): PwaSessionStatus {
  if (type === 'notify.tool' || type === 'notify.approval') return 'awaiting-approval'
  if (type === 'assistant.done' || type === 'session.complete') return 'complete'
  return 'running'
}

function omitPending(session: MutableSession): MutableSession {
  const next: MutableSession = {
    sessionId: session.sessionId,
    status: session.status,
  }
  if (session.lastType !== undefined) next.lastType = session.lastType
  if (session.lastDetail !== undefined) next.lastDetail = session.lastDetail
  if (session.notification !== undefined) next.notification = session.notification
  return next
}

function publish(session: MutableSession): PwaSessionSnapshot {
  return {
    sessionId: session.sessionId,
    status: session.status,
    ...(session.lastType === undefined ? {} : { lastType: session.lastType }),
    ...(session.lastDetail === undefined ? {} : { lastDetail: session.lastDetail }),
    ...(session.pendingRequestId === undefined ? {} : { pendingRequestId: session.pendingRequestId }),
    ...(session.notification === undefined ? {} : { notification: session.notification }),
  }
}
