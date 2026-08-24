# Slice 5 — Approval policy ≠ sandbox

## What was implemented

### Approval policy evaluator (`@wancode/harness-kernel/approval`)

A pure, platform-independent approval policy system with types and
fail-closed evaluation:

| Component | Description |
| --- | --- |
| `ApprovalPolicyMode` | `'auto-approve' \| 'prompt' \| 'deny'` |
| `ApprovalResourceKind` | `'tool' \| 'session' \| 'subagent'` |
| `ApprovalRequest` | Input: requestId, resourceId, resourceKind, sessionId, ownerId, optional leaseId/metadata |
| `ApprovalDecisionOutcome` | `'approved' \| 'prompted' \| 'denied'` |
| `ApprovalDecision` | Frozen output: requestId, outcome, policyMode, resourceId, resourceKind, sessionId, timestamp |
| `ApprovalPolicyRule` | Rule: optional resourceKind, optional resourcePattern, required mode |
| `ApprovalPolicy` | Policy: defaultMode + ordered rules |
| `evaluateApproval()` | Pure evaluator: request × policy → frozen decision |
| `createApprovalPolicy()` | Validated factory returning a frozen policy |
| `ApprovalPolicyError` | Structured error for malformed inputs |
| `PROMPT_ALL_POLICY` | Pre-built: prompt for everything (safe default) |
| `AUTO_APPROVE_ALL_POLICY` | Pre-built: auto-approve everything |
| `DENY_ALL_POLICY` | Pre-built: deny everything |

### Desktop approval adapter (`dsh-plugin-desktop/approval-adapter`)

Wires the kernel evaluator to real host boundaries with ledger
integration:

| Seam | Method |
| --- | --- |
| Submit approval | `requestApproval({ resourceId, resourceKind, sessionId, ownerId, … })` |
| Grant pending | `grant({ requestId, sessionId })` |
| Deny pending | `deny({ requestId, sessionId })` |
| Query pending | `getPending(requestId)`, `pendingForSession(sessionId)`, `pendingCount()` |
| Policy control | `policy` (getter), `setPolicy(policy)` |

Each operation records the corresponding ledger event
(`approval.request`, `approval.grant`, `approval.deny`) with
metadata including autoApproved, grantedBy/deniedBy, and
no-active-lease reason.

### Approval tray readout (`dsh-plugin-desktop/approval-tray`)

A thin status-group tray item showing the active approval policy mode
with an optional radio submenu for runtime mode switching.

| Feature | Detail |
| --- | --- |
| Group | `status`, order 15 |
| Label | `Approvals: {mode label}` |
| Submenu | Radio items for auto-approve, prompt, deny |
| Interaction | Read-only by default; interactive when `onModeChange` provided |

### Fail-closed guarantees

- **Malformed requests throw**: empty requestId, resourceId, sessionId,
  or ownerId throws `ApprovalPolicyError` rather than approving.
- **No-active-lease deny**: when `requireLease` is true and no active
  lease exists, the request is denied regardless of policy.
- **Frozen decisions**: all `ApprovalDecision` records are `Object.freeze`d.
- **No sandbox coupling**: approval decisions never reference sandbox
  state, OS ACL, or permission modes.

### Approval ≠ sandbox separation

The approval and sandbox concerns are explicitly separated:

| Axis | Upstream row | What it controls | Slice 5 contract |
| --- | --- | --- | --- |
| Sandbox | `sandbox-policy` | Filesystem/process ACL | Not touched |
| Approval | `approval` | User consent before tool use | `evaluateApproval()` + adapter |
| Permission preset | `permission` | Named preset | Not touched |

The kernel evaluator has zero references to sandbox, ACL, or OS state.
Tests explicitly verify this separation.

## Seams chosen

1. **`@wancode/harness-kernel/approval`** — pure types and evaluation,
   no Electron/Cordis/platform dependencies. Testable in any Node.js env.
2. **`dsh-plugin-desktop/approval-adapter`** — desktop adapter exported
   from the plugin package. Wires the evaluator to real host seams and
   records events to the Slice 3 session ledger.
3. **`dsh-plugin-desktop/approval-tray`** — thin tray readout in the
   status group. Follows the same `registerTrayItem` pattern used by
   relay, profiles, and updates.
4. **Lease integration** — optional `requireLease` parameter composes
   with the Slice 4 `LeaseManager` without coupling.

## UX decision

The tray status group has a clean seam for a minimal approvals readout.
A radio submenu is provided for all three policy modes. Full settings-
panel integration (approval policy as a registered settings-file
namespace field) is **deferred** because:

- The current `DesktopSettings` schema changes require an application
  restart (via `requestRestart()`), which is too heavy for a policy
  toggle that should take effect immediately.
- The approval adapter supports runtime `setPolicy()` without restart,
  which the tray readout can wire directly.
- A future slice can add a settings-schema field if a no-restart
  settings change pattern is established.

## What was NOT changed

- Relay (`relay.ts`) is not modified.
- Profile composition (`profile.ts`) is not modified — the existing
  `APPROVAL_ROW_ID` config continues to set the upstream approval
  policy based on `DSH_PERMISSION_MODE`.
- Upstream submodule pin is unchanged.
- No Cordis service face or inject was added.
- Sandbox policy (`sandbox-policy` row) is not modified.

## How to re-run tests

```bash
# Harness-kernel unit tests (167 tests including 34 new approval tests)
yarn workspace @wancode/harness-kernel test

# Desktop approval adapter tests (33 tests)
yarn workspace dsh-plugin-desktop vitest run tests/approval-adapter.spec.ts

# Desktop approval tray tests (10 tests)
yarn workspace dsh-plugin-desktop vitest run tests/approval-tray.spec.ts

# Full desktop test suite (confirms no regressions)
yarn workspace dsh-plugin-desktop test

# Typecheck (all configs)
yarn workspace @wancode/harness-kernel typecheck
yarn workspace dsh-plugin-desktop typecheck

# Layout gate (requires submodule)
yarn check:layout
```

## Test counts

| Suite | Tests |
| --- | --- |
| `@wancode/harness-kernel` (all) | 167 |
| `harness-kernel/approval.spec.ts` | 34 |
| `dsh-plugin-desktop/approval-adapter.spec.ts` | 33 |
| `dsh-plugin-desktop/approval-tray.spec.ts` | 10 |
| `dsh-plugin-desktop` (all) | 544 passed, 1 pre-existing Windows-only skip |

## Known pre-existing skip

`tests/verify-win-lifecycle.spec.ts` fails on Linux because it tests
Windows-specific path resolution. This failure exists on the base
branch and is unrelated to Slice 5.
