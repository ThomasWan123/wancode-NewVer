/**
 * Lease states model the lifecycle of a kernel-managed resource
 * allocation from request through completion or cancellation.
 */
export type LeaseState =
  | 'pending'
  | 'active'
  | 'completed'
  | 'cancelled'
  | 'expired'

/**
 * A lease represents a time-bounded allocation of a provider slot
 * for a single session turn or sub-agent invocation.
 */
export interface Lease {
  readonly id: string
  readonly profileId: string
  readonly sessionId: string
  readonly state: LeaseState
  readonly createdAt: number
  readonly expiresAt: number
  readonly completedAt?: number
}
