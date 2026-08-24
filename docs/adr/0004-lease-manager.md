# ADR-0004: Lease manager with duplicate-owner protection

## Status

Accepted (Slice 4)

## Context

WanCode issue #75 requires tool and session leases with fail-closed
duplicate-owner protection. When a tool or session is actively held by
one owner, no other owner (or the same owner again) may steal it.
Terminal and shutdown paths must compensate by releasing all held leases.

Slice 3 established the append-only session ledger. Slice 4 adds the
lease system that records acquire/release/deny/expire events to that
ledger.

## Decision

### Kernel layer (`@wancode/harness-kernel/lease`)

A pure `LeaseManager` implementation with:

- **Acquire**: creates a frozen, active `Lease` record with a bounded
  duration. Rejects with `'duplicate-owner'` if the same owner already
  holds the resource, or `'resource-held'` if a different owner holds it.
  Expired leases are auto-evicted on acquire (lazy expiry).
- **Release**: transitions an active lease to `'released'` state. Only
  the recorded owner can release; impersonation returns `'not-owner'`.
- **ExpireAll**: bulk-expires all leases past their `expiresAt`.
- **Query**: `get`, `activeForResource`, `allActive`, `allHeldBy`.

All lease records are `Object.freeze`d. The manager is pure (no timers,
no platform deps) and deterministic when given explicit `now` values.

### Desktop adapter (`dsh-plugin-desktop/lease-adapter`)

A thin adapter wrapping the kernel manager with:

- Typed methods for tool and session acquisition.
- Ledger integration: every acquire/release/deny/expire writes a
  `LedgerEvent` to the Slice 3 session ledger.
- `releaseAllForOwner`: compensating release when an agent terminates.
- `compensatingShutdown`: release all leases on application exit.

### Ledger event kinds

The stub kinds from Slice 3 are replaced with actionable kinds:
`lease.acquired`, `lease.released`, `lease.denied`, `lease.expired`.

## Consequences

- Tool and session ownership is enforced at the kernel level before
  any Cordis or Electron dependency is involved.
- The desktop adapter can be wired into shutdown handlers and terminal
  exit paths to guarantee no orphan leases survive process exit.
- The session ledger records a complete audit trail of lease lifecycle
  events including compensating releases.
- Future slices (Approvals UX, distributed lease backends) can build
  on the `LeaseManager` interface without changing the kernel contract.
- No relay, profile, or upstream changes are required.
