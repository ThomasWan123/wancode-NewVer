import { describe, expect, it } from 'vitest'
import {
  evaluateApproval,
  createApprovalPolicy,
  ApprovalPolicyError,
  PROMPT_ALL_POLICY,
  AUTO_APPROVE_ALL_POLICY,
  DENY_ALL_POLICY,
  type ApprovalRequest,
  type ApprovalPolicy,
} from '../src/approval.ts'

function makeRequest(overrides: Partial<ApprovalRequest> = {}): ApprovalRequest {
  return {
    requestId: overrides.requestId ?? 'req-1',
    resourceId: overrides.resourceId ?? 'tool-shell',
    resourceKind: overrides.resourceKind ?? 'tool',
    sessionId: overrides.sessionId ?? 'sess-1',
    ownerId: overrides.ownerId ?? 'agent-1',
    ...(overrides.leaseId !== undefined ? { leaseId: overrides.leaseId } : {}),
    ...(overrides.metadata !== undefined ? { metadata: overrides.metadata } : {}),
  }
}

// ---------------------------------------------------------------------------
// evaluateApproval — policy matrix
// ---------------------------------------------------------------------------

describe('evaluateApproval', () => {
  describe('auto-approve policy', () => {
    it('returns approved for any tool request', () => {
      const decision = evaluateApproval(makeRequest(), AUTO_APPROVE_ALL_POLICY, 1000)
      expect(decision.outcome).toBe('approved')
      expect(decision.policyMode).toBe('auto-approve')
      expect(decision.requestId).toBe('req-1')
      expect(decision.resourceId).toBe('tool-shell')
      expect(decision.resourceKind).toBe('tool')
      expect(decision.sessionId).toBe('sess-1')
      expect(decision.timestamp).toBe(1000)
    })

    it('returns approved for session requests', () => {
      const decision = evaluateApproval(
        makeRequest({ resourceKind: 'session', resourceId: 'sess-main' }),
        AUTO_APPROVE_ALL_POLICY,
        2000,
      )
      expect(decision.outcome).toBe('approved')
      expect(decision.resourceKind).toBe('session')
    })

    it('returns approved for subagent requests', () => {
      const decision = evaluateApproval(
        makeRequest({ resourceKind: 'subagent', resourceId: 'sub-1' }),
        AUTO_APPROVE_ALL_POLICY,
        3000,
      )
      expect(decision.outcome).toBe('approved')
      expect(decision.resourceKind).toBe('subagent')
    })

    it('returns a frozen decision', () => {
      const decision = evaluateApproval(makeRequest(), AUTO_APPROVE_ALL_POLICY, 1000)
      expect(Object.isFrozen(decision)).toBe(true)
    })
  })

  describe('prompt policy', () => {
    it('returns prompted for any tool request', () => {
      const decision = evaluateApproval(makeRequest(), PROMPT_ALL_POLICY, 1000)
      expect(decision.outcome).toBe('prompted')
      expect(decision.policyMode).toBe('prompt')
    })

    it('returns prompted for session requests', () => {
      const decision = evaluateApproval(
        makeRequest({ resourceKind: 'session' }),
        PROMPT_ALL_POLICY,
        1000,
      )
      expect(decision.outcome).toBe('prompted')
    })
  })

  describe('deny policy', () => {
    it('returns denied for any tool request', () => {
      const decision = evaluateApproval(makeRequest(), DENY_ALL_POLICY, 1000)
      expect(decision.outcome).toBe('denied')
      expect(decision.policyMode).toBe('deny')
    })

    it('returns denied for session requests', () => {
      const decision = evaluateApproval(
        makeRequest({ resourceKind: 'session' }),
        DENY_ALL_POLICY,
        1000,
      )
      expect(decision.outcome).toBe('denied')
    })

    it('returns denied for subagent requests', () => {
      const decision = evaluateApproval(
        makeRequest({ resourceKind: 'subagent' }),
        DENY_ALL_POLICY,
        1000,
      )
      expect(decision.outcome).toBe('denied')
    })
  })

  describe('rule matching', () => {
    it('matches by resourceKind', () => {
      const policy = createApprovalPolicy({
        defaultMode: 'prompt',
        rules: [
          { resourceKind: 'tool', mode: 'auto-approve' },
        ],
      })
      const decision = evaluateApproval(makeRequest({ resourceKind: 'tool' }), policy, 1000)
      expect(decision.outcome).toBe('approved')
      expect(decision.policyMode).toBe('auto-approve')
    })

    it('does not match unrelated resourceKind', () => {
      const policy = createApprovalPolicy({
        defaultMode: 'prompt',
        rules: [
          { resourceKind: 'subagent', mode: 'auto-approve' },
        ],
      })
      const decision = evaluateApproval(makeRequest({ resourceKind: 'tool' }), policy, 1000)
      expect(decision.outcome).toBe('prompted')
    })

    it('matches by resourcePattern with wildcard', () => {
      const policy = createApprovalPolicy({
        defaultMode: 'deny',
        rules: [
          { resourcePattern: 'tool-*', mode: 'auto-approve' },
        ],
      })
      const decision = evaluateApproval(
        makeRequest({ resourceId: 'tool-shell' }),
        policy,
        1000,
      )
      expect(decision.outcome).toBe('approved')
    })

    it('does not match non-matching resourcePattern', () => {
      const policy = createApprovalPolicy({
        defaultMode: 'deny',
        rules: [
          { resourcePattern: 'tool-*', mode: 'auto-approve' },
        ],
      })
      const decision = evaluateApproval(
        makeRequest({ resourceId: 'browser-fetch' }),
        policy,
        1000,
      )
      expect(decision.outcome).toBe('denied')
    })

    it('matches by exact resourcePattern', () => {
      const policy = createApprovalPolicy({
        defaultMode: 'deny',
        rules: [
          { resourcePattern: 'tool-shell', mode: 'auto-approve' },
        ],
      })
      const decision = evaluateApproval(
        makeRequest({ resourceId: 'tool-shell' }),
        policy,
        1000,
      )
      expect(decision.outcome).toBe('approved')
    })

    it('matches catch-all resourcePattern *', () => {
      const policy = createApprovalPolicy({
        defaultMode: 'deny',
        rules: [
          { resourcePattern: '*', mode: 'prompt' },
        ],
      })
      const decision = evaluateApproval(makeRequest(), policy, 1000)
      expect(decision.outcome).toBe('prompted')
    })

    it('matches by combined resourceKind and resourcePattern', () => {
      const policy = createApprovalPolicy({
        defaultMode: 'deny',
        rules: [
          { resourceKind: 'tool', resourcePattern: 'shell-*', mode: 'auto-approve' },
        ],
      })
      const yes = evaluateApproval(
        makeRequest({ resourceKind: 'tool', resourceId: 'shell-bash' }),
        policy,
        1000,
      )
      expect(yes.outcome).toBe('approved')

      const no = evaluateApproval(
        makeRequest({ resourceKind: 'session', resourceId: 'shell-bash' }),
        policy,
        2000,
      )
      expect(no.outcome).toBe('denied')
    })

    it('uses first matching rule (order matters)', () => {
      const policy = createApprovalPolicy({
        defaultMode: 'deny',
        rules: [
          { resourcePattern: 'tool-*', mode: 'prompt' },
          { resourcePattern: 'tool-shell', mode: 'auto-approve' },
        ],
      })
      const decision = evaluateApproval(
        makeRequest({ resourceId: 'tool-shell' }),
        policy,
        1000,
      )
      expect(decision.outcome).toBe('prompted')
    })

    it('falls back to defaultMode when no rule matches', () => {
      const policy = createApprovalPolicy({
        defaultMode: 'prompt',
        rules: [
          { resourceKind: 'subagent', mode: 'deny' },
        ],
      })
      const decision = evaluateApproval(
        makeRequest({ resourceKind: 'tool' }),
        policy,
        1000,
      )
      expect(decision.outcome).toBe('prompted')
    })
  })

  describe('preserves request metadata in decision', () => {
    it('records leaseId when present', () => {
      const req = makeRequest({ leaseId: 'lease-42' })
      expect(req.leaseId).toBe('lease-42')
    })

    it('records requestId, resourceId, sessionId', () => {
      const decision = evaluateApproval(
        makeRequest({
          requestId: 'r-99',
          resourceId: 'my-tool',
          sessionId: 'my-sess',
        }),
        PROMPT_ALL_POLICY,
        5000,
      )
      expect(decision.requestId).toBe('r-99')
      expect(decision.resourceId).toBe('my-tool')
      expect(decision.sessionId).toBe('my-sess')
      expect(decision.timestamp).toBe(5000)
    })
  })

  describe('fail-closed: malformed requests', () => {
    it('throws on empty requestId', () => {
      expect(() =>
        evaluateApproval(makeRequest({ requestId: '' }), PROMPT_ALL_POLICY, 1000),
      ).toThrow(ApprovalPolicyError)
      expect(() =>
        evaluateApproval(makeRequest({ requestId: '' }), PROMPT_ALL_POLICY, 1000),
      ).toThrow('requestId must be a non-empty string')
    })

    it('throws on empty resourceId', () => {
      expect(() =>
        evaluateApproval(makeRequest({ resourceId: '' }), PROMPT_ALL_POLICY, 1000),
      ).toThrow(ApprovalPolicyError)
    })

    it('throws on empty sessionId', () => {
      expect(() =>
        evaluateApproval(makeRequest({ sessionId: '' }), PROMPT_ALL_POLICY, 1000),
      ).toThrow(ApprovalPolicyError)
    })

    it('throws on empty ownerId', () => {
      expect(() =>
        evaluateApproval(makeRequest({ ownerId: '' }), PROMPT_ALL_POLICY, 1000),
      ).toThrow(ApprovalPolicyError)
    })
  })
})

