/**
 * Approval policy evaluation for the harness kernel.
 *
 * Approval decisions are independent of sandbox/OS ACL policy.
 * A sandbox may restrict what a process *can* do at the OS level;
 * an approval policy controls what a tool invocation *may* do at
 * the user-consent level. The two axes are orthogonal.
 *
 * The evaluator is pure: no timers, no platform deps, no Cordis
 * dependency. It receives a request and a policy and returns a
 * frozen decision.
 */

// ---------------------------------------------------------------------------
// Approval policy modes
// ---------------------------------------------------------------------------

/**
 * The three policy modes supported by the approval system:
 *
 * - `auto-approve`: tool use proceeds without user interaction.
 * - `prompt`: the host must present an approval request to the user.
 * - `deny`: tool use is rejected without prompting.
 */
export type ApprovalPolicyMode = 'auto-approve' | 'prompt' | 'deny'

// ---------------------------------------------------------------------------
// Approval resource scopes
// ---------------------------------------------------------------------------

/**
 * The kind of resource being approved. Mirrors LeaseResourceKind
 * for cross-referencing but is intentionally a separate union so
 * the approval contract does not depend on the lease contract.
 */
export type ApprovalResourceKind = 'tool' | 'session' | 'subagent'

// ---------------------------------------------------------------------------
// Approval request
// ---------------------------------------------------------------------------

export interface ApprovalRequest {
  readonly requestId: string
  readonly resourceId: string
  readonly resourceKind: ApprovalResourceKind
  readonly sessionId: string
  readonly ownerId: string
  readonly leaseId?: string
  readonly metadata?: Readonly<Record<string, unknown>>
}

// ---------------------------------------------------------------------------
// Approval decision
// ---------------------------------------------------------------------------

export type ApprovalDecisionOutcome = 'approved' | 'prompted' | 'denied'

export interface ApprovalDecision {
  readonly requestId: string
  readonly outcome: ApprovalDecisionOutcome
  readonly policyMode: ApprovalPolicyMode
  readonly resourceId: string
  readonly resourceKind: ApprovalResourceKind
  readonly sessionId: string
  readonly timestamp: number
}

// ---------------------------------------------------------------------------
// Approval policy
// ---------------------------------------------------------------------------

export interface ApprovalPolicyRule {
  readonly resourceKind?: ApprovalResourceKind
  readonly resourcePattern?: string
  readonly mode: ApprovalPolicyMode
}

export interface ApprovalPolicy {
  readonly defaultMode: ApprovalPolicyMode
  readonly rules: readonly ApprovalPolicyRule[]
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export class ApprovalPolicyError extends Error {
  constructor(message: string) {
    super(`Approval policy error: ${message}`)
    this.name = 'ApprovalPolicyError'
  }
}

// ---------------------------------------------------------------------------
// Policy evaluation
// ---------------------------------------------------------------------------

/**
 * Match a resource identifier against a simple glob pattern.
 * Supports `*` (any characters) and literal prefix matching.
 */
function matchResourcePattern(pattern: string, resourceId: string): boolean {
  if (pattern === '*') return true
  if (!pattern.includes('*')) return pattern === resourceId
  const regex = new RegExp(
    `^${pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')}$`,
  )
  return regex.test(resourceId)
}

/**
 * Find the first matching rule for a request. Rules are evaluated
 * in declaration order; the first match wins.
 */
function findMatchingRule(
  policy: ApprovalPolicy,
  request: ApprovalRequest,
): ApprovalPolicyRule | undefined {
  for (const rule of policy.rules) {
    if (rule.resourceKind !== undefined && rule.resourceKind !== request.resourceKind) {
      continue
    }
    if (rule.resourcePattern !== undefined && !matchResourcePattern(rule.resourcePattern, request.resourceId)) {
      continue
    }
    return rule
  }
  return undefined
}

/**
 * Evaluate an approval request against a policy.
 *
 * Returns a frozen `ApprovalDecision` with the outcome:
 * - `approved` when the matching policy mode is `auto-approve`
 * - `prompted` when the matching policy mode is `prompt`
 * - `denied` when the matching policy mode is `deny`
 *
 * Fail-closed: if the request is malformed the evaluator throws
 * rather than silently approving.
 */
export function evaluateApproval(
  request: ApprovalRequest,
  policy: ApprovalPolicy,
  now: number = Date.now(),
): ApprovalDecision {
  if (!request.requestId || typeof request.requestId !== 'string') {
    throw new ApprovalPolicyError('requestId must be a non-empty string')
  }
  if (!request.resourceId || typeof request.resourceId !== 'string') {
    throw new ApprovalPolicyError('resourceId must be a non-empty string')
  }
  if (!request.sessionId || typeof request.sessionId !== 'string') {
    throw new ApprovalPolicyError('sessionId must be a non-empty string')
  }
  if (!request.ownerId || typeof request.ownerId !== 'string') {
    throw new ApprovalPolicyError('ownerId must be a non-empty string')
  }

  const matchedRule = findMatchingRule(policy, request)
  const mode = matchedRule?.mode ?? policy.defaultMode

  const outcomeMap: Record<ApprovalPolicyMode, ApprovalDecisionOutcome> = {
    'auto-approve': 'approved',
    'prompt': 'prompted',
    'deny': 'denied',
  }

  return Object.freeze({
    requestId: request.requestId,
    outcome: outcomeMap[mode],
    policyMode: mode,
    resourceId: request.resourceId,
    resourceKind: request.resourceKind,
    sessionId: request.sessionId,
    timestamp: now,
  })
}

// ---------------------------------------------------------------------------
// Default policies
// ---------------------------------------------------------------------------

/** A policy that prompts for all tool use. Safe default. */
export const PROMPT_ALL_POLICY: ApprovalPolicy = Object.freeze({
  defaultMode: 'prompt' as const,
  rules: Object.freeze([]) as readonly ApprovalPolicyRule[],
})

/** A policy that auto-approves everything. For trusted/danger-full-access. */
export const AUTO_APPROVE_ALL_POLICY: ApprovalPolicy = Object.freeze({
  defaultMode: 'auto-approve' as const,
  rules: Object.freeze([]) as readonly ApprovalPolicyRule[],
})

/** A policy that denies everything. For locked-down environments. */
export const DENY_ALL_POLICY: ApprovalPolicy = Object.freeze({
  defaultMode: 'deny' as const,
  rules: Object.freeze([]) as readonly ApprovalPolicyRule[],
})

// ---------------------------------------------------------------------------
// Policy construction helpers
// ---------------------------------------------------------------------------

/**
 * Create an approval policy from a default mode and optional rules.
 * Validates inputs and returns a frozen policy.
 */
export function createApprovalPolicy(input: {
  readonly defaultMode: ApprovalPolicyMode
  readonly rules?: readonly ApprovalPolicyRule[]
}): ApprovalPolicy {
  const validModes: readonly string[] = ['auto-approve', 'prompt', 'deny']
  if (!validModes.includes(input.defaultMode)) {
    throw new ApprovalPolicyError(
      `defaultMode must be one of: ${validModes.join(', ')}`,
    )
  }
  const rules = input.rules ?? []
  for (const rule of rules) {
    if (!validModes.includes(rule.mode)) {
      throw new ApprovalPolicyError(
        `rule mode must be one of: ${validModes.join(', ')}`,
      )
    }
  }
  return Object.freeze({
    defaultMode: input.defaultMode,
    rules: Object.freeze([...rules]),
  })
}
