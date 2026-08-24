/**
 * Append-only session ledger for the harness kernel.
 *
 * Events are immutable, ordered, and scrubbed of secrets before storage.
 * Skipped probes record NOT-RUN rather than success to prevent false
 * assurance in audit trails.
 */

// ---------------------------------------------------------------------------
// Event kinds
// ---------------------------------------------------------------------------

export type LedgerEventKind =
  | 'session.start'
  | 'session.end'
  | 'integrity.pass'
  | 'integrity.reject'
  | 'tool.invoke'
  | 'tool.result'
  | 'approval.request'
  | 'approval.grant'
  | 'approval.deny'
  | 'probe.not-run'
  | 'lease.acquired'
  | 'lease.released'
  | 'lease.denied'
  | 'lease.expired'
  | 'tokens.consumed'
  | 'tokens.refunded'

// ---------------------------------------------------------------------------
// Probe outcome — NOT-RUN vs explicit pass/fail
// ---------------------------------------------------------------------------

export type ProbeOutcome = 'pass' | 'fail' | 'not-run'

// ---------------------------------------------------------------------------
// Core ledger event
// ---------------------------------------------------------------------------

export interface LedgerEvent {
  readonly id: string
  readonly kind: LedgerEventKind
  readonly sessionId: string
  readonly timestamp: number
  readonly leaseId?: string
  readonly profileId?: string
  readonly tokensIn?: number
  readonly tokensOut?: number
  readonly probeOutcome?: ProbeOutcome
  readonly metadata?: Readonly<Record<string, unknown>>
}

// ---------------------------------------------------------------------------
// Secret scrubbing
// ---------------------------------------------------------------------------

const SECRET_PATTERNS: readonly RegExp[] = [
  /\b(?:sk|pk|api|token|key|secret|password|bearer|auth)[-_]?[A-Za-z0-9]{16,}\b/gi,
  /\beyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g,
  /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{36,}\b/g,
  /\b(?:xox[bpras])-[A-Za-z0-9-]{10,}\b/g,
  /\bAKIA[A-Z0-9]{16}\b/g,
  /\b[A-Za-z0-9+/]{40,}={0,2}\b/g,
]

const REDACTED = '[REDACTED]'

/**
 * Scrub secret-shaped tokens from a single string value.
 * Returns the scrubbed string. Never mutates the input.
 */
export function scrubSecrets(value: string): string {
  let result = value
  for (const pattern of SECRET_PATTERNS) {
    pattern.lastIndex = 0
    result = result.replace(pattern, REDACTED)
  }
  return result
}

/**
 * Deep-scrub all string values inside a metadata record.
 * Returns a new frozen record. Non-string leaves pass through.
 */
export function scrubMetadata(
  metadata: Readonly<Record<string, unknown>>,
): Readonly<Record<string, unknown>> {
  const result: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(metadata)) {
    result[key] = scrubValue(value)
  }
  return Object.freeze(result)
}

function scrubValue(value: unknown): unknown {
  if (typeof value === 'string') return scrubSecrets(value)
  if (Array.isArray(value)) return Object.freeze(value.map(scrubValue))
  if (value !== null && typeof value === 'object') {
    return scrubMetadata(value as Record<string, unknown>)
  }
  return value
}

// ---------------------------------------------------------------------------
// Append-only ledger
// ---------------------------------------------------------------------------

/**
 * Create a ledger event with scrubbed metadata.
 * The returned event is frozen and safe for append-only storage.
 */
export function createLedgerEvent(input: {
  readonly id: string
  readonly kind: LedgerEventKind
  readonly sessionId: string
  readonly timestamp: number
  readonly leaseId?: string
  readonly profileId?: string
  readonly tokensIn?: number
  readonly tokensOut?: number
  readonly probeOutcome?: ProbeOutcome
  readonly metadata?: Readonly<Record<string, unknown>>
}): LedgerEvent {
  const base: Record<string, unknown> = {
    id: input.id,
    kind: input.kind,
    sessionId: input.sessionId,
    timestamp: input.timestamp,
  }
  if (input.leaseId !== undefined) base.leaseId = input.leaseId
  if (input.profileId !== undefined) base.profileId = input.profileId
  if (input.tokensIn !== undefined) base.tokensIn = input.tokensIn
  if (input.tokensOut !== undefined) base.tokensOut = input.tokensOut
  if (input.probeOutcome !== undefined) base.probeOutcome = input.probeOutcome
  if (input.metadata !== undefined) base.metadata = scrubMetadata(input.metadata)
  return Object.freeze(base) as unknown as LedgerEvent
}

/**
 * Mark a skipped probe as NOT-RUN. This must never record "pass" for a
 * probe that did not actually execute.
 */
export function createNotRunEvent(input: {
  readonly id: string
  readonly sessionId: string
  readonly timestamp: number
  readonly metadata?: Readonly<Record<string, unknown>>
}): LedgerEvent {
  return createLedgerEvent({
    ...input,
    kind: 'probe.not-run',
    probeOutcome: 'not-run',
  })
}

/**
 * Append-only in-memory ledger. Events are validated for ordering
 * (monotonic timestamps) and immutability before acceptance.
 */
export interface SessionLedger {
  readonly events: readonly LedgerEvent[]
  append(event: LedgerEvent): void
  snapshot(): readonly LedgerEvent[]
}

/**
 * Create an in-memory append-only session ledger.
 *
 * Enforces:
 * - Monotonically non-decreasing timestamps
 * - No duplicate event ids
 * - Frozen events only
 */
export function createSessionLedger(): SessionLedger {
  const events: LedgerEvent[] = []
  const seenIds = new Set<string>()

  return {
    get events(): readonly LedgerEvent[] {
      return events
    },

    append(event: LedgerEvent): void {
      if (!Object.isFrozen(event)) {
        throw new LedgerAppendError('event must be frozen')
      }
      if (typeof event.id !== 'string' || event.id.length === 0) {
        throw new LedgerAppendError('event id must be a non-empty string')
      }
      if (seenIds.has(event.id)) {
        throw new LedgerAppendError(`duplicate event id: ${event.id}`)
      }
      if (typeof event.timestamp !== 'number' || !Number.isFinite(event.timestamp) || event.timestamp <= 0) {
        throw new LedgerAppendError('event timestamp must be a positive finite number')
      }
      const lastTimestamp = events.length > 0 ? events[events.length - 1]!.timestamp : 0
      if (event.timestamp < lastTimestamp) {
        throw new LedgerAppendError(
          `event timestamp ${event.timestamp} is before last event ${lastTimestamp}`,
        )
      }
      seenIds.add(event.id)
      events.push(event)
    },

    snapshot(): readonly LedgerEvent[] {
      return [...events]
    },
  }
}

/** Structured error thrown when an event cannot be appended. */
export class LedgerAppendError extends Error {
  constructor(message: string) {
    super(`Ledger append failed: ${message}`)
    this.name = 'LedgerAppendError'
  }
}