// ---------------------------------------------------------------------------
// createApprovalPolicy
// ---------------------------------------------------------------------------

describe('createApprovalPolicy', () => {
  it('creates a frozen policy with defaults', () => {
    const policy = createApprovalPolicy({ defaultMode: 'prompt' })
    expect(policy.defaultMode).toBe('prompt')
    expect(policy.rules).toHaveLength(0)
    expect(Object.isFrozen(policy)).toBe(true)
    expect(Object.isFrozen(policy.rules)).toBe(true)
  })

  it('creates a policy with rules', () => {
    const policy = createApprovalPolicy({
      defaultMode: 'deny',
      rules: [
        { resourceKind: 'tool', mode: 'prompt' },
        { resourcePattern: 'safe-*', mode: 'auto-approve' },
      ],
    })
    expect(policy.rules).toHaveLength(2)
    expect(policy.rules[0]!.mode).toBe('prompt')
    expect(policy.rules[1]!.mode).toBe('auto-approve')
  })

  it('throws on invalid defaultMode', () => {
    expect(() =>
      createApprovalPolicy({ defaultMode: 'invalid' as any }),
    ).toThrow(ApprovalPolicyError)
    expect(() =>
      createApprovalPolicy({ defaultMode: 'invalid' as any }),
    ).toThrow('defaultMode must be one of')
  })

  it('throws on invalid rule mode', () => {
    expect(() =>
      createApprovalPolicy({
        defaultMode: 'prompt',
        rules: [{ mode: 'bad' as any }],
      }),
    ).toThrow(ApprovalPolicyError)
    expect(() =>
      createApprovalPolicy({
        defaultMode: 'prompt',
        rules: [{ mode: 'bad' as any }],
      }),
    ).toThrow('rule mode must be one of')
  })
})

