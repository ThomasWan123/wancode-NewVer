import { describe, expect, it } from 'vitest'
import {
  createLedgerEvent,
  createNotRunEvent,
  createSessionLedger,
  scrubSecrets,
  scrubMetadata,
  LedgerAppendError,
  type LedgerEvent,
} from '../src/ledger-event.ts'

// ---------------------------------------------------------------------------
// scrubSecrets
// ---------------------------------------------------------------------------

describe('scrubSecrets', () => {
  it('redacts API-key-shaped tokens', () => {
    const input = 'Authorization: Bearer sk-abc123def456ghi789jkl012mno'
    const result = scrubSecrets(input)
    expect(result).not.toContain('sk-abc123')
    expect(result).toContain('[REDACTED]')
  })

  it('redacts JWT-shaped tokens', () => {
    const jwt = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U'
    const result = scrubSecrets(`token=${jwt}`)
    expect(result).not.toContain('eyJhbGci')
    expect(result).toContain('[REDACTED]')
  })

  it('redacts GitHub personal access tokens', () => {
    const ghp = 'ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklm'
    const result = scrubSecrets(`GITHUB_TOKEN=${ghp}`)
    expect(result).not.toContain('ghp_')
    expect(result).toContain('[REDACTED]')
  })

  it('redacts Slack tokens', () => {
    const result = scrubSecrets('xoxb-123456789012-abcdefghij')
    expect(result).not.toContain('xoxb-')
    expect(result).toContain('[REDACTED]')
  })

  it('redacts AWS access key IDs', () => {
    const result = scrubSecrets('AKIAIOSFODNN7EXAMPLE')
    expect(result).not.toContain('AKIAIOSFODNN7EXAMPLE')
    expect(result).toContain('[REDACTED]')
  })

  it('leaves ordinary text untouched', () => {
    const input = 'Hello, this is a normal log message with no secrets.'
    expect(scrubSecrets(input)).toBe(input)
  })

  it('redacts multiple secrets in one string', () => {
    const input = 'key=sk-1234567890abcdef1234 token=ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklm'
    const result = scrubSecrets(input)
    expect(result).not.toContain('sk-1234')
    expect(result).not.toContain('ghp_')
  })

  it('returns empty string unchanged', () => {
    expect(scrubSecrets('')).toBe('')
  })

  it('does not mutate the input string', () => {
    const input = 'secret=sk-abc123def456ghi789jkl012mno'
    const copy = input
    scrubSecrets(input)
    expect(input).toBe(copy)
  })
})

// ---------------------------------------------------------------------------
// scrubMetadata
// ---------------------------------------------------------------------------

