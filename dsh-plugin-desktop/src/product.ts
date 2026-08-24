import { join } from 'node:path'

/** Stable native identity for the WanCodeNewVer desktop product. */
export const WANCODE_PRODUCT_NAME = 'WanCodeNewVer'

/** Window title shown by compatibility and advanced presentation modes. */
export const WANCODE_WINDOW_TITLE = WANCODE_PRODUCT_NAME

/** Windows AppUserModelId and Electron Builder application identifier. */
export const WANCODE_APP_ID = 'com.wancode.desktop'

/**
 * Keep Wancode profile and session data separate from an existing CLI install.
 * An explicit non-blank DSH_HOME remains an opt-in shared-home override.
 */
export function configureWancodeHarnessHome(
  userDataPath: string,
  environment: Record<string, string | undefined>,
): string {
  const configured = environment.DSH_HOME
  if (configured !== undefined && configured.trim().length > 0) return configured
  const home = join(userDataPath, 'harness')
  environment.DSH_HOME = home
  return home
}

/**
 * Default upstream telemetry to disabled for the Wancode distribution.
 * A defined value, including the empty opt-in value, remains user-owned.
 */
export function configureWancodeTelemetry(
  environment: Record<string, string | undefined>,
): void {
  if (environment.DSH_TELEMETRY_DISABLED === undefined) {
    environment.DSH_TELEMETRY_DISABLED = '1'
  }
}
