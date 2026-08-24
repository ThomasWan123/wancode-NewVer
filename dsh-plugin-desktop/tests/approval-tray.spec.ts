import { describe, expect, it, vi } from 'vitest'
import type { ApprovalPolicyMode } from '@wancode/harness-kernel'
import { bindApprovalTray } from '../src/approval-tray.ts'
import type { DesktopTrayItem, DesktopTrayItemRegistration } from '../src/runtime.ts'

function createMockRuntime() {
  const items: DesktopTrayItem[] = []
  const registration: DesktopTrayItemRegistration = {
    refresh: vi.fn(),
    dispose: vi.fn(),
  }
  return {
    items,
    registration,
    registerTrayItem(item: DesktopTrayItem) {
      items.push(item)
      return registration
    },
  }
}

describe('bindApprovalTray', () => {
  it('registers a tray item in the status group', () => {
    const runtime = createMockRuntime()
    let mode: ApprovalPolicyMode = 'prompt'

    bindApprovalTray({
      registerTrayItem: item => runtime.registerTrayItem(item),
      getMode: () => mode,
    })

    expect(runtime.items).toHaveLength(1)
    expect(runtime.items[0]!.group).toBe('status')
    expect(runtime.items[0]!.order).toBe(15)
  })

  it('shows the current policy mode in the label', () => {
    const runtime = createMockRuntime()
    let mode: ApprovalPolicyMode = 'prompt'

    bindApprovalTray({
      registerTrayItem: item => runtime.registerTrayItem(item),
      getMode: () => mode,
    })

    expect(runtime.items[0]!.label()).toBe('Approvals: Prompt before use')

    mode = 'auto-approve'
    expect(runtime.items[0]!.label()).toBe('Approvals: Auto-approve')

    mode = 'deny'
    expect(runtime.items[0]!.label()).toBe('Approvals: Deny all')
  })

  it('renders a submenu with all three modes', () => {
    const runtime = createMockRuntime()
    let mode: ApprovalPolicyMode = 'prompt'

    bindApprovalTray({
      registerTrayItem: item => runtime.registerTrayItem(item),
      getMode: () => mode,
    })

    const submenu = runtime.items[0]!.submenu!()
    expect(submenu).toHaveLength(3)
    expect(submenu[0]!.label()).toBe('Auto-approve')
    expect(submenu[1]!.label()).toBe('Prompt before use')
    expect(submenu[2]!.label()).toBe('Deny all')
  })

  it('checks the currently active mode', () => {
    const runtime = createMockRuntime()
    let mode: ApprovalPolicyMode = 'prompt'

    bindApprovalTray({
      registerTrayItem: item => runtime.registerTrayItem(item),
      getMode: () => mode,
    })

    const submenu = runtime.items[0]!.submenu!()
    expect(submenu[0]!.checked!()).toBe(false)
    expect(submenu[1]!.checked!()).toBe(true)
    expect(submenu[2]!.checked!()).toBe(false)
  })

  it('disables items when no onModeChange is provided', () => {
    const runtime = createMockRuntime()
    let mode: ApprovalPolicyMode = 'prompt'

    bindApprovalTray({
      registerTrayItem: item => runtime.registerTrayItem(item),
      getMode: () => mode,
    })

    const submenu = runtime.items[0]!.submenu!()
    for (const item of submenu) {
      expect(item.enabled!()).toBe(false)
    }
  })

  it('enables items when onModeChange is provided', () => {
    const runtime = createMockRuntime()
    let mode: ApprovalPolicyMode = 'prompt'
    const onChange = vi.fn()

    bindApprovalTray({
      registerTrayItem: item => runtime.registerTrayItem(item),
      getMode: () => mode,
      onModeChange: onChange,
    })

    const submenu = runtime.items[0]!.submenu!()
    for (const item of submenu) {
      expect(item.enabled!()).toBe(true)
    }
  })

  it('calls onModeChange when a different mode is selected', () => {
    const runtime = createMockRuntime()
    let mode: ApprovalPolicyMode = 'prompt'
    const onChange = vi.fn()

    bindApprovalTray({
      registerTrayItem: item => runtime.registerTrayItem(item),
      getMode: () => mode,
      onModeChange: onChange,
    })

    const submenu = runtime.items[0]!.submenu!()
    submenu[0]!.invoke()
    expect(onChange).toHaveBeenCalledWith('auto-approve')
  })

  it('does not call onModeChange when the same mode is selected', () => {
    const runtime = createMockRuntime()
    let mode: ApprovalPolicyMode = 'prompt'
    const onChange = vi.fn()

    bindApprovalTray({
      registerTrayItem: item => runtime.registerTrayItem(item),
      getMode: () => mode,
      onModeChange: onChange,
    })

    const submenu = runtime.items[0]!.submenu!()
    submenu[1]!.invoke()
    expect(onChange).not.toHaveBeenCalled()
  })

  it('returns a disposable registration handle', () => {
    const runtime = createMockRuntime()
    let mode: ApprovalPolicyMode = 'prompt'

    const registration = bindApprovalTray({
      registerTrayItem: item => runtime.registerTrayItem(item),
      getMode: () => mode,
    })

    expect(registration.refresh).toBeTypeOf('function')
    expect(registration.dispose).toBeTypeOf('function')
  })
})
