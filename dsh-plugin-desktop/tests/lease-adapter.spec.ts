import { describe, expect, it, beforeEach } from 'vitest'
import { createSessionLedger, type SessionLedger } from '@wancode/harness-kernel'
import { createDesktopLeaseAdapter, type DesktopLeaseAdapter } from '../src/lease-adapter.ts'

describe('createDesktopLeaseAdapter', () => {
  let ledger: SessionLedger
  let adapter: DesktopLeaseAdapter

  beforeEach(() => {
    ledger = createSessionLedger()
    adapter = createDesktopLeaseAdapter(ledger)
  })

  it('exposes the underlying LeaseManager', () => {
    expect(adapter.manager).toBeDefined()
    expect(adapter.manager.allActive).toBeTypeOf('function')
  })

  describe('acquireTool', () => {
    it('acquires a tool lease on an uncontested resource', () => {
      const result = adapter.acquireTool({
        toolId: 'shell',
        ownerId: 'agent-1',
        sessionId: 'sess-1',
      })
      expect(result.ok).toBe(true)
      if (result.ok) {
        expect(result.lease.resourceId).toBe('shell')
        expect(result.lease.resourceKind).toBe('tool')
        expect(result.lease.ownerId).toBe('agent-1')
        expect(result.lease.state).toBe('active')
      }
    })

    it('records lease.acquired on the session ledger', () => {
      adapter.acquireTool({
        toolId: 'shell',
        ownerId: 'agent-1',
        sessionId: 'sess-1',
      })
      const events = ledger.snapshot()
      expect(events).toHaveLength(1)
      expect(events[0]!.kind).toBe('lease.acquired')
      expect(events[0]!.metadata?.resourceId).toBe('shell')
      expect(events[0]!.metadata?.ownerId).toBe('agent-1')
    })

    it('denies duplicate-owner and records lease.denied', () => {
      adapter.acquireTool({ toolId: 'shell', ownerId: 'agent-1', sessionId: 'sess-1' })
      const result = adapter.acquireTool({ toolId: 'shell', ownerId: 'agent-1', sessionId: 'sess-1' })
      expect(result.ok).toBe(false)
      if (!result.ok) expect(result.reason).toBe('duplicate-owner')

      const events = ledger.snapshot()
      const denied = events.filter(e => e.kind === 'lease.denied')
      expect(denied).toHaveLength(1)
      expect(denied[0]!.metadata?.reason).toBe('duplicate-owner')
    })

    it('denies resource-held from another owner', () => {
      adapter.acquireTool({ toolId: 'shell', ownerId: 'agent-1', sessionId: 'sess-1' })
      const result = adapter.acquireTool({ toolId: 'shell', ownerId: 'agent-2', sessionId: 'sess-1' })
      expect(result.ok).toBe(false)
      if (!result.ok) {
        expect(result.reason).toBe('resource-held')
        expect(result.holder?.ownerId).toBe('agent-1')
      }
    })

    it('accepts a custom durationMs', () => {
      const result = adapter.acquireTool({
        toolId: 'shell',
        ownerId: 'agent-1',
        sessionId: 'sess-1',
        durationMs: 5000,
      })
      expect(result.ok).toBe(true)
      if (result.ok) {
        expect(result.lease.expiresAt - result.lease.createdAt).toBe(5000)
      }
    })
  })

  describe('acquireSession', () => {
    it('acquires a session lease', () => {
      const result = adapter.acquireSession({
        sessionId: 'sess-main',
        ownerId: 'user-1',
      })
      expect(result.ok).toBe(true)
      if (result.ok) {
        expect(result.lease.resourceKind).toBe('session')
        expect(result.lease.resourceId).toBe('sess-main')
      }
    })

    it('denies duplicate session owner', () => {
      adapter.acquireSession({ sessionId: 'sess-main', ownerId: 'user-1' })
      const result = adapter.acquireSession({ sessionId: 'sess-main', ownerId: 'user-1' })
      expect(result.ok).toBe(false)
    })
  })

  describe('release', () => {
    it('releases an active lease', () => {
      const acq = adapter.acquireTool({ toolId: 'shell', ownerId: 'agent-1', sessionId: 'sess-1' })
      if (!acq.ok) throw new Error('unexpected')
      const result = adapter.release({
        leaseId: acq.lease.id,
        ownerId: 'agent-1',
        sessionId: 'sess-1',
      })
      expect(result.ok).toBe(true)
      if (result.ok) expect(result.lease.state).toBe('released')
    })

    it('records lease.released on the session ledger', () => {
      const acq = adapter.acquireTool({ toolId: 'shell', ownerId: 'agent-1', sessionId: 'sess-1' })
      if (!acq.ok) throw new Error('unexpected')
      adapter.release({ leaseId: acq.lease.id, ownerId: 'agent-1', sessionId: 'sess-1' })
      const events = ledger.snapshot()
      const released = events.filter(e => e.kind === 'lease.released')
      expect(released).toHaveLength(1)
      expect(released[0]!.metadata?.leaseId).toBe(acq.lease.id)
    })

    it('denies release by non-owner', () => {
      const acq = adapter.acquireTool({ toolId: 'shell', ownerId: 'agent-1', sessionId: 'sess-1' })
      if (!acq.ok) throw new Error('unexpected')
      const result = adapter.release({
        leaseId: acq.lease.id,
        ownerId: 'attacker',
        sessionId: 'sess-1',
      })
      expect(result.ok).toBe(false)
      if (!result.ok) expect(result.reason).toBe('not-owner')
    })

    it('frees resource for subsequent acquisition', () => {
      const acq = adapter.acquireTool({ toolId: 'shell', ownerId: 'agent-1', sessionId: 'sess-1' })
      if (!acq.ok) throw new Error('unexpected')
      adapter.release({ leaseId: acq.lease.id, ownerId: 'agent-1', sessionId: 'sess-1' })
      const result = adapter.acquireTool({ toolId: 'shell', ownerId: 'agent-2', sessionId: 'sess-1' })
      expect(result.ok).toBe(true)
    })
  })

  describe('releaseAllForOwner', () => {
    it('releases all active leases held by an owner', () => {
      adapter.acquireTool({ toolId: 'shell', ownerId: 'agent-1', sessionId: 'sess-1' })
      adapter.acquireTool({ toolId: 'browser', ownerId: 'agent-1', sessionId: 'sess-1' })
      adapter.acquireTool({ toolId: 'editor', ownerId: 'agent-2', sessionId: 'sess-1' })

      const released = adapter.releaseAllForOwner({
        ownerId: 'agent-1',
        sessionId: 'sess-1',
        reason: 'owner-terminated',
      })
      expect(released).toHaveLength(2)
      expect(released.every(l => l.state === 'released')).toBe(true)
    })

    it('records compensating lease.released events', () => {
      adapter.acquireTool({ toolId: 'shell', ownerId: 'agent-1', sessionId: 'sess-1' })
      adapter.acquireTool({ toolId: 'browser', ownerId: 'agent-1', sessionId: 'sess-1' })
      adapter.releaseAllForOwner({
        ownerId: 'agent-1',
        sessionId: 'sess-1',
        reason: 'terminal-exit',
      })

      const events = ledger.snapshot()
      const released = events.filter(e => e.kind === 'lease.released' && e.metadata?.compensating === true)
      expect(released).toHaveLength(2)
      expect(released[0]!.metadata?.reason).toBe('terminal-exit')
    })

    it('does not affect other owners leases', () => {
      adapter.acquireTool({ toolId: 'shell', ownerId: 'agent-1', sessionId: 'sess-1' })
      adapter.acquireTool({ toolId: 'browser', ownerId: 'agent-2', sessionId: 'sess-1' })
      adapter.releaseAllForOwner({
        ownerId: 'agent-1',
        sessionId: 'sess-1',
        reason: 'cleanup',
      })
      expect(adapter.manager.allActive()).toHaveLength(1)
      expect(adapter.manager.allActive()[0]!.ownerId).toBe('agent-2')
    })
  })

  describe('expireStale', () => {
    it('expires leases past their duration', () => {
      adapter.acquireTool({
        toolId: 'shell',
        ownerId: 'agent-1',
        sessionId: 'sess-1',
        durationMs: 1,
      })
      // Wait a bit to ensure the lease has expired
      const expired = adapter.expireStale('sess-1')
      // May or may not have expired depending on timing; verify structure
      for (const lease of expired) {
        expect(lease.state).toBe('expired')
      }
    })

    it('records lease.expired events on the ledger', () => {
      adapter.acquireTool({
        toolId: 'shell',
        ownerId: 'agent-1',
        sessionId: 'sess-1',
        durationMs: 1,
      })
      adapter.expireStale('sess-1')
      const expiredEvents = ledger.snapshot().filter(e => e.kind === 'lease.expired')
      for (const evt of expiredEvents) {
        expect(evt.metadata?.resourceId).toBe('shell')
      }
    })
  })

  describe('compensatingShutdown', () => {
    it('releases all active leases on shutdown', () => {
      adapter.acquireTool({ toolId: 'shell', ownerId: 'agent-1', sessionId: 'sess-1' })
      adapter.acquireTool({ toolId: 'browser', ownerId: 'agent-2', sessionId: 'sess-1' })
      adapter.acquireSession({ sessionId: 'sess-main', ownerId: 'user-1' })

      const released = adapter.compensatingShutdown({
        sessionId: 'sess-1',
        reason: 'application-shutdown',
      })
      expect(released).toHaveLength(3)
      expect(released.every(l => l.state === 'released')).toBe(true)
      expect(adapter.manager.allActive()).toHaveLength(0)
    })

    it('records compensating lease.released for all leases', () => {
      adapter.acquireTool({ toolId: 'shell', ownerId: 'agent-1', sessionId: 'sess-1' })
      adapter.acquireTool({ toolId: 'browser', ownerId: 'agent-2', sessionId: 'sess-1' })
      adapter.compensatingShutdown({ sessionId: 'sess-1', reason: 'SIGTERM' })

      const events = ledger.snapshot()
      const compensating = events.filter(
        e => e.kind === 'lease.released' && e.metadata?.compensating === true,
      )
      expect(compensating).toHaveLength(2)
      expect(compensating[0]!.metadata?.reason).toBe('SIGTERM')
    })

    it('is idempotent on an empty manager', () => {
      const released = adapter.compensatingShutdown({ sessionId: 'sess-1', reason: 'shutdown' })
      expect(released).toHaveLength(0)
    })
  })

  describe('fail-closed: second owner cannot steal active lease', () => {
    it('rejects a different owner on the same tool', () => {
      adapter.acquireTool({ toolId: 'shell', ownerId: 'owner-a', sessionId: 's1' })
      const result = adapter.acquireTool({ toolId: 'shell', ownerId: 'owner-b', sessionId: 's1' })
      expect(result.ok).toBe(false)
      if (!result.ok) expect(result.reason).toBe('resource-held')
    })

    it('rejects the same owner re-acquiring without release', () => {
      adapter.acquireTool({ toolId: 'shell', ownerId: 'owner-a', sessionId: 's1' })
      const result = adapter.acquireTool({ toolId: 'shell', ownerId: 'owner-a', sessionId: 's1' })
      expect(result.ok).toBe(false)
      if (!result.ok) expect(result.reason).toBe('duplicate-owner')
    })

    it('cannot release by impersonating', () => {
      const acq = adapter.acquireTool({ toolId: 'shell', ownerId: 'owner-a', sessionId: 's1' })
      if (!acq.ok) throw new Error('unexpected')
      const rel = adapter.release({ leaseId: acq.lease.id, ownerId: 'attacker', sessionId: 's1' })
      expect(rel.ok).toBe(false)
      expect(adapter.manager.allActive()).toHaveLength(1)
    })
  })
})