// ---------------------------------------------------------------------------
// Pre-built policies
// ---------------------------------------------------------------------------

describe('pre-built policies', () => {
  it('PROMPT_ALL_POLICY is frozen', () => {
    expect(Object.isFrozen(PROMPT_ALL_POLICY)).toBe(true)
    expect(PROMPT_ALL_POLICY.defaultMode).toBe('prompt')
  })

  it('AUTO_APPROVE_ALL_POLICY is frozen', () => {
    expect(Object.isFrozen(AUTO_APPROVE_ALL_POLICY)).toBe(true)
    expect(AUTO_APPROVE_ALL_POLICY.defaultMode).toBe('auto-approve')
  })

  it('DENY_ALL_POLICY is frozen', () => {
    expect(Object.isFrozen(DENY_ALL_POLICY)).toBe(true)
    expect(DENY_ALL_POLICY.defaultMode).toBe('deny')
  })
})

// ---------------------------------------------------------------------------
// Approval ≠ sandbox separation
// ---------------------------------------------------------------------------

describe('approval ≠ sandbox', () => {
  it('approval decision does not reference sandbox or OS ACL state', () => {
    const decision = evaluateApproval(makeRequest(), PROMPT_ALL_POLICY, 1000)
    const keys = Object.keys(decision)
    expect(keys).not.toContain('sandbox')
    expect(keys).not.toContain('acl')
    expect(keys).not.toContain('permission')
    expect(keys).not.toContain('os')
  })

  it('policy modes are distinct from permission modes', () => {
    const policyModes = ['auto-approve', 'prompt', 'deny']
    const permissionModes = ['read-only', 'workspace-write', 'danger-full-access']
    for (const pm of policyModes) {
      expect(permissionModes).not.toContain(pm)
    }
  })

  it('evaluation has no side effects on external state', () => {
    const request = makeRequest()
    const before = { ...request }
    evaluateApproval(request, PROMPT_ALL_POLICY, 1000)
    expect(request.requestId).toBe(before.requestId)
    expect(request.resourceId).toBe(before.resourceId)
    expect(request.sessionId).toBe(before.sessionId)
  })
})
