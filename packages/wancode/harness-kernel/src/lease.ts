/**
 * Lease management for kernel-managed resource allocations.
 *
 * A lease represents a time-bounded, owner-exclusive allocation of a
 * resource (tool slot, session turn, sub-agent invocation). The manager
 * enforces fail-closed duplicate-owner protection: a second owner cannot
 * steal an active lease on the same resource.
 */

// ---------------------------------------------------------------------------
// Lease states
// ---------------------------------------------------------------------------

export type LeaseState =
  | 'pending'
  | 'active'
  | 'released'
  | 'expired'
  | 'denied'

// ---------------------------------------------------------------------------
// Resource types that can be leased
// ---------------------------------------------------------------------------

export type LeaseResourceKind = 'tool' | 'session' | 'subagent'

// ---------------------------------------------------------------------------
// Core lease record
// ---------------------------------------------------------------------------

export interface Lease {
  readonly id: string
  readonly resourceId: string
  readonly resourceKind: LeaseResourceKind
  readonly ownerId: string
  readonly state: LeaseState
  readonly createdAt: number
  readonly expiresAt: number
  readonly releasedAt?: number
}

// ---------------------------------------------------------------------------
// Acquire / release contracts
// ---------------------------------------------------------------------------

export interface LeaseAcquireRequest {
  readonly id: string
  readonly resourceId: string
  readonly resourceKind: LeaseResourceKind
  readonly ownerId: string
  readonly durationMs: number
  readonly now: number
}

export type LeaseAcquireResult =
  | { readonly ok: true; readonly lease: Lease }
  | { readonly ok: false; readonly reason: LeaseDenyReason; readonly holder?: Lease }

export type LeaseDenyReason = 'duplicate-owner' | 'resource-held'

export interface LeaseReleaseRequest {
  readonly leaseId: string
  readonly ownerId: string
  readonly now: number
}

export type LeaseReleaseResult =
  | { readonly ok: true; readonly lease: Lease }
  | { readonly ok: false; readonly reason: 'not-found' | 'not-owner' | 'already-released' }

// ---------------------------------------------------------------------------
// Lease manager interface
// ---------------------------------------------------------------------------

export interface LeaseManager {
  acquire(request: LeaseAcquireRequest): LeaseAcquireResult
  release(request: LeaseReleaseRequest): LeaseReleaseResult
  expireAll(now: number): readonly Lease[]
  get(leaseId: string): Lease | undefined
  activeForResource(resourceId: string): Lease | undefined
  allActive(): readonly Lease[]
  allHeldBy(ownerId: string): readonly Lease[]
}

// ---------------------------------------------------------------------------
// Lease manager errors
// ---------------------------------------------------------------------------

export class LeaseError extends Error {
  constructor(message: string) {
    super(`Lease error: ${message}`)
    this.name = 'LeaseError'
  }
}

// ---------------------------------------------------------------------------
// Pure lease manager implementation
// ---------------------------------------------------------------------------

export function createLeaseManager(): LeaseManager {
  const leases = new Map<string, Lease>()
  const activeByResource = new Map<string, string>()

  function makeLease(request: LeaseAcquireRequest): Lease {
    return Object.freeze({
      id: request.id,
      resourceId: request.resourceId,
      resourceKind: request.resourceKind,
      ownerId: request.ownerId,
      state: 'active' as const,
      createdAt: request.now,
      expiresAt: request.now + request.durationMs,
    })
  }

  function releaseLease(lease: Lease, now: number): Lease {
    const released: Lease = Object.freeze({
      ...lease,
      state: 'released' as const,
      releasedAt: now,
    })
    leases.set(lease.id, released)
    activeByResource.delete(lease.resourceId)
    return released
  }

  function expireLease(lease: Lease): Lease {
    const expired: Lease = Object.freeze({
      ...lease,
      state: 'expired' as const,
      releasedAt: lease.expiresAt,
    })
    leases.set(lease.id, expired)
    activeByResource.delete(lease.resourceId)
    return expired
  }

  return {
    acquire(request: LeaseAcquireRequest): LeaseAcquireResult {
      if (!request.id || !request.resourceId || !request.ownerId) {
        throw new LeaseError('id, resourceId, and ownerId are required')
      }
      if (request.durationMs <= 0) {
        throw new LeaseError('durationMs must be positive')
      }
      if (leases.has(request.id)) {
        throw new LeaseError(`duplicate lease id: ${request.id}`)
      }

      const holderId = activeByResource.get(request.resourceId)
      if (holderId !== undefined) {
        const holder = leases.get(holderId)!
        if (holder.expiresAt > request.now) {
          const reason: LeaseDenyReason =
            holder.ownerId === request.ownerId ? 'duplicate-owner' : 'resource-held'
          return { ok: false, reason, holder }
        }
        expireLease(holder)
      }

      const lease = makeLease(request)
      leases.set(lease.id, lease)
      activeByResource.set(request.resourceId, lease.id)
      return { ok: true, lease }
    },

    release(request: LeaseReleaseRequest): LeaseReleaseResult {
      const lease = leases.get(request.leaseId)
      if (lease === undefined) {
        return { ok: false, reason: 'not-found' }
      }
      if (lease.ownerId !== request.ownerId) {
        return { ok: false, reason: 'not-owner' }
      }
      if (lease.state !== 'active') {
        return { ok: false, reason: 'already-released' }
      }
      const released = releaseLease(lease, request.now)
      return { ok: true, lease: released }
    },

    expireAll(now: number): readonly Lease[] {
      const expired: Lease[] = []
      for (const [, lease] of leases) {
        if (lease.state === 'active' && lease.expiresAt <= now) {
          expired.push(expireLease(lease))
        }
      }
      return expired
    },

    get(leaseId: string): Lease | undefined {
      return leases.get(leaseId)
    },

    activeForResource(resourceId: string): Lease | undefined {
      const leaseId = activeByResource.get(resourceId)
      return leaseId !== undefined ? leases.get(leaseId) : undefined
    },

    allActive(): readonly Lease[] {
      const active: Lease[] = []
      for (const [, lease] of leases) {
        if (lease.state === 'active') active.push(lease)
      }
      return active
    },

    allHeldBy(ownerId: string): readonly Lease[] {
      const held: Lease[] = []
      for (const [, lease] of leases) {
        if (lease.state === 'active' && lease.ownerId === ownerId) {
          held.push(lease)
        }
      }
      return held
    },
  }
}
