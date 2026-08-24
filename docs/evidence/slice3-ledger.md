# Slice 3 — Session ledger + evidence scrub

## What was implemented

### Append-only session ledger (`@wancode/harness-kernel`)

Extended `LedgerEvent` types from the Slice 0 stubs into a complete
session evidence system with:

| Component | Description |
| --- | --- |
| Extended `LedgerEventKind` | Added `session.start`, `session.end`, `integrity.pass`, `integrity.reject`, `tool.invoke`, `tool.result`, `approval.request`, `approval.grant`, `approval.deny`, `probe.not-run` |
| `ProbeOutcome` type | `'pass' \| 'fail' \| 'not-run'` — skipped probes are NOT-RUN, never success |
| `scrubSecrets(value)` | Redacts API keys, JWTs, GitHub PATs, Slack tokens, AWS key IDs, base64 blobs |
| `scrubMetadata(record)` | Deep-scrubs all string values in nested records and arrays |
| `createLedgerEvent(input)` | Creates a frozen, scrubbed event for append-only storage |
| `createNotRunEvent(input)` | Convenience for `probe.not-run` with `probeOutcome: 'not-run'` |
| `createSessionLedger()` | In-memory append-only ledger with monotonic timestamps and dedup |
| `LedgerAppendError` | Structured error for ordering/duplicate/freeze violations |

### Desktop host adapter (`dsh-plugin-desktop/session-ledger`)

Thin adapter wiring the kernel ledger to desktop host seams:

| Seam | Method |
| --- | --- |
| Host boot | `recordSessionStart(sessionId, metadata?)` |
| Host shutdown | `recordSessionEnd(sessionId, metadata?)` |
| Integrity gate pass | `recordIntegrityPass(sessionId, metadata?)` |
| Integrity gate reject | `recordIntegrityReject(sessionId, metadata?)` |
| Tool invocation | `recordToolInvoke(sessionId, metadata?)` |
| Tool result | `recordToolResult(sessionId, metadata?)` |
| Approval request | `recordApprovalRequest(sessionId, metadata?)` |
| Approval granted | `recordApprovalGrant(sessionId, metadata?)` |
| Approval denied | `recordApprovalDeny(sessionId, metadata?)` |
| Skipped probe | `recordNotRun(sessionId, metadata?)` |

The `observeIntegrityGate` wrapper observes pass/reject outcomes at
the existing `integrity-gate.ts` seam without changing gate behavior.

### Fail-closed guarantees

- **Scrubbing**: All metadata passes through `scrubMetadata` before
  freeze. Tests verify that API keys, JWTs, GitHub PATs, Slack tokens,
  AWS key IDs, and bearer tokens are redacted in all event types.
- **NOT-RUN**: `createNotRunEvent` always sets `probeOutcome: 'not-run'`
  and `kind: 'probe.not-run'`. Tests assert the outcome is never
  `'pass'` or `'fail'`.
- **Ordering**: The ledger rejects out-of-order timestamps, duplicate
  ids, non-frozen events, and invalid timestamps.
- **Immutability**: All events are `Object.freeze`d before append.

## Seams chosen

1. **`@wancode/harness-kernel/ledger-event`** — pure functions with no
   Electron, Cordis, or platform dependencies, testable in any
   Node.js environment.
2. **`dsh-plugin-desktop/session-ledger`** — desktop adapter exported
   from the plugin package, consumable at profile composition and
   relay entry points without adding Cordis inject requirements.
3. **`dsh-plugin-desktop/integrity-gate`** — existing Slice 2 seam,
   now observable via `observeIntegrityGate`.

## What was NOT changed

- Relay (`relay.ts`) is not modified. The session ledger adapter can
  observe relay events via its typed methods but does not inject into
  the relay pipeline.
- No Cordis service face or inject was added. The ledger is a
  standalone module consumable by any host code.
- Upstream submodule pin is unchanged.

## How to re-run tests

```bash
# Harness-kernel unit tests (97 tests)
yarn workspace @wancode/harness-kernel test

# Desktop session ledger adapter tests (25 tests)
yarn workspace dsh-plugin-desktop vitest run tests/session-ledger.spec.ts

# Full desktop test suite (confirms no regressions)
yarn workspace dsh-plugin-desktop test

# Typecheck (all configs)
yarn workspace @wancode/harness-kernel typecheck
yarn workspace dsh-plugin-desktop typecheck

# Layout gate
yarn check:layout
```

## Known pre-existing skip

`tests/verify-win-lifecycle.spec.ts` fails on Linux because it tests
Windows-specific path resolution. This failure exists on the base
branch and is unrelated to Slice 3.
