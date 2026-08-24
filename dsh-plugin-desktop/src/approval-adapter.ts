/**
 * Desktop approval adapter.
 *
 * Wires the kernel ApprovalPolicy evaluator to real host boundaries:
 *
 * - Evaluates approval requests against the active policy
 * - Records approval.request / approval.grant / approval.deny on
 *   the Slice 3 session ledger
 * - Optionally verifies an active lease (Slice 4) when tool-scoped
 * - Exposes request/grant/deny for the loopback/Cordis service boundary
 *
 * The adapter is intentionally independent of sandbox/OS ACL policy.
 * Sandbox enforcement happens at a different layer (profile composition);
 * this adapter only handles user-consent approval decisions.
 */

import {
  evaluateApproval,
  type ApprovalDecision,
  type ApprovalPolicy,
  type ApprovalRequest,
  type ApprovalResourceKind,
  type LeaseManager,
  type SessionLedger,
  createLedgerEvent,
  PROMPT_ALL_POLICY,
} from '@wancode/harness-kernel'

// ---------------------------------------------------------------------------
// ID generation
// ---------------------------------------------------------------------------

let counter = 0

function nextRequestId(): string {
  return `approval-${Date.now()}-${String(++counter)}`
}

function nextEventId(prefix: string): string {
  return `evt-${prefix}-${Date.now()}-${String(++counter)}`
}

// ---------------------------------------------------------------------------
// Pending approval tracking
// ---------------------------------------------------------------------------

export interface PendingApproval {
  readonly request: ApprovalRequest
  readonly decision: ApprovalDecision
  readonly createdAt: number
}

// ---------------------------------------------------------------------------
// Desktop approval adapter interface
// ---------------------------------------------------------------------------

export interface DesktopApprovalAdapter {
  /** The active approval policy. */
  readonly policy: ApprovalPolicy

  /** Update the active approval policy at runtime. */
  setPolicy(policy: ApprovalPolicy): void

  /**
   * Submit a tool/session/subagent approval request.
   * Evaluates against the active policy, records the appropriate
   * ledger event, and returns the decision.
   *
   * When requireLease is true and no active lease is found for the
   * resource, the request is denied regardless of policy.
   */
  requestApproval(input: {
    readonly resourceId: string
    readonly resourceKind: ApprovalResourceKind
    readonly sessionId: string
    readonly ownerId: string
    readonly leaseId?: string
    readonly metadata?: Record<string, unknown>
    readonly requireLease?: boolean
  }): ApprovalDecision

  /**
   * Grant a pending prompted approval.
   * Records approval.grant on the ledger and returns the updated
   * decision. Fails if no pending prompted approval exists.
   */
  grant(input: {
    readonly requestId: string
    readonly sessionId: string
  }): ApprovalDecision

  /**
   * Deny a pending prompted approval.
   * Records approval.deny on the ledger and returns the updated
   * decision. Fails if no pending prompted approval exists.
   */
  deny(input: {
    readonly requestId: string
    readonly sessionId: string
  }): ApprovalDecision

  /** Get a pending approval by requestId. */
  getPending(requestId: string): PendingApproval | undefined

  /** Get all pending approvals for a session. */
  pendingForSession(sessionId: string): readonly PendingApproval[]

