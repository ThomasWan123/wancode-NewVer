import { describe, expect, it } from 'vitest'
import {
  createLeaseManager,
  LeaseError,
  type LeaseAcquireRequest,
  type LeaseManager,
} from '../src/lease.ts'

function makeRequest(overrides: Partial<LeaseAcquireRequest> = {}): LeaseAcquireRequest {
  return {
    id: overrides.id ?? 'lease-1',
    resourceId: overrides.resourceId ?? 'tool-shell',
    resourceKind: overrides.resourceKind ?? 'tool',
    ownerId: overrides.ownerId ?? 'owner-a',
    durationMs: overrides.durationMs ?? 30_000,
    now: overrides.now ?? 1000,
  }
}

describe('createLeaseManager', () => {
  it('returns a LeaseManager', () => {
    const mgr = createLeaseManager()
    expect(mgr.acquire).toBeTypeOf('function')
    expect(mgr.release).toBeTypeOf('function')
    expect(mgr.expireAll).toBeTypeOf('function')
    expect(mgr.get).toBeTypeOf('function')
    expect(mgr.activeForResource).toBeTypeOf('function')
    expect(mgr.allActive).toBeTypeOf('function')
    expect(mgr.allHeldBy).toBeTypeOf('function')
  })

  it('starts with no active leases', () => {
    const mgr = createLeaseManager()
    expect(mgr.allActive()).toHaveLength(0)
  })
})

describe('LeaseManager.acquire', () => {
  it('grants a lease on an uncontested resource', () => {
    const mgr = createLeaseManager()
    const result = mgr.acquire(makeRequest())
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.lease.id).toBe('lease-1')
      expect(result.lease.resourceId).toBe('tool-shell')
      expect(result.lease.resourceKind).toBe('tool')
      expect(result.lease.ownerId).toBe('owner-a')
      expect(result.lease.state).toBe('active')
      expect(result.lease.createdAt).toBe(1000)
      expect(result.lease.expiresAt).toBe(31_000)
      expect(Object.isFrozen(result.lease)).toBe(true)
    }
  })

  it('denies duplicate-owner on the same resource', () => {
    const mgr = createLeaseManager()
    mgr.acquire(makeRequest({ id: 'lease-1', ownerId: 'owner-a' }))
    const result = mgr.acquire(makeRequest({ id: 'lease-2', ownerId: 'owner-a', now: 2000 }))
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.reason).toBe('duplicate-owner')
      expect(result.holder?.ownerId).toBe('owner-a')
    }
  })

  it('denies resource-held when a different owner holds the resource', () => {
    const mgr = createLeaseManager()
    mgr.acquire(makeRequest({ id: 'lease-1', ownerId: 'owner-a' }))
    const result = mgr.acquire(makeRequest({ id: 'lease-2', ownerId: 'owner-b', now: 2000 }))
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.reason).toBe('resource-held')
      expect(result.holder?.ownerId).toBe('owner-a')
    }
  })

  it('allows acquisition after the previous lease expired naturally', () => {
    const mgr = createLeaseManager()
    mgr.acquire(makeRequest({ id: 'lease-1', ownerId: 'owner-a', durationMs: 5000, now: 1000 }))
    const result = mgr.acquire(makeRequest({
      id: 'lease-2',
      ownerId: 'owner-b',
      now: 6001,
    }))
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.lease.ownerId).toBe('owner-b')
    }
  })

  it('allows acquisition on a different resource', () => {
    const mgr = createLeaseManager()
    mgr.acquire(makeRequest({ id: 'lease-1', resourceId: 'tool-shell' }))
    const result = mgr.acquire(makeRequest({ id: 'lease-2', resourceId: 'tool-browser' }))
    expect(result.ok).toBe(true)
  })

  it('throws on duplicate lease id', () => {
    const mgr = createLeaseManager()
    mgr.acquire(makeRequest({ id: 'lease-1', resourceId: 'res-a' }))
    expect(() =>
      mgr.acquire(makeRequest({ id: 'lease-1', resourceId: 'res-b' })),
    ).toThrow(LeaseError)
    expect(() =>
      mgr.acquire(makeRequest({ id: 'lease-1', resourceId: 'res-b' })),
    ).toThrow('duplicate lease id')
  })

  it('throws on empty id', () => {
    const mgr = createLeaseManager()
    expect(() => mgr.acquire(makeRequest({ id: '' }))).toThrow(LeaseError)
  })

  it('throws on empty resourceId', () => {
    const mgr = createLeaseManager()
    expect(() => mgr.acquire(makeRequest({ resourceId: '' }))).toThrow(LeaseError)
  })

  it('throws on empty ownerId', () => {
    const mgr = createLeaseManager()
    expect(() => mgr.acquire(makeRequest({ ownerId: '' }))).toThrow(LeaseError)
  })

  it('throws on non-positive durationMs', () => {
    const mgr = createLeaseManager()
    expect(() => mgr.acquire(makeRequest({ durationMs: 0 }))).toThrow(LeaseError)
    expect(() => mgr.acquire(makeRequest({ id: 'x', durationMs: -1 }))).toThrow(LeaseError)
  })

  it('supports session resource kind', () => {
    const mgr = createLeaseManager()
    const result = mgr.acquire(makeRequest({ id: 'ls-1', resourceKind: 'session', resourceId: 'session-main' }))
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.lease.resourceKind).toBe('session')
  })

  it('supports subagent resource kind', () => {
    const mgr = createLeaseManager()
    const result = mgr.acquire(makeRequest({ id: 'ls-1', resourceKind: 'subagent', resourceId: 'agent-1' }))
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.lease.resourceKind).toBe('subagent')
  })
})

