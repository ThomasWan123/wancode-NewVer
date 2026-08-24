/**
 * Desktop session ledger adapter.
 *
 * Records append-only evidence at real host seams:
 * - Session start (host boot)
 * - Integrity gate outcomes (pass/reject via integrity-gate)
 * - Tool invocations and approval outcomes (when discoverable)
 * - Skipped probes as NOT-RUN
 *
 * This adapter wraps the kernel's pure SessionLedger and wires it to
 * desktop host boundaries without breaking relay or adding Cordis
 * service dependencies.
 */

import {
  createLedgerEvent,
  createNotRunEvent,
  createSessionLedger,
  type LedgerEvent,
  type LedgerEventKind,
  type SessionLedger,
} from '@wancode/harness-kernel'

let counter = 0

function nextEventId(prefix: string): string {
  return `${prefix}-${Date.now()}-${String(++counter)}`
}

/** Desktop ledger adapter wrapping the kernel's append-only ledger. */
export interface DesktopSessionLedger {
  readonly ledger: SessionLedger
  recordSessionStart(sessionId: string, metadata?: Record<string, unknown>): LedgerEvent
  recordSessionEnd(sessionId: string, metadata?: Record<string, unknown>): LedgerEvent
  recordIntegrityPass(sessionId: string, metadata?: Record<string, unknown>): LedgerEvent
  recordIntegrityReject(sessionId: string, metadata?: Record<string, unknown>): LedgerEvent
  recordToolInvoke(sessionId: string, metadata?: Record<string, unknown>): LedgerEvent
  recordToolResult(sessionId: string, metadata?: Record<string, unknown>): LedgerEvent
  recordApprovalRequest(sessionId: string, metadata?: Record<string, unknown>): LedgerEvent
  recordApprovalGrant(sessionId: string, metadata?: Record<string, unknown>): LedgerEvent
  recordApprovalDeny(sessionId: string, metadata?: Record<string, unknown>): LedgerEvent
  recordNotRun(sessionId: string, metadata?: Record<string, unknown>): LedgerEvent
  snapshot(): readonly LedgerEvent[]
}

function recordEvent(
  ledger: SessionLedger,
  kind: LedgerEventKind,
  sessionId: string,
  metadata?: Record<string, unknown>,
): LedgerEvent {
  const event = createLedgerEvent({
    id: nextEventId(kind),
    kind,
    sessionId,
    timestamp: Date.now(),
    ...(metadata !== undefined ? { metadata } : {}),
  })
  ledger.append(event)
  return event
}

/**
 * Create a desktop session ledger adapter.
 *
 * The adapter is stateless beyond the underlying kernel ledger. It
 * provides typed recording methods for each host seam and ensures
 * all events pass through the kernel's scrub + freeze pipeline.
 */
export function createDesktopSessionLedger(): DesktopSessionLedger {
  const ledger = createSessionLedger()

  return {
    get ledger() {
      return ledger
    },

    recordSessionStart(sessionId, metadata) {
      return recordEvent(ledger, 'session.start', sessionId, metadata)
    },

    recordSessionEnd(sessionId, metadata) {
      return recordEvent(ledger, 'session.end', sessionId, metadata)
    },

    recordIntegrityPass(sessionId, metadata) {
      return recordEvent(ledger, 'integrity.pass', sessionId, metadata)
    },

    recordIntegrityReject(sessionId, metadata) {
      return recordEvent(ledger, 'integrity.reject', sessionId, metadata)
    },

    recordToolInvoke(sessionId, metadata) {
      return recordEvent(ledger, 'tool.invoke', sessionId, metadata)
    },

    recordToolResult(sessionId, metadata) {
      return recordEvent(ledger, 'tool.result', sessionId, metadata)
    },

    recordApprovalRequest(sessionId, metadata) {
      return recordEvent(ledger, 'approval.request', sessionId, metadata)
    },

    recordApprovalGrant(sessionId, metadata) {
      return recordEvent(ledger, 'approval.grant', sessionId, metadata)
    },

    recordApprovalDeny(sessionId, metadata) {
      return recordEvent(ledger, 'approval.deny', sessionId, metadata)
    },

    recordNotRun(sessionId, metadata) {
      const event = createNotRunEvent({
        id: nextEventId('probe.not-run'),
        sessionId,
        timestamp: Date.now(),
        ...(metadata !== undefined ? { metadata } : {}),
      })
      ledger.append(event)
      return event
    },

    snapshot() {
      return ledger.snapshot()
    },
  }
}

/**
 * Wrap the integrity gate functions so they record pass/reject events
 * into a desktop session ledger. The gate behavior is unchanged — this
 * only observes outcomes.
 */
export function observeIntegrityGate(input: {
  readonly sessionLedger: DesktopSessionLedger
  readonly sessionId: string
  readonly gate: <T>(value: unknown) => T
}): <T>(value: unknown) => T {
  return <T>(value: unknown): T => {
    try {
      const result = input.gate<T>(value)
      input.sessionLedger.recordIntegrityPass(input.sessionId, {
        gate: 'integrity',
      })
      return result
    } catch (error) {
      input.sessionLedger.recordIntegrityReject(input.sessionId, {
        gate: 'integrity',
        error: error instanceof Error ? error.message : String(error),
      })
      throw error
    }
  }
}
