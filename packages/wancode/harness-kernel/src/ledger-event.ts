/**
 * Ledger event kinds enumerate the observable state transitions that
 * the kernel records for audit and billing reconciliation.
 */
export type LedgerEventKind =
  | 'lease.created'
  | 'lease.activated'
  | 'lease.completed'
  | 'lease.cancelled'
  | 'lease.expired'
  | 'tokens.consumed'
  | 'tokens.refunded'

/**
 * A ledger event is an append-only record of a state change or
 * metered consumption against a session or provider profile.
 */
export interface LedgerEvent {
  readonly id: string
  readonly kind: LedgerEventKind
  readonly leaseId: string
  readonly sessionId: string
  readonly profileId: string
  readonly timestamp: number
  readonly tokensIn?: number
  readonly tokensOut?: number
  readonly metadata?: Readonly<Record<string, unknown>>
}