describe('LeaseManager.release', () => {
  it('releases an active lease by the owner', () => {
    const mgr = createLeaseManager()
    mgr.acquire(makeRequest({ id: 'lease-1', ownerId: 'owner-a' }))
    const result = mgr.release({ leaseId: 'lease-1', ownerId: 'owner-a', now: 5000 })
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.lease.state).toBe('released')
      expect(result.lease.releasedAt).toBe(5000)
      expect(Object.isFrozen(result.lease)).toBe(true)
    }
  })

  it('denies release by a non-owner', () => {
    const mgr = createLeaseManager()
    mgr.acquire(makeRequest({ id: 'lease-1', ownerId: 'owner-a' }))
    const result = mgr.release({ leaseId: 'lease-1', ownerId: 'owner-b', now: 5000 })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toBe('not-owner')
  })

  it('returns not-found for non-existent lease', () => {
    const mgr = createLeaseManager()
    const result = mgr.release({ leaseId: 'nope', ownerId: 'owner-a', now: 5000 })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toBe('not-found')
  })

  it('returns already-released for a released lease', () => {
    const mgr = createLeaseManager()
    mgr.acquire(makeRequest({ id: 'lease-1', ownerId: 'owner-a' }))
    mgr.release({ leaseId: 'lease-1', ownerId: 'owner-a', now: 5000 })
    const result = mgr.release({ leaseId: 'lease-1', ownerId: 'owner-a', now: 6000 })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toBe('already-released')
  })

  it('frees the resource for subsequent acquisition', () => {
    const mgr = createLeaseManager()
    mgr.acquire(makeRequest({ id: 'lease-1', ownerId: 'owner-a' }))
    mgr.release({ leaseId: 'lease-1', ownerId: 'owner-a', now: 5000 })
    const result = mgr.acquire(makeRequest({ id: 'lease-2', ownerId: 'owner-b', now: 5001 }))
    expect(result.ok).toBe(true)
  })
})

describe('LeaseManager.expireAll', () => {
  it('expires leases past their expiresAt', () => {
    const mgr = createLeaseManager()
    mgr.acquire(makeRequest({ id: 'lease-1', durationMs: 5000, now: 1000 }))
    mgr.acquire(makeRequest({ id: 'lease-2', resourceId: 'res-2', durationMs: 10000, now: 1000 }))
    const expired = mgr.expireAll(7000)
    expect(expired).toHaveLength(1)
    expect(expired[0]!.id).toBe('lease-1')
    expect(expired[0]!.state).toBe('expired')
    expect(Object.isFrozen(expired[0]!)).toBe(true)
  })

  it('does not expire leases that are still valid', () => {
    const mgr = createLeaseManager()
    mgr.acquire(makeRequest({ id: 'lease-1', durationMs: 30000, now: 1000 }))
    const expired = mgr.expireAll(5000)
    expect(expired).toHaveLength(0)
  })

  it('does not expire already released leases', () => {
    const mgr = createLeaseManager()
    mgr.acquire(makeRequest({ id: 'lease-1', durationMs: 5000, now: 1000 }))
    mgr.release({ leaseId: 'lease-1', ownerId: 'owner-a', now: 2000 })
    const expired = mgr.expireAll(7000)
    expect(expired).toHaveLength(0)
  })

  it('frees resources for expired leases', () => {
    const mgr = createLeaseManager()
    mgr.acquire(makeRequest({ id: 'lease-1', durationMs: 5000, now: 1000 }))
    mgr.expireAll(7000)
    const result = mgr.acquire(makeRequest({ id: 'lease-2', ownerId: 'owner-b', now: 8000 }))
    expect(result.ok).toBe(true)
  })
})

describe('LeaseManager.get', () => {
  it('returns a lease by id', () => {
    const mgr = createLeaseManager()
    mgr.acquire(makeRequest({ id: 'lease-1' }))
    const lease = mgr.get('lease-1')
    expect(lease).toBeDefined()
    expect(lease!.id).toBe('lease-1')
  })

  it('returns undefined for non-existent id', () => {
    const mgr = createLeaseManager()
    expect(mgr.get('nope')).toBeUndefined()
  })
})

