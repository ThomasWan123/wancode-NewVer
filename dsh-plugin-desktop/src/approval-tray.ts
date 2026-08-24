/**
 * Thin tray readout for the desktop approval policy.
 *
 * Surfaces the active approval policy mode in the native tray's
 * status group. The tray item is read-only: it reflects the policy
 * selected at profile composition time (see profile.ts) or changed
 * at runtime through the host API (approval-adapter.ts).
 *
 * Full settings-panel integration (approval ≠ sandbox in the
 * preferences UI) is deferred until the settings schema supports
 * runtime-scoped policy selection without a restart.
 */

import type { ApprovalPolicyMode } from '@wancode/harness-kernel'
import type {
  DesktopTrayItem,
  DesktopTrayItemRegistration,
  DesktopTraySubmenuItem,
} from './runtime.ts'

// ---------------------------------------------------------------------------
// Policy mode labels
// ---------------------------------------------------------------------------

const MODE_LABELS: Readonly<Record<ApprovalPolicyMode, string>> = {
  'auto-approve': 'Auto-approve',
  'prompt': 'Prompt before use',
  'deny': 'Deny all',
}

// ---------------------------------------------------------------------------
// Tray item factory
// ---------------------------------------------------------------------------

export interface ApprovalTrayBindingInput {
  /** Register a tray item on the desktop runtime. */
  readonly registerTrayItem: (item: DesktopTrayItem) => DesktopTrayItemRegistration
  /** Read the current approval policy mode. */
  readonly getMode: () => ApprovalPolicyMode
  /** Called when the user selects a different mode. */
  readonly onModeChange?: (mode: ApprovalPolicyMode) => void
}

/**
 * Bind a read-only (or optionally interactive) approval policy
 * readout to the native tray menu.
 *
 * @returns a disposable registration handle.
 */
export function bindApprovalTray(input: ApprovalTrayBindingInput): DesktopTrayItemRegistration {
  const modes: readonly ApprovalPolicyMode[] = ['auto-approve', 'prompt', 'deny']

  const submenu = (): readonly DesktopTraySubmenuItem[] =>
    modes.map(mode => ({
      label: () => MODE_LABELS[mode],
      type: 'radio' as const,
      checked: () => input.getMode() === mode,
      enabled: () => input.onModeChange !== undefined,
      invoke: () => {
        if (input.onModeChange && input.getMode() !== mode) {
          input.onModeChange(mode)
        }
      },
    }))

  return input.registerTrayItem({
    group: 'status',
    order: 15,
    label: () => `Approvals: ${MODE_LABELS[input.getMode()]}`,
    invoke: () => {},
    submenu,
  })
}
