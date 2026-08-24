import { describe, expect, it, beforeEach } from 'vitest'
import {
  createSessionLedger,
  createLeaseManager,
  createApprovalPolicy,
  PROMPT_ALL_POLICY,
  AUTO_APPROVE_ALL_POLICY,
  DENY_ALL_POLICY,
  type SessionLedger,
  type LeaseManager,
} from '@wancode/harness-kernel'
import {
  createDesktopApprovalAdapter,
  ApprovalAdapterError,
  type DesktopApprovalAdapter,
} from '../src/approval-adapter.ts'

describe('createDesktopApprovalAdapter', () => {
  let ledger: SessionLedger
  let adapter: DesktopApprovalAdapter

  beforeEach(() => {
    ledger = createSessionLedger()
    adapter = createDesktopApprovalAdapter(ledger)
  })

  it('defaults to prompt-all policy', () => {
    expect(adapter.policy.defaultMode).toBe('prompt')
  })

  it('accepts a custom initial policy', () => {
    const custom = createDesktopApprovalAdapter(ledger, undefined, AUTO_APPROVE_ALL_POLICY)
    expect(custom.policy.defaultMode).toBe('auto-approve')
  })

  // -------------------------------------------------------------------------
  // Policy matrix: auto-approve / prompt / deny
  // -------------------------------------------------------------------------

  describe('auto-approve policy', () => {
    beforeEach(() => {
      adapter.setPolicy(AUTO_APPROVE_ALL_POLICY)
    })

    it('auto-approves tool requests', () => {
      const decision = adapter.requestApproval({
        resourceId: 'shell',
        resourceKind: 'tool',
        sessionId: 'sess-1',
        ownerId: 'agent-1',
      })
      expect(decision.outcome).toBe('approved')
      expect(decision.policyMode).toBe('auto-approve')
    })

    it('records approval.request + approval.grant on ledger', () => {
      adapter.requestApproval({
        resourceId: 'shell',
        resourceKind: 'tool',
        sessionId: 'sess-1',
        ownerId: 'agent-1',
      })
      const events = ledger.snapshot()
      const kinds = events.map(e => e.kind)
      expect(kinds).toContain('approval.request')
      expect(kinds).toContain('approval.grant')
    })

    it('marks grant as autoApproved in metadata', () => {
      adapter.requestApproval({
        resourceId: 'shell',
        resourceKind: 'tool',
        sessionId: 'sess-1',
        ownerId: 'agent-1',
      })
      const grant = ledger.snapshot().find(e => e.kind === 'approval.grant')
      expect(grant?.metadata?.autoApproved).toBe(true)
    })

    it('does not create pending approvals', () => {
      adapter.requestApproval({
        resourceId: 'shell',
        resourceKind: 'tool',
        sessionId: 'sess-1',
        ownerId: 'agent-1',
      })
      expect(adapter.pendingCount()).toBe(0)
    })
  })

  describe('prompt policy', () => {
    beforeEach(() => {
      adapter.setPolicy(PROMPT_ALL_POLICY)
    })

    it('returns prompted for tool requests', () => {
      const decision = adapter.requestApproval({
        resourceId: 'shell',
        resourceKind: 'tool',
        sessionId: 'sess-1',
        ownerId: 'agent-1',
      })
      expect(decision.outcome).toBe('prompted')
      expect(decision.policyMode).toBe('prompt')
    })

    it('records approval.request on ledger', () => {
      adapter.requestApproval({
        resourceId: 'shell',
        resourceKind: 'tool',
        sessionId: 'sess-1',
        ownerId: 'agent-1',
      })
      const events = ledger.snapshot()
      expect(events.some(e => e.kind === 'approval.request')).toBe(true)
    })

    it('creates a pending approval', () => {
      const decision = adapter.requestApproval({
        resourceId: 'shell',
        resourceKind: 'tool',
        sessionId: 'sess-1',
        ownerId: 'agent-1',
      })
      expect(adapter.pendingCount()).toBe(1)
      const pending = adapter.getPending(decision.requestId)
      expect(pending).toBeDefined()
      expect(pending!.request.resourceId).toBe('shell')
    })

    it('tracks multiple pending approvals', () => {
      adapter.requestApproval({
        resourceId: 'shell',
        resourceKind: 'tool',
        sessionId: 'sess-1',
        ownerId: 'agent-1',
      })
      adapter.requestApproval({
        resourceId: 'browser',
        resourceKind: 'tool',
        sessionId: 'sess-1',
        ownerId: 'agent-1',
      })
      expect(adapter.pendingCount()).toBe(2)
    })

    it('lists pending for a specific session', () => {
      adapter.requestApproval({
        resourceId: 'shell',
        resourceKind: 'tool',
        sessionId: 'sess-1',
        ownerId: 'agent-1',
      })
      adapter.requestApproval({
        resourceId: 'browser',
        resourceKind: 'tool',
        sessionId: 'sess-2',
        ownerId: 'agent-1',
      })
      expect(adapter.pendingForSession('sess-1')).toHaveLength(1)
      expect(adapter.pendingForSession('sess-2')).toHaveLength(1)
      expect(adapter.pendingForSession('sess-3')).toHaveLength(0)
    })
  })

  describe('deny policy', () => {
    beforeEach(() => {
      adapter.setPolicy(DENY_ALL_POLICY)
    })

    it('denies tool requests', () => {
      const decision = adapter.requestApproval({
        resourceId: 'shell',
        resourceKind: 'tool',
        sessionId: 'sess-1',
        ownerId: 'agent-1',
      })
      expect(decision.outcome).toBe('denied')
      expect(decision.policyMode).toBe('deny')
    })

    it('records approval.request + approval.deny on ledger', () => {
      adapter.requestApproval({
        resourceId: 'shell',
        resourceKind: 'tool',
        sessionId: 'sess-1',
        ownerId: 'agent-1',
      })
      const events = ledger.snapshot()
      const kinds = events.map(e => e.kind)
      expect(kinds).toContain('approval.request')
      expect(kinds).toContain('approval.deny')
    })

    it('does not create pending approvals', () => {
      adapter.requestApproval({
        resourceId: 'shell',
        resourceKind: 'tool',
        sessionId: 'sess-1',
        ownerId: 'agent-1',
      })
      expect(adapter.pendingCount()).toBe(0)
    })
  })

  // -------------------------------------------------------------------------
  // Grant/deny user interaction
  // -------------------------------------------------------------------------

  describe('grant', () => {
    it('grants a pending prompted approval', () => {
      adapter.setPolicy(PROMPT_ALL_POLICY)
      const decision = adapter.requestApproval({
        resourceId: 'shell',
        resourceKind: 'tool',
        sessionId: 'sess-1',
        ownerId: 'agent-1',
      })
      expect(decision.outcome).toBe('prompted')

      const granted = adapter.grant({
        requestId: decision.requestId,
        sessionId: 'sess-1',
      })
      expect(granted.outcome).toBe('approved')
      expect(granted.requestId).toBe(decision.requestId)
      expect(granted.resourceId).toBe('shell')
      expect(Object.isFrozen(granted)).toBe(true)
    })

    it('records approval.grant with grantedBy user', () => {
      adapter.setPolicy(PROMPT_ALL_POLICY)
      const decision = adapter.requestApproval({
        resourceId: 'shell',
        resourceKind: 'tool',
        sessionId: 'sess-1',
        ownerId: 'agent-1',
      })
      adapter.grant({ requestId: decision.requestId, sessionId: 'sess-1' })

      const grants = ledger.snapshot().filter(e => e.kind === 'approval.grant')
      expect(grants).toHaveLength(1)
      expect(grants[0]!.metadata?.grantedBy).toBe('user')
    })

    it('removes the pending approval after grant', () => {
      adapter.setPolicy(PROMPT_ALL_POLICY)
      const decision = adapter.requestApproval({
        resourceId: 'shell',
        resourceKind: 'tool',
        sessionId: 'sess-1',
        ownerId: 'agent-1',
      })
      adapter.grant({ requestId: decision.requestId, sessionId: 'sess-1' })
      expect(adapter.pendingCount()).toBe(0)
      expect(adapter.getPending(decision.requestId)).toBeUndefined()
    })

    it('throws when no pending approval exists', () => {
      expect(() =>
        adapter.grant({ requestId: 'nonexistent', sessionId: 'sess-1' }),
      ).toThrow(ApprovalAdapterError)
      expect(() =>
        adapter.grant({ requestId: 'nonexistent', sessionId: 'sess-1' }),
      ).toThrow('no pending approval')
    })
  })

  describe('deny', () => {
    it('denies a pending prompted approval', () => {
      adapter.setPolicy(PROMPT_ALL_POLICY)
      const decision = adapter.requestApproval({
        resourceId: 'shell',
        resourceKind: 'tool',
        sessionId: 'sess-1',
        ownerId: 'agent-1',
      })
      const denied = adapter.deny({
        requestId: decision.requestId,
        sessionId: 'sess-1',
      })
      expect(denied.outcome).toBe('denied')
      expect(denied.requestId).toBe(decision.requestId)
      expect(Object.isFrozen(denied)).toBe(true)
    })

    it('records approval.deny with deniedBy user', () => {
      adapter.setPolicy(PROMPT_ALL_POLICY)
      const decision = adapter.requestApproval({
        resourceId: 'shell',
        resourceKind: 'tool',
        sessionId: 'sess-1',
        ownerId: 'agent-1',
      })
      adapter.deny({ requestId: decision.requestId, sessionId: 'sess-1' })

      const denials = ledger.snapshot().filter(e => e.kind === 'approval.deny')
      expect(denials).toHaveLength(1)
      expect(denials[0]!.metadata?.deniedBy).toBe('user')
    })

    it('removes the pending approval after deny', () => {
      adapter.setPolicy(PROMPT_ALL_POLICY)
      const decision = adapter.requestApproval({
        resourceId: 'shell',
        resourceKind: 'tool',
        sessionId: 'sess-1',
        ownerId: 'agent-1',
      })
      adapter.deny({ requestId: decision.requestId, sessionId: 'sess-1' })
      expect(adapter.pendingCount()).toBe(0)
    })

    it('throws when no pending approval exists', () => {
      expect(() =>
        adapter.deny({ requestId: 'nonexistent', sessionId: 'sess-1' }),
      ).toThrow(ApprovalAdapterError)
    })
  })

  // -------------------------------------------------------------------------
  // setPolicy runtime change
  // -------------------------------------------------------------------------

  describe('setPolicy', () => {
    it('changes policy at runtime', () => {
      adapter.setPolicy(AUTO_APPROVE_ALL_POLICY)
      expect(adapter.policy.defaultMode).toBe('auto-approve')

      const d1 = adapter.requestApproval({
        resourceId: 'shell',
        resourceKind: 'tool',
        sessionId: 'sess-1',
        ownerId: 'agent-1',
      })
      expect(d1.outcome).toBe('approved')

      adapter.setPolicy(DENY_ALL_POLICY)
      expect(adapter.policy.defaultMode).toBe('deny')

      const d2 = adapter.requestApproval({
        resourceId: 'browser',
        resourceKind: 'tool',
        sessionId: 'sess-1',
        ownerId: 'agent-1',
      })
      expect(d2.outcome).toBe('denied')
    })
  })

  // -------------------------------------------------------------------------
  // Rule-based policy
  // -------------------------------------------------------------------------

  describe('rule-based policy', () => {
    it('applies resourceKind-based rules', () => {
      const policy = createApprovalPolicy({
        defaultMode: 'prompt',
        rules: [
          { resourceKind: 'tool', mode: 'auto-approve' },
        ],
      })
      adapter.setPolicy(policy)

      const toolDecision = adapter.requestApproval({
        resourceId: 'shell',
        resourceKind: 'tool',
        sessionId: 'sess-1',
        ownerId: 'agent-1',
      })
      expect(toolDecision.outcome).toBe('approved')

      const sessionDecision = adapter.requestApproval({
        resourceId: 'sess-main',
        resourceKind: 'session',
        sessionId: 'sess-1',
        ownerId: 'agent-1',
      })
      expect(sessionDecision.outcome).toBe('prompted')
    })

    it('applies resourcePattern-based rules', () => {
      const policy = createApprovalPolicy({
        defaultMode: 'deny',
        rules: [
          { resourcePattern: 'safe-*', mode: 'auto-approve' },
        ],
      })
      adapter.setPolicy(policy)

      const yes = adapter.requestApproval({
        resourceId: 'safe-read',
        resourceKind: 'tool',
        sessionId: 'sess-1',
        ownerId: 'agent-1',
      })
      expect(yes.outcome).toBe('approved')

      const no = adapter.requestApproval({
        resourceId: 'dangerous-write',
        resourceKind: 'tool',
        sessionId: 'sess-1',
        ownerId: 'agent-1',
      })
      expect(no.outcome).toBe('denied')
    })
  })

  // -------------------------------------------------------------------------
  // Lease integration
  // -------------------------------------------------------------------------

  describe('lease requirement', () => {
    let leaseManager: LeaseManager
    let adapterWithLease: DesktopApprovalAdapter

    beforeEach(() => {
      leaseManager = createLeaseManager()
      adapterWithLease = createDesktopApprovalAdapter(
        ledger,
        leaseManager,
        AUTO_APPROVE_ALL_POLICY,
      )
    })

    it('denies when requireLease is true and no active lease', () => {
      const decision = adapterWithLease.requestApproval({
        resourceId: 'shell',
        resourceKind: 'tool',
        sessionId: 'sess-1',
        ownerId: 'agent-1',
        requireLease: true,
      })
      expect(decision.outcome).toBe('denied')
    })

    it('records denial reason as no-active-lease in metadata', () => {
      adapterWithLease.requestApproval({
        resourceId: 'shell',
        resourceKind: 'tool',
        sessionId: 'sess-1',
        ownerId: 'agent-1',
        requireLease: true,
      })
      const deny = ledger.snapshot().find(e => e.kind === 'approval.deny')
      expect(deny?.metadata?.reason).toBe('no-active-lease')
    })

    it('proceeds when requireLease is true and lease is active', () => {
      leaseManager.acquire({
        id: 'lease-1',
        resourceId: 'shell',
        resourceKind: 'tool',
        ownerId: 'agent-1',
        durationMs: 60_000,
        now: Date.now(),
      })

      const decision = adapterWithLease.requestApproval({
        resourceId: 'shell',
        resourceKind: 'tool',
        sessionId: 'sess-1',
        ownerId: 'agent-1',
        requireLease: true,
      })
      expect(decision.outcome).toBe('approved')
    })

    it('ignores requireLease when no leaseManager provided', () => {
      const noLeaseAdapter = createDesktopApprovalAdapter(
        ledger,
        undefined,
        AUTO_APPROVE_ALL_POLICY,
      )
      const decision = noLeaseAdapter.requestApproval({
        resourceId: 'shell',
        resourceKind: 'tool',
        sessionId: 'sess-1',
        ownerId: 'agent-1',
        requireLease: true,
      })
      expect(decision.outcome).toBe('approved')
    })
  })

  // -------------------------------------------------------------------------
  // Ledger event verification
  // -------------------------------------------------------------------------

  describe('ledger events', () => {
    it('records scrubbed metadata', () => {
      adapter.setPolicy(AUTO_APPROVE_ALL_POLICY)
      adapter.requestApproval({
        resourceId: 'shell',
        resourceKind: 'tool',
        sessionId: 'sess-1',
        ownerId: 'agent-1',
        metadata: { info: 'safe-value' },
      })
      const events = ledger.snapshot()
      expect(events.length).toBeGreaterThanOrEqual(2)
      for (const evt of events) {
        expect(Object.isFrozen(evt)).toBe(true)
      }
    })

    it('approval events have correct sessionId', () => {
      adapter.setPolicy(AUTO_APPROVE_ALL_POLICY)
      adapter.requestApproval({
        resourceId: 'shell',
        resourceKind: 'tool',
        sessionId: 'my-sess',
        ownerId: 'agent-1',
      })
      for (const evt of ledger.snapshot()) {
        expect(evt.sessionId).toBe('my-sess')
      }
    })
  })

  // -------------------------------------------------------------------------
  // Approval ≠ sandbox
  // -------------------------------------------------------------------------

  describe('approval ≠ sandbox', () => {
    it('adapter has no sandbox/ACL/permission references in its API', () => {
      const methods = Object.keys(adapter)
      expect(methods).not.toContain('sandbox')
      expect(methods).not.toContain('acl')
      expect(methods).not.toContain('permission')
    })

    it('decisions do not reference sandbox state', () => {
      adapter.setPolicy(PROMPT_ALL_POLICY)
      const decision = adapter.requestApproval({
        resourceId: 'shell',
        resourceKind: 'tool',
        sessionId: 'sess-1',
        ownerId: 'agent-1',
      })
      const keys = Object.keys(decision)
      expect(keys).not.toContain('sandbox')
      expect(keys).not.toContain('acl')
      expect(keys).not.toContain('os')
    })

    it('approval policy is independent of permission mode', () => {
      adapter.setPolicy(AUTO_APPROVE_ALL_POLICY)
      const d1 = adapter.requestApproval({
        resourceId: 'shell',
        resourceKind: 'tool',
        sessionId: 'sess-1',
        ownerId: 'agent-1',
      })
      expect(d1.outcome).toBe('approved')

      adapter.setPolicy(DENY_ALL_POLICY)
      const d2 = adapter.requestApproval({
        resourceId: 'shell',
        resourceKind: 'tool',
        sessionId: 'sess-1',
        ownerId: 'agent-1',
      })
      expect(d2.outcome).toBe('denied')
    })
  })
})