  /** Get the count of pending approvals. */
  pendingCount(): number
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export class ApprovalAdapterError extends Error {
  constructor(message: string) {
    super(`Approval adapter: ${message}`)
    this.name = 'ApprovalAdapterError'
  }
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createDesktopApprovalAdapter(
  ledger: SessionLedger,
  leaseManager?: LeaseManager,
  initialPolicy?: ApprovalPolicy,
): DesktopApprovalAdapter {
  let activePolicy: ApprovalPolicy = initialPolicy ?? PROMPT_ALL_POLICY
  const pending = new Map<string, PendingApproval>()

  function recordApprovalEvent(
    kind: 'approval.request' | 'approval.grant' | 'approval.deny',
    sessionId: string,
    metadata: Record<string, unknown>,
  ): void {
    const event = createLedgerEvent({
      id: nextEventId(kind),
      kind,
      sessionId,
      timestamp: Date.now(),
      ...(metadata.leaseId !== undefined ? { leaseId: metadata.leaseId as string } : {}),
      metadata,
    })
    ledger.append(event)
  }

  return {
    get policy(): ApprovalPolicy {
      return activePolicy
    },

    setPolicy(policy: ApprovalPolicy): void {
      activePolicy = policy
    },

    requestApproval(input): ApprovalDecision {
      const requestId = nextRequestId()
      const request: ApprovalRequest = {
        requestId,
        resourceId: input.resourceId,
        resourceKind: input.resourceKind,
        sessionId: input.sessionId,
        ownerId: input.ownerId,
        ...(input.leaseId !== undefined ? { leaseId: input.leaseId } : {}),
        ...(input.metadata !== undefined ? { metadata: input.metadata } : {}),
      }

      if (input.requireLease && leaseManager) {
        const activeLease = leaseManager.activeForResource(input.resourceId)
        if (!activeLease) {
          recordApprovalEvent('approval.request', input.sessionId, {
            requestId,
            resourceId: input.resourceId,
            resourceKind: input.resourceKind,
            ownerId: input.ownerId,
          })
          const denied = Object.freeze({
            requestId,
            outcome: 'denied' as const,
            policyMode: 'deny' as const,
            resourceId: input.resourceId,
            resourceKind: input.resourceKind,
            sessionId: input.sessionId,
            timestamp: Date.now(),
          })
          recordApprovalEvent('approval.deny', input.sessionId, {
            requestId,
            resourceId: input.resourceId,
            reason: 'no-active-lease',
          })
          return denied
        }
      }

      const decision = evaluateApproval(request, activePolicy)

      recordApprovalEvent('approval.request', input.sessionId, {
        requestId,
        resourceId: input.resourceId,
        resourceKind: input.resourceKind,
        ownerId: input.ownerId,
        ...(input.leaseId !== undefined ? { leaseId: input.leaseId } : {}),
      })

      if (decision.outcome === 'approved') {
        recordApprovalEvent('approval.grant', input.sessionId, {
          requestId,
          resourceId: input.resourceId,
          policyMode: decision.policyMode,
          autoApproved: true,
        })
      } else if (decision.outcome === 'denied') {
        recordApprovalEvent('approval.deny', input.sessionId, {
          requestId,
          resourceId: input.resourceId,
          policyMode: decision.policyMode,
        })
      } else {
        pending.set(requestId, {
          request,
          decision,
          createdAt: Date.now(),
        })
      }

      return decision
    },

    grant(input): ApprovalDecision {
      const entry = pending.get(input.requestId)
      if (!entry) {
        throw new ApprovalAdapterError(`no pending approval: ${input.requestId}`)
      }
      pending.delete(input.requestId)

      const granted: ApprovalDecision = Object.freeze({
        requestId: input.requestId,
        outcome: 'approved' as const,
        policyMode: entry.decision.policyMode,
        resourceId: entry.request.resourceId,
        resourceKind: entry.request.resourceKind,
        sessionId: entry.request.sessionId,
        timestamp: Date.now(),
      })

      recordApprovalEvent('approval.grant', input.sessionId, {
        requestId: input.requestId,
        resourceId: entry.request.resourceId,
        grantedBy: 'user',
      })

      return granted
    },

    deny(input): ApprovalDecision {
      const entry = pending.get(input.requestId)
      if (!entry) {
        throw new ApprovalAdapterError(`no pending approval: ${input.requestId}`)
      }
      pending.delete(input.requestId)

      const denied: ApprovalDecision = Object.freeze({
        requestId: input.requestId,
        outcome: 'denied' as const,
        policyMode: entry.decision.policyMode,
        resourceId: entry.request.resourceId,
        resourceKind: entry.request.resourceKind,
        sessionId: entry.request.sessionId,
        timestamp: Date.now(),
      })

      recordApprovalEvent('approval.deny', input.sessionId, {
        requestId: input.requestId,
        resourceId: entry.request.resourceId,
        deniedBy: 'user',
      })

      return denied
    },

    getPending(requestId): PendingApproval | undefined {
      return pending.get(requestId)
    },

    pendingForSession(sessionId): readonly PendingApproval[] {
      const result: PendingApproval[] = []
      for (const entry of pending.values()) {
        if (entry.request.sessionId === sessionId) {
          result.push(entry)
        }
      }
      return result
    },

    pendingCount(): number {
      return pending.size
    },
  }
}
