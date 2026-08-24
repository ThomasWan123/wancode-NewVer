import { describe, expect, it } from 'vitest'
import {
  createDesktopSessionLedger,
  observeIntegrityGate,
} from '../src/session-ledger.ts'

describe('createDesktopSessionLedger', () => {
  it('starts with an empty ledger', () => {
    const adapter = createDesktopSessionLedger()
    expect(adapter.snapshot()).toHaveLength(0)
    expect(adapter.ledger.events).toHaveLength(0)
  })

  it('records session.start events', () => {
    const adapter = createDesktopSessionLedger()
    const event = adapter.recordSessionStart('sess-1', { profile: 'default' })
    expect(event.kind).toBe('session.start')
    expect(event.sessionId).toBe('sess-1')
    expect(event.metadata?.profile).toBe('default')
    expect(Object.isFrozen(event)).toBe(true)
    expect(adapter.snapshot()).toHaveLength(1)
  })

  it('records session.end events', () => {
    const adapter = createDesktopSessionLedger()
    adapter.recordSessionStart('sess-1')
    const event = adapter.recordSessionEnd('sess-1', { reason: 'user-quit' })
    expect(event.kind).toBe('session.end')
    expect(adapter.snapshot()).toHaveLength(2)
  })

  it('records integrity.pass events', () => {
    const adapter = createDesktopSessionLedger()
    adapter.recordSessionStart('sess-1')
    const event = adapter.recordIntegrityPass('sess-1')
    expect(event.kind).toBe('integrity.pass')
    expect(adapter.snapshot()).toHaveLength(2)
  })

  it('records integrity.reject events', () => {
    const adapter = createDesktopSessionLedger()
    adapter.recordSessionStart('sess-1')
    const event = adapter.recordIntegrityReject('sess-1', {
      error: 'invalid prompt',
    })
    expect(event.kind).toBe('integrity.reject')
    expect(event.metadata?.error).toBe('invalid prompt')
  })

  it('records tool.invoke events', () => {
    const adapter = createDesktopSessionLedger()
    adapter.recordSessionStart('sess-1')
    const event = adapter.recordToolInvoke('sess-1', { tool: 'shell' })
    expect(event.kind).toBe('tool.invoke')
    expect(event.metadata?.tool).toBe('shell')
  })

  it('records tool.result events', () => {
    const adapter = createDesktopSessionLedger()
    adapter.recordSessionStart('sess-1')
    const event = adapter.recordToolResult('sess-1', { exitCode: 0 })
    expect(event.kind).toBe('tool.result')
  })

  it('records approval.request events', () => {
    const adapter = createDesktopSessionLedger()
    adapter.recordSessionStart('sess-1')
    const event = adapter.recordApprovalRequest('sess-1', { requestId: 'req-1' })
    expect(event.kind).toBe('approval.request')
  })

  it('records approval.grant events', () => {
    const adapter = createDesktopSessionLedger()
    adapter.recordSessionStart('sess-1')
    const event = adapter.recordApprovalGrant('sess-1', { requestId: 'req-1' })
    expect(event.kind).toBe('approval.grant')
  })

  it('records approval.deny events', () => {
    const adapter = createDesktopSessionLedger()
    adapter.recordSessionStart('sess-1')
    const event = adapter.recordApprovalDeny('sess-1', { requestId: 'req-1' })
    expect(event.kind).toBe('approval.deny')
  })

  it('records probe.not-run events with NOT-RUN outcome', () => {
    const adapter = createDesktopSessionLedger()
    adapter.recordSessionStart('sess-1')
    const event = adapter.recordNotRun('sess-1', { probe: 'checksum-verification' })
    expect(event.kind).toBe('probe.not-run')
    expect(event.probeOutcome).toBe('not-run')
    expect(event.probeOutcome).not.toBe('pass')
  })

  it('scrubs secrets from event metadata automatically', () => {
    const adapter = createDesktopSessionLedger()
    const event = adapter.recordSessionStart('sess-1', {
      auth: 'Bearer sk-abc123def456ghi789jkl012mno',
    })
    expect(event.metadata?.auth as string).toContain('[REDACTED]')
    expect(event.metadata?.auth as string).not.toContain('sk-abc123')
  })

  it('scrubs secrets from NOT-RUN event metadata', () => {
    const adapter = createDesktopSessionLedger()
    adapter.recordSessionStart('sess-1')
    const event = adapter.recordNotRun('sess-1', {
      reason: 'token expired ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklm',
    })
    const json = JSON.stringify(event)
    expect(json).not.toContain('ghp_')
  })

  it('preserves append ordering across mixed event types', () => {
    const adapter = createDesktopSessionLedger()
    adapter.recordSessionStart('sess-1')
    adapter.recordIntegrityPass('sess-1')
    adapter.recordToolInvoke('sess-1')
    adapter.recordApprovalRequest('sess-1')
    adapter.recordApprovalGrant('sess-1')
    adapter.recordToolResult('sess-1')
    adapter.recordNotRun('sess-1')
    adapter.recordSessionEnd('sess-1')

    const events = adapter.snapshot()
    expect(events).toHaveLength(8)
    expect(events[0]!.kind).toBe('session.start')
    expect(events[1]!.kind).toBe('integrity.pass')
    expect(events[2]!.kind).toBe('tool.invoke')
    expect(events[3]!.kind).toBe('approval.request')
    expect(events[4]!.kind).toBe('approval.grant')
    expect(events[5]!.kind).toBe('tool.result')
    expect(events[6]!.kind).toBe('probe.not-run')
    expect(events[7]!.kind).toBe('session.end')

    for (let i = 1; i < events.length; i++) {
      expect(events[i]!.timestamp).toBeGreaterThanOrEqual(events[i - 1]!.timestamp)
    }
  })

  it('generates unique event ids', () => {
    const adapter = createDesktopSessionLedger()
    const ids = new Set<string>()
    for (let i = 0; i < 50; i++) {
      const event = adapter.recordSessionStart(`sess-${i}`)
      ids.add(event.id)
    }
    expect(ids.size).toBe(50)
  })

  it('snapshot is detached from live ledger', () => {
    const adapter = createDesktopSessionLedger()
    adapter.recordSessionStart('sess-1')
    const snap = adapter.snapshot()
    adapter.recordSessionEnd('sess-1')
    expect(snap).toHaveLength(1)
    expect(adapter.snapshot()).toHaveLength(2)
  })
})

