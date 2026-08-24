import {
  MACOS_DRAG_REGION_HEIGHT,
  MACOS_TITLEBAR_HEIGHT,
  MACOS_TRAFFIC_LIGHT_SAFE_WIDTH,
  WINDOWS_CAPTION_CONTROLS_WIDTH,
  WINDOWS_TITLEBAR_HEIGHT,
} from '../window-chrome.ts'
import { SIDEBAR_COLLAPSED } from './layout-state.ts'

/** Boxed-W mark used as a CSS mask so ink follows the surrounding label color. */
const WANCODE_W_MASK = "url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 50 50'%3E%3Cpath fill='%23000' fill-rule='evenodd' d='M10 3h30a7 7 0 0 1 7 7v30a7 7 0 0 1-7 7H10a7 7 0 0 1-7-7V10a7 7 0 0 1 7-7zm4.5 11h6.4L25 25.6 29.1 14h6.4L30.2 36h-6.1L25 29.2 25.9 36h-6.1L14.5 14z'/%3E%3C/svg%3E\") center / contain no-repeat"

/**
 * Product-brand restyle for both presentation modes. Targets the upstream
 * whale wordmark and fish mark by viewBox so compatibility keeps official
 * layout, sidebar, and conversation rows.
 */
export const WANCODE_BRAND_STYLES = `
button:has(svg[viewBox="0 0 182 24"]) {
  display: inline-flex; align-items: center; gap: 8px; position: relative;
  color: var(--dsw-alias-label-primary);
}
svg[viewBox="0 0 182 24"] {
  position: absolute !important; width: 0 !important; height: 0 !important;
  overflow: hidden !important; opacity: 0 !important;
}
button:has(svg[viewBox="0 0 182 24"])::before {
  content: ""; width: 24px; height: 24px; flex: 0 0 24px; background: currentColor;
  -webkit-mask: ${WANCODE_W_MASK};
  mask: ${WANCODE_W_MASK};
}
button:has(svg[viewBox="0 0 182 24"])::after {
  content: "WanCodeNewVer"; font-size: 14px; font-weight: 650; letter-spacing: 0.01em; white-space: nowrap;
}
svg[viewBox="0 0 23.16 17.04"] {
  background: currentColor;
  -webkit-mask: ${WANCODE_W_MASK};
  mask: ${WANCODE_W_MASK};
}
svg[viewBox="0 0 23.16 17.04"] path,
svg[viewBox="0 0 23.16 17.04"] g { opacity: 0 !important; }
span:has(svg[viewBox="0 0 23.16 17.04"]) + span {
  font-size: 0 !important; letter-spacing: 0 !important;
}
span:has(svg[viewBox="0 0 23.16 17.04"]) + span::after {
  content: "WanCodeNewVer"; font-size: 26px; line-height: 32px; font-weight: 500; letter-spacing: 0.01em;
}
`

