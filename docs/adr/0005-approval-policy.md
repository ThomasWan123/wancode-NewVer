# ADR-0005: Approval policy ≠ sandbox policy

## Status

Accepted (Slice 5)

## Context

WanCode issue #75 requires an explicit approval policy separated from
sandbox/OS ACL enforcement. The upstream DSH runtime treats these as
two independent Cordis rows (`sandbox-policy` and `approval`), but no
kernel-level contract or desktop adapter existed before Slice 5 to
evaluate, record, and expose approval decisions independently.

Sandbox policy controls *what a process can do at the OS level*
(filesystem ACLs, process isolation). Approval policy controls
*what a tool invocation may do at the user-consent level*. These
two axes are orthogonal: a sandboxed environment can auto-approve
tool use (trusted development), and an unsandboxed environment can
require user prompts for every tool invocation (untrusted model).

Slice 3 established approval ledger event kinds (`approval.request`,
`approval.grant`, `approval.deny`). Slice 4 established leases for
tool/session ownership. Slice 5 completes the approval layer.

## Decision

### Kernel layer (`@wancode/harness-kernel/approval`)

A pure approval policy evaluator with:

- **Types**: `ApprovalPolicyMode` (`auto-approve` | `prompt` | `deny`),
  `ApprovalResourceKind`, `ApprovalRequest`, `ApprovalDecision`,
  `ApprovalPolicy`, `ApprovalPolicyRule`.
- **Evaluation**: `evaluateApproval(request, policy, now)` returns a
  frozen `ApprovalDecision`. Rules are matched in declaration order
  by resource kind and/or resource pattern (simple glob). The first
  match wins; unmatched requests fall back to `defaultMode`.
- **Fail-closed**: malformed requests throw `ApprovalPolicyError`
  rather than silently approving.
- **Pre-built policies**: `PROMPT_ALL_POLICY`, `AUTO_APPROVE_ALL_POLICY`,
  `DENY_ALL_POLICY` as frozen constants.
- **Factory**: `createApprovalPolicy()` validates and freezes inputs.

The evaluator is pure: no timers, no platform deps, no Cordis
dependency. Decision outcomes are `approved`, `prompted`, or `denied`.

### Desktop adapter (`dsh-plugin-desktop/approval-adapter`)

A thin adapter wrapping the kernel evaluator with:

- **requestApproval**: evaluates against the active policy, records
  `approval.request` + outcome event on the Slice 3 session ledger.
  Auto-approved requests immediately record `approval.grant`.
  Prompted requests are held pending for user interaction.
  Denied requests immediately record `approval.deny`.
- **grant / deny**: resolve pending prompted approvals with ledger
  events recording `grantedBy: 'user'` or `deniedBy: 'user'`.
- **Lease integration**: when `requireLease` is true, denies if no
  active lease exists for the resource (fail-closed).
- **Runtime policy change**: `setPolicy()` allows switching the
  active approval policy without restart.

### Tray readout (`dsh-plugin-desktop/approval-tray`)

A thin status-group tray item showing the active approval policy
mode. Optionally interactive (radio submenu) when `onModeChange`
is provided. The full settings-panel integration is deferred until
the settings schema supports runtime-scoped policy selection.

## Consequences

- Approval decisions are evaluated at the kernel level before any
  Cordis, Electron, or OS dependency is involved.
- The session ledger records a complete audit trail of approval
  lifecycle events including user grant/deny interactions.
- The approval adapter can optionally require an active lease
  (Slice 4) for tool-scoped approvals, composing the two contracts.
- The tray readout reflects the active policy without coupling to
  the sandbox settings or OS ACL state.
- No relay, profile composition, or upstream submodule changes are
  required. The existing profile.ts approval row config continues
  to set the upstream `@deepseek-ai/dsh-user-approval` policy.
- Future slices can wire the adapter into the Host `approvals`
  Cordis service and connect the tray toggle to the settings schema.