describe('LeaseManager.activeForResource', () => {
  it('returns the active lease for a resource', () => {
    const mgr = createLeaseManager()
    mgr.acquire(makeRequest({ id: 'lease-1', resourceId: 'tool-shell' }))
    const lease = mgr.activeForResource('tool-shell')
    expect(lease).toBeDefined()
    expect(lease!.id).toBe('lease-1')
  })

  it('returns undefined after release', () => {
    const mgr = createLeaseManager()
    mgr.acquire(makeRequest({ id: 'lease-1', resourceId: 'tool-shell', ownerId: 'owner-a' }))
    mgr.release({ leaseId: 'lease-1', ownerId: 'owner-a', now: 5000 })
    expect(mgr.activeForResource('tool-shell')).toBeUndefined()
  })

  it('returns undefined for unknown resource', () => {
    const mgr = createLeaseManager()
    expect(mgr.activeForResource('unknown')).toBeUndefined()
  })
})

describe('LeaseManager.allActive', () => {
  it('returns all active leases', () => {
    const mgr = createLeaseManager()
    mgr.acquire(makeRequest({ id: 'l1', resourceId: 'r1' }))
    mgr.acquire(makeRequest({ id: 'l2', resourceId: 'r2' }))
    expect(mgr.allActive()).toHaveLength(2)
  })

  it('excludes released and expired leases', () => {
    const mgr = createLeaseManager()
    mgr.acquire(makeRequest({ id: 'l1', resourceId: 'r1', durationMs: 5000, now: 1000 }))
    mgr.acquire(makeRequest({ id: 'l2', resourceId: 'r2', now: 1000 }))
    mgr.release({ leaseId: 'l2', ownerId: 'owner-a', now: 2000 })
    mgr.expireAll(7000)
    expect(mgr.allActive()).toHaveLength(0)
  })
})

describe('LeaseManager.allHeldBy', () => {
  it('returns all active leases held by a specific owner', () => {
    const mgr = createLeaseManager()
    mgr.acquire(makeRequest({ id: 'l1', resourceId: 'r1', ownerId: 'owner-a' }))
    mgr.acquire(makeRequest({ id: 'l2', resourceId: 'r2', ownerId: 'owner-b' }))
    mgr.acquire(makeRequest({ id: 'l3', resourceId: 'r3', ownerId: 'owner-a' }))
    const held = mgr.allHeldBy('owner-a')
    expect(held).toHaveLength(2)
    expect(held.every(l => l.ownerId === 'owner-a')).toBe(true)
  })

  it('excludes released leases', () => {
    const mgr = createLeaseManager()
    mgr.acquire(makeRequest({ id: 'l1', resourceId: 'r1', ownerId: 'owner-a' }))
    mgr.release({ leaseId: 'l1', ownerId: 'owner-a', now: 5000 })
    expect(mgr.allHeldBy('owner-a')).toHaveLength(0)
  })
})

describe('fail-closed: second owner cannot steal active lease', () => {
  it('rejects a second owner even with a different lease id', () => {
    const mgr = createLeaseManager()
    mgr.acquire(makeRequest({ id: 'l1', ownerId: 'owner-a', resourceId: 'shared-tool' }))
    const result = mgr.acquire(makeRequest({
      id: 'l2',
      ownerId: 'owner-b',
      resourceId: 'shared-tool',
      now: 2000,
    }))
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.reason).toBe('resource-held')
      expect(result.holder?.ownerId).toBe('owner-a')
    }
  })

  it('rejects the same owner re-acquiring the same resource', () => {
    const mgr = createLeaseManager()
    mgr.acquire(makeRequest({ id: 'l1', ownerId: 'owner-a', resourceId: 'tool-x' }))
    const result = mgr.acquire(makeRequest({
      id: 'l2',
      ownerId: 'owner-a',
      resourceId: 'tool-x',
      now: 2000,
    }))
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toBe('duplicate-owner')
  })

  it('cannot release by impersonating the owner', () => {
    const mgr = createLeaseManager()
    mgr.acquire(makeRequest({ id: 'l1', ownerId: 'owner-a', resourceId: 'tool-x' }))
    const releaseResult = mgr.release({ leaseId: 'l1', ownerId: 'attacker', now: 3000 })
    expect(releaseResult.ok).toBe(false)
    if (!releaseResult.ok) expect(releaseResult.reason).toBe('not-owner')
    expect(mgr.activeForResource('tool-x')).toBeDefined()
  })

  it('expired leases do not block new acquisitions', () => {
    const mgr = createLeaseManager()
    mgr.acquire(makeRequest({ id: 'l1', ownerId: 'owner-a', durationMs: 1000, now: 1000 }))
    mgr.expireAll(3000)
    const result = mgr.acquire(makeRequest({ id: 'l2', ownerId: 'owner-b', now: 3001 }))
    expect(result.ok).toBe(true)
  })
})