describe('scrubMetadata', () => {
  it('scrubs string values in a flat record', () => {
    const meta = { apiKey: 'sk-abc123def456ghi789jkl012mno', safe: 'hello' }
    const result = scrubMetadata(meta)
    expect(result.apiKey).toContain('[REDACTED]')
    expect(result.safe).toBe('hello')
    expect(Object.isFrozen(result)).toBe(true)
  })

  it('scrubs nested objects recursively', () => {
    const meta = {
      outer: {
        inner: 'token=ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklm',
      },
    }
    const result = scrubMetadata(meta)
    const outer = result.outer as Record<string, unknown>
    expect(outer.inner).toContain('[REDACTED]')
    expect(Object.isFrozen(outer)).toBe(true)
  })

  it('scrubs strings inside arrays', () => {
    const meta = { tokens: ['sk-abc123def456ghi789jkl012mno', 'safe'] }
    const result = scrubMetadata(meta)
    const tokens = result.tokens as string[]
    expect(tokens[0]).toContain('[REDACTED]')
    expect(tokens[1]).toBe('safe')
  })

  it('passes through non-string primitives', () => {
    const meta = { count: 42, active: true, empty: null }
    const result = scrubMetadata(meta)
    expect(result.count).toBe(42)
    expect(result.active).toBe(true)
    expect(result.empty).toBeNull()
  })

  it('returns a frozen record', () => {
    const result = scrubMetadata({ key: 'value' })
    expect(Object.isFrozen(result)).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// createLedgerEvent
// ---------------------------------------------------------------------------

describe('createLedgerEvent', () => {
  it('creates a frozen session.start event', () => {
    const event = createLedgerEvent({
      id: 'evt-1',
      kind: 'session.start',
      sessionId: 'sess-abc',
      timestamp: 1000,
    })
    expect(event.id).toBe('evt-1')
    expect(event.kind).toBe('session.start')
    expect(event.sessionId).toBe('sess-abc')
    expect(event.timestamp).toBe(1000)
    expect(Object.isFrozen(event)).toBe(true)
  })

  it('scrubs metadata automatically', () => {
    const event = createLedgerEvent({
      id: 'evt-2',
      kind: 'tool.invoke',
      sessionId: 'sess-abc',
      timestamp: 2000,
      metadata: { auth: 'Bearer sk-abc123def456ghi789jkl012mno' },
    })
    expect((event.metadata!.auth as string)).toContain('[REDACTED]')
  })

  it('omits undefined optional fields', () => {
    const event = createLedgerEvent({
      id: 'evt-3',
      kind: 'session.end',
      sessionId: 'sess-abc',
      timestamp: 3000,
    })
    expect('leaseId' in event).toBe(false)
    expect('profileId' in event).toBe(false)
    expect('tokensIn' in event).toBe(false)
    expect('tokensOut' in event).toBe(false)
    expect('probeOutcome' in event).toBe(false)
    expect('metadata' in event).toBe(false)
  })

  it('includes all optional fields when provided', () => {
    const event = createLedgerEvent({
      id: 'evt-4',
      kind: 'tokens.consumed',
      sessionId: 'sess-abc',
      timestamp: 4000,
      leaseId: 'lease-1',
      profileId: 'provider-1',
      tokensIn: 100,
      tokensOut: 50,
      metadata: { model: 'test' },
    })
    expect(event.leaseId).toBe('lease-1')
    expect(event.profileId).toBe('provider-1')
    expect(event.tokensIn).toBe(100)
    expect(event.tokensOut).toBe(50)
    expect(event.metadata!.model).toBe('test')
  })
})

// ---------------------------------------------------------------------------
// createNotRunEvent
// ---------------------------------------------------------------------------

describe('createNotRunEvent', () => {
  it('creates a probe.not-run event with not-run outcome', () => {
    const event = createNotRunEvent({
      id: 'probe-1',
      sessionId: 'sess-abc',
      timestamp: 1000,
    })
    expect(event.kind).toBe('probe.not-run')
    expect(event.probeOutcome).toBe('not-run')
    expect(Object.isFrozen(event)).toBe(true)
  })

  it('never records pass for a skipped probe', () => {
    const event = createNotRunEvent({
      id: 'probe-2',
      sessionId: 'sess-abc',
      timestamp: 2000,
    })
    expect(event.probeOutcome).not.toBe('pass')
    expect(event.probeOutcome).not.toBe('fail')
    expect(event.probeOutcome).toBe('not-run')
  })

  it('scrubs metadata in NOT-RUN events', () => {
    const event = createNotRunEvent({
      id: 'probe-3',
      sessionId: 'sess-abc',
      timestamp: 3000,
      metadata: { reason: 'skipped due to key=sk-abc123def456ghi789jkl012mno' },
    })
    expect((event.metadata!.reason as string)).toContain('[REDACTED]')
    expect((event.metadata!.reason as string)).not.toContain('sk-abc123')
  })
})

// ---------------------------------------------------------------------------
// createSessionLedger
// ---------------------------------------------------------------------------

describe('createSessionLedger', () => {
  function frozenEvent(overrides: Partial<LedgerEvent> & { id: string; timestamp: number }): LedgerEvent {
    return createLedgerEvent({
      kind: 'session.start',
      sessionId: 'sess-abc',
      ...overrides,
    })
  }

  it('starts empty', () => {
    const ledger = createSessionLedger()
    expect(ledger.events).toHaveLength(0)
    expect(ledger.snapshot()).toHaveLength(0)
  })

  it('appends events in order', () => {
    const ledger = createSessionLedger()
    ledger.append(frozenEvent({ id: 'a', timestamp: 1000 }))
    ledger.append(frozenEvent({ id: 'b', timestamp: 2000, kind: 'session.end' }))
    expect(ledger.events).toHaveLength(2)
    expect(ledger.events[0]!.id).toBe('a')
    expect(ledger.events[1]!.id).toBe('b')
  })

  it('allows equal timestamps (non-decreasing)', () => {
    const ledger = createSessionLedger()
    ledger.append(frozenEvent({ id: 'a', timestamp: 1000 }))
    ledger.append(frozenEvent({ id: 'b', timestamp: 1000 }))
    expect(ledger.events).toHaveLength(2)
  })

  it('rejects out-of-order timestamps', () => {
    const ledger = createSessionLedger()
    ledger.append(frozenEvent({ id: 'a', timestamp: 2000 }))
    expect(() => ledger.append(frozenEvent({ id: 'b', timestamp: 1000 }))).toThrow(LedgerAppendError)
  })

  it('rejects duplicate event ids', () => {
    const ledger = createSessionLedger()
    ledger.append(frozenEvent({ id: 'dup', timestamp: 1000 }))
    expect(() => ledger.append(frozenEvent({ id: 'dup', timestamp: 2000 }))).toThrow(LedgerAppendError)
    expect(() => ledger.append(frozenEvent({ id: 'dup', timestamp: 2000 }))).toThrow('duplicate event id')
  })

  it('rejects non-frozen events', () => {
    const ledger = createSessionLedger()
    const unfrozen = { id: 'x', kind: 'session.start' as const, sessionId: 'sess', timestamp: 1000 }
    expect(() => ledger.append(unfrozen)).toThrow(LedgerAppendError)
    expect(() => ledger.append(unfrozen)).toThrow('frozen')
  })

  it('rejects events with empty id', () => {
    const ledger = createSessionLedger()
    const event = Object.freeze({ id: '', kind: 'session.start' as const, sessionId: 'sess', timestamp: 1000 })
    expect(() => ledger.append(event)).toThrow(LedgerAppendError)
  })

  it('rejects events with non-positive timestamp', () => {
    const ledger = createSessionLedger()
    expect(() => ledger.append(frozenEvent({ id: 'a', timestamp: 0 }))).toThrow(LedgerAppendError)
    expect(() => ledger.append(frozenEvent({ id: 'b', timestamp: -1 }))).toThrow(LedgerAppendError)
  })

  it('rejects events with NaN timestamp', () => {
    const ledger = createSessionLedger()
    const event = Object.freeze({
      id: 'a', kind: 'session.start' as const, sessionId: 'sess', timestamp: NaN,
    })
    expect(() => ledger.append(event)).toThrow(LedgerAppendError)
  })

  it('snapshot returns a detached copy', () => {
    const ledger = createSessionLedger()
    ledger.append(frozenEvent({ id: 'a', timestamp: 1000 }))
    const snap = ledger.snapshot()
    ledger.append(frozenEvent({ id: 'b', timestamp: 2000 }))
    expect(snap).toHaveLength(1)
    expect(ledger.events).toHaveLength(2)
  })

  it('maintains append ordering across many events', () => {
    const ledger = createSessionLedger()
    for (let i = 0; i < 100; i++) {
      ledger.append(frozenEvent({ id: `evt-${i}`, timestamp: 1000 + i }))
    }
    expect(ledger.events).toHaveLength(100)
    for (let i = 1; i < ledger.events.length; i++) {
      expect(ledger.events[i]!.timestamp).toBeGreaterThanOrEqual(ledger.events[i - 1]!.timestamp)
    }
  })
})

// ---------------------------------------------------------------------------
// Fail-closed: scrubbing must never leave raw tokens in ledger fields
// ---------------------------------------------------------------------------

describe('fail-closed scrubbing', () => {
  const SECRETS = [
    'sk-abc123def456ghi789jkl012mno',
    'ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklm',
    'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U',
    'xoxb-123456789012-abcdefghij',
    'AKIAIOSFODNN7EXAMPLE',
    'Bearer token_abcdef1234567890abcdef',
    'api-key-abcdef1234567890abcdef',
    'secret_abcdef1234567890abcdef',
    'password_abcdef1234567890abcdef',
  ]

  for (const secret of SECRETS) {
    it(`never leaves raw secret in metadata: ${secret.slice(0, 20)}…`, () => {
      const event = createLedgerEvent({
        id: 'sec-test',
        kind: 'tool.invoke',
        sessionId: 'sess',
        timestamp: 1000,
        metadata: {
          header: `Authorization: ${secret}`,
          nested: { token: secret },
          list: [secret, 'safe'],
        },
      })
      const json = JSON.stringify(event)
      expect(json).not.toContain(secret)
    })
  }

  it('scrubs secrets in NOT-RUN event metadata', () => {
    const event = createNotRunEvent({
      id: 'nr-sec',
      sessionId: 'sess',
      timestamp: 1000,
      metadata: { reason: 'key was sk-abc123def456ghi789jkl012mno' },
    })
    const json = JSON.stringify(event)
    expect(json).not.toContain('sk-abc123')
  })
})