/** Advanced-shell stylesheet kept as a plain string so the package client bundle stays self-contained. */
export const ADVANCED_SHELL_STYLES = `
html, body, #root { width: 100%; height: 100%; }
body[data-dsh-desktop-mode="advanced"] { margin: 0; background: transparent !important; }
.dshDesktopFrame { position: relative; display: grid; grid-template-rows: 100%; width: 100%; height: 100%; overflow: hidden; background: transparent; }
.dshDesktopSidebarSurface { --dsw-specific-sidebar-fill: transparent; position: relative; grid-column: 1; grid-row: 1; min-width: 0; overflow: hidden; background: transparent; border-right: 1px solid var(--dsw-alias-border-l1); }
.dshDesktopUpstreamSidebar { box-sizing: border-box; width: 100%; height: 100%; }
.dshDesktopFrame[data-desktop-platform="darwin"] .dshDesktopUpstreamSidebar { padding-top: ${MACOS_TITLEBAR_HEIGHT}px; -webkit-app-region: no-drag; }
.dshDesktopFrame[data-desktop-platform="darwin"][data-sidebar-collapsed] .dshDesktopUpstreamSidebar { width: ${SIDEBAR_COLLAPSED}px; margin: 0 auto; }
.dshDesktopFrame[data-desktop-platform="darwin"] { grid-template-rows: ${MACOS_TITLEBAR_HEIGHT}px minmax(0, 1fr); }
.dshDesktopFrame[data-desktop-platform="darwin"] .dshDesktopSidebarSurface { grid-row: 1 / -1; -webkit-app-region: no-drag; }
.dshDesktopFrame[data-desktop-platform="darwin"] .dshDesktopConversationSurface,
.dshDesktopFrame[data-desktop-platform="darwin"] .dshDesktopDetailsSurface { grid-row: 2; }
.dshDesktopFrame[data-desktop-platform="darwin"] .dshDesktopSidebarSurface::before { content: ""; position: absolute; top: 0; right: 0; left: ${MACOS_TRAFFIC_LIGHT_SAFE_WIDTH}px; height: ${MACOS_DRAG_REGION_HEIGHT}px; user-select: none; -webkit-app-region: drag; }
.dshDesktopMacCaptionRow { position: relative; grid-column: 2 / -1; grid-row: 1; min-width: 0; background: var(--dsw-alias-bg-base); }
.dshDesktopMacCaptionRow::before { content: ""; position: absolute; top: 0; right: 0; left: 0; height: ${MACOS_DRAG_REGION_HEIGHT}px; user-select: none; -webkit-app-region: drag; }
.dshDesktopConversationSurface { grid-column: 2; grid-row: 1; min-width: 0; min-height: 0; display: flex; flex-direction: column; overflow: hidden; background: var(--dsw-alias-bg-base); }
.dshDesktopDetailsSurface { grid-column: 3; grid-row: 1; min-width: 0; min-height: 0; overflow: hidden; background: var(--dsw-alias-bg-base); border-left: 1px solid var(--dsw-alias-border-l2); }
.dshDesktopFrame[data-desktop-platform="win32"] { grid-template-rows: ${WINDOWS_TITLEBAR_HEIGHT}px minmax(0, 1fr); }
.dshDesktopFrame[data-desktop-platform="win32"] .dshDesktopSidebarSurface { grid-row: 1 / -1; }
.dshDesktopFrame[data-desktop-platform="win32"] .dshDesktopConversationSurface,
.dshDesktopFrame[data-desktop-platform="win32"] .dshDesktopDetailsSurface { grid-row: 2; }
.dshDesktopWindowsCaptionRow { position: relative; grid-column: 2 / -1; grid-row: 1; min-width: 0; background: var(--dsw-alias-bg-base); }
.dshDesktopWindowsCaptionRow::before { content: ""; position: absolute; inset: 0 ${WINDOWS_CAPTION_CONTROLS_WIDTH}px 0 0; user-select: none; -webkit-app-region: drag; }
.dshDesktopFrame[data-sidebar-collapsed] { transition: grid-template-columns var(--ds-transition-duration-slow) var(--ds-ease-in-out); }
.dshDesktopOverlay { position: absolute; z-index: 1000; inset: 0; pointer-events: none; }
.dshDesktopOverlay > * { pointer-events: auto; }
.dshDesktopResizeHandle { position: absolute; z-index: 50; top: 0; bottom: 0; width: 8px; margin-left: -4px; cursor: col-resize; touch-action: none; -webkit-app-region: no-drag; }
.dshDesktopNoDrag, button, input, textarea, select, a, [role="button"], [role="dialog"], [role="presentation"] { -webkit-app-region: no-drag; }
[role="dialog"], [aria-modal="true"] { -webkit-app-region: no-drag !important; }
html:has([aria-modal="true"]) .dshDesktopWindowsCaptionRow::before,
html:has([aria-modal="true"]) .dshDesktopMacCaptionRow::before,
html:has([aria-modal="true"]) .dshDesktopSidebarSurface,
html:has([aria-modal="true"]) .dshDesktopSidebarSurface::before { -webkit-app-region: no-drag !important; }
@media (prefers-reduced-motion: reduce) { .dshDesktopFrame { transition: none !important; } }
`

function installStylesheet(css: string, pluginCss: string): () => void {
  const style = document.createElement('style')
  style.dataset.plugin = 'dsh-plugin-desktop'
  style.dataset.pluginCss = pluginCss
  style.textContent = css
  document.head.appendChild(style)
  return () => { style.remove() }
}

/** Install and remove the WanCodeNewVer product-brand restyle. @returns the style disposer. */
export function installBrandStyles(): () => void {
  return installStylesheet(WANCODE_BRAND_STYLES, 'dsh-plugin-desktop/brand')
}

/** Install and remove the advanced shell's global native-window styles. @returns the style disposer. */
export function installAdvancedStyles(): () => void {
  return installStylesheet(ADVANCED_SHELL_STYLES, 'dsh-plugin-desktop/advanced-shell')
}
