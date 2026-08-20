/** Wan Code mobile PWA pairing and session projections. This package never listens. */

export {
  projectRelayNotification,
  projectRelaySessionView,
  assertPwaProgressDetail,
  MAX_PWA_PROGRESS_DETAIL_CHARS,
  type RelayNotificationView,
  type RelaySessionView,
} from './session-view.ts'
export {
  createPwaSessionBoard,
  type PwaSessionBoard,
  type PwaSessionSnapshot,
  type PwaSessionStatus,
} from './session-board.ts'
export {
  assertPwaShellOrigin,
  createPwaIndexHtml,
  createPwaPairingScriptSource,
  createPwaServiceWorkerSource,
  createPwaShellFiles,
  createPwaDeployFiles,
  createPwaWebManifest,
  decidePwaCacheAction,
  decidePwaCacheRetention,
  PWA_SHELL_CACHE,
  PWA_SHELL_CSP,
  PWA_SHELL_PATHS,
  type PwaCacheDecision,
  type PwaCacheRetention,
  type PwaWebManifest,
} from './shell.ts'
export {
  createPwaShellIcon,
  createPwaShellIcons,
  PWA_SHELL_ICON_FILES,
  type PwaShellIconSize,
} from './icons.ts'
export {
  createPwaRelayController,
  type CreatePwaRelayControllerInput,
  type PwaRelayController,
  type PwaRelayDesktop,
} from './pairing.ts'