describe('observeIntegrityGate', () => {
  it('records integrity.pass on successful gate', () => {
    const adapter = createDesktopSessionLedger()
    adapter.recordSessionStart('sess-1')
    const gate = <T>(value: unknown): T => value as T
    const observed = observeIntegrityGate({
      sessionLedger: adapter,
      sessionId: 'sess-1',
      gate,
    })
    const result = observed({ ok: true })
    expect(result).toEqual({ ok: true })
    const events = adapter.snapshot()
    expect(events).toHaveLength(2)
    expect(events[1]!.kind).toBe('integrity.pass')
  })

  it('records integrity.reject on gate failure and rethrows', () => {
    const adapter = createDesktopSessionLedger()
    adapter.recordSessionStart('sess-1')
    const gate = <T>(_value: unknown): T => {
      throw new Error('validation failed')
    }
    const observed = observeIntegrityGate({
      sessionLedger: adapter,
      sessionId: 'sess-1',
      gate,
    })
    expect(() => observed(null)).toThrow('validation failed')
    const events = adapter.snapshot()
    expect(events).toHaveLength(2)
    expect(events[1]!.kind).toBe('integrity.reject')
    expect(events[1]!.metadata?.error).toBe('validation failed')
  })

  it('does not swallow the original error', () => {
    const adapter = createDesktopSessionLedger()
    adapter.recordSessionStart('sess-1')
    const gate = <T>(_value: unknown): T => {
      throw new TypeError('type mismatch')
    }
    const observed = observeIntegrityGate({
      sessionLedger: adapter,
      sessionId: 'sess-1',
      gate,
    })
    expect(() => observed(42)).toThrow(TypeError)
  })

  it('scrubs secrets from error messages', () => {
    const adapter = createDesktopSessionLedger()
    adapter.recordSessionStart('sess-1')
    const gate = <T>(_value: unknown): T => {
      throw new Error('bad token sk-abc123def456ghi789jkl012mno')
    }
    const observed = observeIntegrityGate({
      sessionLedger: adapter,
      sessionId: 'sess-1',
      gate,
    })
    try { observed(null) } catch { /* expected */ }
    const events = adapter.snapshot()
    const meta = events[1]!.metadata!
    expect(meta.error as string).toContain('[REDACTED]')
    expect(meta.error as string).not.toContain('sk-abc123')
  })
})

describe('fail-closed scrubbing in desktop ledger', () => {
  const SECRETS = [
    'sk-abc123def456ghi789jkl012mno',
    'ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklm',
    'xoxb-123456789012-abcdefghij',
    'AKIAIOSFODNN7EXAMPLE',
    'Bearer token_abcdef1234567890abcdef',
  ]

  for (const secret of SECRETS) {
    it(`never leaves raw secret in any recorded event: ${secret.slice(0, 20)}…`, () => {
      const adapter = createDesktopSessionLedger()
      adapter.recordSessionStart('sess-1', {
        auth: `header ${secret}`,
        nested: { key: secret },
      })
      adapter.recordToolInvoke('sess-1', { token: secret })
      adapter.recordNotRun('sess-1', { reason: secret })

      for (const event of adapter.snapshot()) {
        const json = JSON.stringify(event)
        expect(json).not.toContain(secret)
      }
    })
  }
})
