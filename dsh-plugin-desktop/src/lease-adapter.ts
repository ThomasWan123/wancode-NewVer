/**
 * Desktop lease adapter.
 *
 * Wires the kernel LeaseManager to real tool/session ownership seams
 * in the desktop host. Provides:
 *
 * - Acquire/release around tool and session boundaries
 * - Compensating release/kill on terminal and shutdown paths
 * - Ledger integration: records lease.acquired, lease.released,
 *   lease.denied, and lease.expired events to the session ledger
 *
 * Fail-closed: a second owner cannot steal an active lease.
 */

import {
  createLeaseManager,
  createLedgerEvent,
  type Lease,
  type LeaseAcquireResult,
  type LeaseManager,
  type LeaseReleaseResult,
  type LeaseResourceKind,
  type LedgerEvent,
  type SessionLedger,
} from '@wancode/harness-kernel'

// ---------------------------------------------------------------------------
// ID generation
// ---------------------------------------------------------------------------

let counter = 0

function nextLeaseId(prefix: string): string {
  return `${prefix}-${Date.now()}-${String(++counter)}`
}

function nextEventId(prefix: string): string {
  return `evt-${prefix}-${Date.now()}-${String(++counter)}`
}

// ---------------------------------------------------------------------------
// Desktop lease adapter interface
// ---------------------------------------------------------------------------

export interface DesktopLeaseAdapter {
  readonly manager: LeaseManager

  acquireTool(input: {
    readonly toolId: string
    readonly ownerId: string
    readonly sessionId: string
    readonly durationMs?: number
  }): LeaseAcquireResult

  acquireSession(input: {
    readonly sessionId: string
    readonly ownerId: string
    readonly durationMs?: number
  }): LeaseAcquireResult

  release(input: {
    readonly leaseId: string
    readonly ownerId: string
    readonly sessionId: string
  }): LeaseReleaseResult

  releaseAllForOwner(input: {
    readonly ownerId: string
    readonly sessionId: string
    readonly reason: string
  }): readonly Lease[]

  expireStale(sessionId: string): readonly Lease[]

  compensatingShutdown(input: {
    readonly sessionId: string
    readonly reason: string
  }): readonly Lease[]
}

// ---------------------------------------------------------------------------
// Default lease duration
// ---------------------------------------------------------------------------

const DEFAULT_TOOL_LEASE_MS = 60_000
const DEFAULT_SESSION_LEASE_MS = 300_000

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createDesktopLeaseAdapter(ledger: SessionLedger): DesktopLeaseAdapter {
  const manager = createLeaseManager()

  function recordLeaseEvent(
    kind: 'lease.acquired' | 'lease.released' | 'lease.denied' | 'lease.expired',
    sessionId: string,
    metadata: Record<string, unknown>,
  ): LedgerEvent {
    const leaseId = metadata.leaseId as string | undefined
    const event = createLedgerEvent({
      id: nextEventId(kind),
      kind,
      sessionId,
      timestamp: Date.now(),
      ...(leaseId !== undefined ? { leaseId } : {}),
      metadata,
    })
    ledger.append(event)
    return event
  }

  function acquireResource(
    resourceId: string,
    resourceKind: LeaseResourceKind,
    ownerId: string,
    sessionId: string,
    durationMs: number,
  ): LeaseAcquireResult {
    const leaseId = nextLeaseId(resourceKind)
    const now = Date.now()
    const result = manager.acquire({
      id: leaseId,
      resourceId,
      resourceKind,
      ownerId,
      durationMs,
      now,
    })

    if (result.ok) {
      recordLeaseEvent('lease.acquired', sessionId, {
        leaseId: result.lease.id,
        resourceId,
        resourceKind,
        ownerId,
      })
    } else {
      recordLeaseEvent('lease.denied', sessionId, {
        resourceId,
        resourceKind,
        ownerId,
        reason: result.reason,
        holderId: result.holder?.ownerId,
      })
    }

    return result
  }

  return {
    get manager() {
      return manager
    },

    acquireTool(input) {
      return acquireResource(
        input.toolId,
        'tool',
        input.ownerId,
        input.sessionId,
        input.durationMs ?? DEFAULT_TOOL_LEASE_MS,
      )
    },

    acquireSession(input) {
      return acquireResource(
        input.sessionId,
        'session',
        input.ownerId,
        input.sessionId,
        input.durationMs ?? DEFAULT_SESSION_LEASE_MS,
      )
    },

    release(input) {
      const now = Date.now()
      const result = manager.release({
        leaseId: input.leaseId,
        ownerId: input.ownerId,
        now,
      })

      if (result.ok) {
        recordLeaseEvent('lease.released', input.sessionId, {
          leaseId: input.leaseId,
          ownerId: input.ownerId,
          resourceId: result.lease.resourceId,
        })
      }

      return result
    },

    releaseAllForOwner(input) {
      const held = manager.allHeldBy(input.ownerId)
      const now = Date.now()
      const released: Lease[] = []

      for (const lease of held) {
        const result = manager.release({
          leaseId: lease.id,
          ownerId: input.ownerId,
          now,
        })
        if (result.ok) {
          released.push(result.lease)
          recordLeaseEvent('lease.released', input.sessionId, {
            leaseId: lease.id,
            ownerId: input.ownerId,
            resourceId: lease.resourceId,
            compensating: true,
            reason: input.reason,
          })
        }
      }

      return released
    },

    expireStale(sessionId) {
      const now = Date.now()
      const expired = manager.expireAll(now)

      for (const lease of expired) {
        recordLeaseEvent('lease.expired', sessionId, {
          leaseId: lease.id,
          resourceId: lease.resourceId,
          ownerId: lease.ownerId,
        })
      }

      return expired
    },

    compensatingShutdown(input) {
      const all = manager.allActive()
      const now = Date.now()
      const released: Lease[] = []

      for (const lease of all) {
        const result = manager.release({
          leaseId: lease.id,
          ownerId: lease.ownerId,
          now,
        })
        if (result.ok) {
          released.push(result.lease)
          recordLeaseEvent('lease.released', input.sessionId, {
            leaseId: lease.id,
            ownerId: lease.ownerId,
            resourceId: lease.resourceId,
            compensating: true,
            reason: input.reason,
          })
        }
      }

      return released
    },
  }
}
