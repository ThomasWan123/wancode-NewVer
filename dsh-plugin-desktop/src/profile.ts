/** Compatibility profile composition over the official Web bundle and user plugins. */

import { createRequire, findPackageJSON } from 'node:module'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { evaluate, isJsExpr, type EntryOptions } from '@deepseek-ai/cordis-plugin-loader'
import type { PatchOptions } from '@deepseek-ai/cordis-plugin-include'
import {
  composeEntries,
  healProfilesModuleFallback,
  initProfile,
  loadOptionalPatches,
  loadOverlayPatches,
  loadProfile,
  PROFILE_PATCH_FILENAME,
  PROFILE_TEMPLATES,
  readProfileManifest,
  resolveProfileDir,
  writeProfileManifest,
  type Profile,
  type ProfileManifest,
} from '@deepseek-ai/dsh-app-boot'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'
import FileSettingsProvider, {
  resolveSpec as resolveSettingsFileSpec,
  type Config as SettingsFileConfig,
} from '@deepseek-ai/dsh-settings-file'
import { parseDocument } from 'yaml'
import { unpackedAsarPath } from './packaged-runtime-path.ts'
import type { DesktopShellMode } from './runtime.ts'
import type { UpdateChannel } from './update-checker.ts'

/** Persistent profile managed by the desktop launcher and the ordinary dsh plugin command. */
export const DESKTOP_PROFILE_NAME = 'desktop'

/** Standalone package name inserted through the launcher-owned desktop layer. */
export const DESKTOP_PACKAGE_NAME = 'dsh-plugin-desktop'

/** Empty include root rewritten before every profile boot. */
export const DESKTOP_PROFILE_ROOT = 'cordis.yml'

const BIN_NAME = DESKTOP_PACKAGE_NAME
const REQUIRED_BUNDLES = requiredWebBundles()
const REQUIRED_BUNDLE_SET = new Set(REQUIRED_BUNDLES)
const INSTALL_ANCHOR = unpackedAsarPath(fileURLToPath(new URL('../package.json', import.meta.url)))
const DESKTOP_PATCH_PATH = fileURLToPath(new URL('../cordis.patch.yml', import.meta.url))
const DIRECTORY_PICKER_ROW_ID = 'directory-picker'
const AUTO_PICKER_PACKAGE = '@deepseek-ai/dsh-host-directory-picker-auto'
const BROWSE_PICKER_BACKEND = '@deepseek-ai/dsh-host-directory-picker-browse'
const BROWSE_PICKER_SURFACE = '@deepseek-ai/dsh-client-ui-directory-picker-browse'
const PWSH_SANDBOX_ROW_ID = 'pwsh-sandbox'
const UPSTREAM_PWSH_SANDBOX_PACKAGE = '@deepseek-ai/dsh-pwsh-sandbox'
const DESKTOP_WINDOWS_PWSH_SANDBOX_ROW_ID = 'desktop-windows-pwsh-sandbox'
const DESKTOP_WINDOWS_PWSH_SANDBOX_PACKAGE = 'dsh-plugin-desktop/windows-pwsh-sandbox'
const CREDENTIALS_ROW_ID = 'credentials'
const UPSTREAM_LOCAL_CREDENTIALS_PACKAGE = '@deepseek-ai/dsh-credentials-local'
const DESKTOP_WINDOWS_CREDENTIALS_ROW_ID = 'desktop-windows-credentials'
const DESKTOP_WINDOWS_CREDENTIALS_PACKAGE = 'dsh-plugin-desktop/credentials-win'
const SANDBOX_POLICY_ROW_ID = 'sandbox-policy'
const APPROVAL_ROW_ID = 'approval'
const PERMISSION_ROW_ID = 'permission'
const DESKTOP_PERMISSION_MODES = ['read-only', 'workspace-write', 'danger-full-access'] as const
const DEFAULT_DESKTOP_PERMISSION_MODE: DesktopPermissionMode = 'read-only'
const DEFAULT_DESKTOP_SHELL_MODE: DesktopShellMode = 'compatibility'
const DEFAULT_UPDATE_CHANNEL: UpdateChannel = 'stable'
const SETTINGS_FILE_PACKAGE = '@deepseek-ai/dsh-settings-file'

/** Sandbox and approval bundle selected for new desktop sessions. */
export type DesktopPermissionMode = typeof DESKTOP_PERMISSION_MODES[number]
const DESKTOP_SETTINGS_NAMESPACE = 'dsh-desktop'
const UI_LAYOUT_PACKAGE = '@deepseek-ai/dsh-client-ui-layout'
const UI_SIDEBAR_PACKAGE = '@deepseek-ai/dsh-client-ui-sidebar'
const UI_CONVERSATION_PACKAGE = '@deepseek-ai/dsh-client-ui-conversation'
const DESKTOP_UPDATES_ROW_ID = 'desktop-updates'

/**
 * Parse desktop presentation state and reject corrupted values.
 * @param value - untrusted settings value.
 * @returns a supported desktop shell mode.
 */
export function parseDesktopShellMode(value: unknown): DesktopShellMode {
  if (value === undefined) return DEFAULT_DESKTOP_SHELL_MODE
  if (value === 'compatibility' || value === 'advanced') return value
  throw new Error(`${BIN_NAME}: ${DESKTOP_SETTINGS_NAMESPACE}.mode must be "compatibility" or "advanced"`)
}

/**
 * Read a desktop mode from one parsed settings document.
 * @param document - untrusted settings document root.
 * @returns the selected mode, defaulting to compatibility when absent.
 */
export function desktopShellModeFromSettings(document: unknown): DesktopShellMode {
  if (typeof document !== 'object' || document === null || Array.isArray(document)) {
    throw new Error(`${BIN_NAME}: settings document must be a map of namespace sections`)
  }
  const section = (document as Record<string, unknown>)[DESKTOP_SETTINGS_NAMESPACE]
  if (section === undefined) return DEFAULT_DESKTOP_SHELL_MODE
  if (typeof section !== 'object' || section === null || Array.isArray(section)) {
    throw new Error(`${BIN_NAME}: ${DESKTOP_SETTINGS_NAMESPACE} settings must be a map`)
  }
  return parseDesktopShellMode((section as Record<string, unknown>).mode)
}

/** Read the selected GitHub release stream from parsed desktop settings. */
export function desktopUpdateChannelFromSettings(document: unknown): UpdateChannel {
  if (typeof document !== 'object' || document === null || Array.isArray(document)) {
    throw new Error(`${BIN_NAME}: settings document must be a map of namespace sections`)
  }
  const section = (document as Record<string, unknown>)[DESKTOP_SETTINGS_NAMESPACE]
  if (section === undefined) return DEFAULT_UPDATE_CHANNEL
  if (typeof section !== 'object' || section === null || Array.isArray(section)) {
    throw new Error(`${BIN_NAME}: ${DESKTOP_SETTINGS_NAMESPACE} settings must be a map`)
  }
  const channel = (section as Record<string, unknown>).updateChannel
  if (channel === undefined) return DEFAULT_UPDATE_CHANNEL
  if (channel === 'stable' || channel === 'beta') return channel
  throw new Error(`${BIN_NAME}: ${DESKTOP_SETTINGS_NAMESPACE}.updateChannel must be "stable" or "beta"`)
}

/**
 * Parse the desktop permission mode and reject unknown values.
 * @param value - inherited `DSH_PERMISSION_MODE` or an explicit test override.
 * @returns a named permission preset used as the composition default.
 */
export function parseDesktopPermissionMode(value: unknown): DesktopPermissionMode {
  if (value === undefined || value === '') return DEFAULT_DESKTOP_PERMISSION_MODE
  if (typeof value === 'string' && (DESKTOP_PERMISSION_MODES as readonly string[]).includes(value)) {
    return value as DesktopPermissionMode
  }
  throw new Error(`${BIN_NAME}: DSH_PERMISSION_MODE must be "read-only", "workspace-write", or "danger-full-access"`)
}

/**
 * Read startup mode from the same file resolved by the settings provider.
 * @param config - validated settings-file row config.
 * @returns the mode projected into the startup Loader graph.
 */
export function readDesktopShellMode(config: SettingsFileConfig): DesktopShellMode {
  return desktopShellModeFromSettings(readDesktopSettingsDocument(config))
}

/** Read the startup update channel from the same settings-provider document. */
export function readDesktopUpdateChannel(config: SettingsFileConfig): UpdateChannel {
  return desktopUpdateChannelFromSettings(readDesktopSettingsDocument(config))
}

/** Parse the settings provider's resolved document once for startup projections. */
function readDesktopSettingsDocument(config: SettingsFileConfig): unknown {
  const spec = resolveSettingsFileSpec(config)
  let text: string
  try {
    text = readFileSync(spec.filename, 'utf8')
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === 'ENOENT') return {}
    throw cause
  }
  if (spec.format === 'yaml') {
    const parsed = parseDocument(text, { prettyErrors: true })
    if (parsed.errors.length > 0) {
      throw new Error(`${BIN_NAME}: invalid settings document at ${spec.filename}: ${parsed.errors.map(error => error.message).join('; ')}`)
    }
    return parsed.toJS() ?? {}
  }
  return text.trim().length === 0 ? {} : JSON.parse(text)
}

/** Resolve the public Web template once and reject an incompatible DSH release. */
function requiredWebBundles(): string[] {
  const bundles = PROFILE_TEMPLATES.web
  if (bundles === undefined) {
    throw new Error(`${BIN_NAME}: installed dsh-app-boot has no web profile template`)
  }
  return [...bundles]
}

/** Prepared profile inputs consumed by app-boot. */
export interface PreparedDesktopProfile {
  /** Harness home shared by the launcher and generated command environment. */
  homeDir: string
  /** Resolved profile and its persistent user layer. */
  profile: Profile
  /** Absolute empty root config included by the Cordis Loader. */
  rootConfig: string
  /** Profile-owned parent URL used to resolve bare Cordis plugin packages. */
  bareModuleBaseUrl: string
  /** Complete ordered patch list for this desktop generation. */
  patches: PatchOptions[]
  /** Optional Client UI entries skipped because this profile cannot resolve them. */
  skippedOptionalEntries: SkippedOptionalEntry[]
  /** Persisted shell mode applied after every user-owned patch. */
  mode: DesktopShellMode
}

/** User patch entry skipped to keep a profile bootable. */
export interface SkippedOptionalEntry {
  /** Loader row id from the skipped entry. */
  id?: string
  /** Package name from the skipped entry. */
  name: string
}

/**
 * Normalize the installation-owned prefix while preserving third-party order.
 * @param current - current persistent bundle list.
 * @returns base, Web carrier, then every third-party bundle in prior order.
 */
export function desktopBundleList(current: readonly string[]): string[] {
  const thirdParty = current.filter(name => !REQUIRED_BUNDLE_SET.has(name) && name !== DESKTOP_PACKAGE_NAME)
  return [...REQUIRED_BUNDLES, ...thirdParty]
}

/** Return whether two ordered string lists are identical. */
function sameList(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index])
}

/**
 * Initialize or repair the persistent desktop profile.
 * @param home - Harness home containing the profiles directory.
 * @returns the absolute profile directory.
 */
export function ensureDesktopProfile(home: string = resolveDshHome()): string {
  const dir = resolveProfileDir(DESKTOP_PROFILE_NAME, home)
  if (!existsSync(join(dir, 'package.json'))) initProfile(dir, REQUIRED_BUNDLES)
  const manifest = readProfileManifest(BIN_NAME, dir)
  const rawBundles = (manifest.dsh?.profile as { bundles?: unknown } | undefined)?.bundles
  if (rawBundles !== undefined
    && (!Array.isArray(rawBundles) || rawBundles.some(value => typeof value !== 'string'))) {
    throw new Error(`${BIN_NAME}: dsh.profile.bundles must be an array of package names`)
  }
  const current = rawBundles === undefined ? [] : rawBundles as string[]
  const bundles = desktopBundleList(current)
  if (!sameList(current, bundles)) {
    writeProfileManifest(dir, {
      ...manifest,
      dsh: {
        ...manifest.dsh,
        profile: {
          ...manifest.dsh?.profile,
          bundles,
        },
      },
    })
  }
  return dir
}

/** Resolve the agent presets shipped by the matching dsh CLI dependency. */
function shippedPresetRoot(): string {
  const require = createRequire(import.meta.url)
  return join(dirname(require.resolve('@deepseek-ai/dsh/package.json')), 'config', 'agent-presets')
}

/** Read a row's object config without trusting arbitrary YAML values. */
function rowConfig(row: EntryOptions | undefined): Record<string, unknown> {
  const config = row?.config
  return config !== null && typeof config === 'object' && !Array.isArray(config)
    ? config as Record<string, unknown>
    : {}
}

/** Resolve a Loader row's platform gate without mutating the host process. */
function rowDisabledOnPlatform(row: EntryOptions, platform: NodeJS.Platform): boolean {
  if (!isJsExpr(row.disabled)) return row.disabled === true
  const scopedProcess = new Proxy(process, {
    get(target, property) {
      if (property === 'platform') return platform
      const value = Reflect.get(target, property, target)
      return typeof value === 'function' ? value.bind(target) : value
    },
  })
  return Boolean(evaluate({ process: scopedProcess }, row.disabled.__jsExpr))
}

/** Find one package manifest using the selected profile's dependency graph. */
function packageManifestFromProfile(name: string, profilePackageUrl: string): string | undefined {
  try {
    return findPackageJSON(name, profilePackageUrl)
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === 'ERR_MODULE_NOT_FOUND') return undefined
    throw cause
  }
}

/** Return whether a Loader specifier names an npm package. */
function isBarePackageSpecifier(name: string): boolean {
  return !name.startsWith('.')
    && !name.startsWith('/')
    && !name.startsWith('#')
    && !URL.canParse(name)
}

/** Return whether a package is a user-facing Client UI extension, not a Host provider. */
function isOptionalClientPackage(name: string): boolean {
  return /^(@[^/]+\/)?dsh-client-ui-/u.test(name)
}

/** Drop unresolved optional Client UI rows from the machine-wide patch only. */
function omitUnresolvedOptionalEntries(
  patches: PatchOptions[],
  profilePackageUrl: string,
): { patches: PatchOptions[], skipped: SkippedOptionalEntry[] } {
  const skipped: SkippedOptionalEntry[] = []

  const filterRows = (rows: EntryOptions[]): EntryOptions[] => {
    const filtered: EntryOptions[] = []
    for (const row of rows) {
      if (typeof row.name === 'string'
        && isBarePackageSpecifier(row.name)
        && isOptionalClientPackage(row.name)
        && packageManifestFromProfile(row.name, profilePackageUrl) === undefined) {
        skipped.push({
          ...(typeof row.id === 'string' ? { id: row.id } : {}),
          name: row.name,
        })
        continue
      }
      const config = row.group === true && Array.isArray(row.config) ? filterRows(row.config) : undefined
      filtered.push(config === undefined ? row : { ...row, config })
    }
    return filtered
  }

  return {
    patches: patches.flatMap((patch) => {
      if (!Array.isArray(patch.insert)) return [patch]
      const insert = filterRows(patch.insert)
      return [{ ...patch, insert }]
    }),
    skipped,
  }
}

/**
 * Load and compose one desktop profile generation.
 * @param telemetryDisabled - inherited DSH telemetry opt-out value.
 * @param home - Harness home containing profiles and the machine-wide patch.
 * @param platform - native platform selecting launcher-owned safety overlays.
 * @param profileName - existing or lazily available Web profile to compose.
 * @param permissionMode - inherited permission mode; empty selects read-only.
 * @returns root config, profile metadata, and ordered patches.
 */
export function prepareDesktopProfile(
  telemetryDisabled: string | undefined = process.env.DSH_TELEMETRY_DISABLED,
  home: string = resolveDshHome(),
  platform: NodeJS.Platform = process.platform,
  profileName: string = DESKTOP_PROFILE_NAME,
  permissionMode: string | undefined = process.env.DSH_PERMISSION_MODE,
): PreparedDesktopProfile {
  const profileDir = profileName === DESKTOP_PROFILE_NAME
    ? ensureDesktopProfile(home)
    : resolveProfileDir(profileName, home)
  healProfilesModuleFallback(INSTALL_ANCHOR, home)
  const profile = loadProfile(BIN_NAME, profileName, INSTALL_ANCHOR, home)
  const rootConfig = join(profileDir, DESKTOP_PROFILE_ROOT)
  const bareModuleBaseUrl = pathToFileURL(join(profile.dir, 'package.json')).href
  writeFileSync(rootConfig, '[]\n')

  const desktopPatches = loadOverlayPatches(BIN_NAME, DESKTOP_PATCH_PATH)
  const bundlePatches: PatchOptions[] = []
  let desktopLayerInserted = false
  for (const layer of profile.layers) {
    bundlePatches.push(...layer.patches)
    if (layer.packageName !== '@deepseek-ai/dsh-web-app') continue
    bundlePatches.push(...desktopPatches)
    desktopLayerInserted = true
  }
  if (!desktopLayerInserted) {
    throw new Error(`${BIN_NAME}: desktop profile is missing @deepseek-ai/dsh-web-app`)
  }

  const loadedHomePatches = loadOptionalPatches(BIN_NAME, join(home, PROFILE_PATCH_FILENAME)) ?? []
  const { patches: homePatches, skipped: skippedOptionalEntries } = omitUnresolvedOptionalEntries(
    loadedHomePatches,
    bareModuleBaseUrl,
  )
  const patches: PatchOptions[] = [
    ...bundlePatches,
    ...profile.patches,
    ...homePatches,
  ]
  const rows = new Map<string, EntryOptions>()
  for (const row of composeEntries([patches])) {
    if (typeof row.id === 'string') rows.set(row.id, row)
  }
  const settings = rows.get('settings')
  if (settings?.name !== SETTINGS_FILE_PACKAGE) {
    throw new Error(`${BIN_NAME}: desktop profile must use ${SETTINGS_FILE_PACKAGE} in the settings row`)
  }
  const settingsConfig = FileSettingsProvider.Config({
    dshHome: home,
    ...rowConfig(settings),
  } as SettingsFileConfig)
  const desktopSettingsDocument = readDesktopSettingsDocument(settingsConfig)
  const mode = desktopShellModeFromSettings(desktopSettingsDocument)
  const updateChannel = desktopUpdateChannelFromSettings(desktopSettingsDocument)
  const resolvedPermission = parseDesktopPermissionMode(permissionMode)
  patches.push({
    id: 'settings',
    config: settingsConfig,
  })
  if (!rows.has(DESKTOP_UPDATES_ROW_ID)) {
    throw new Error(`${BIN_NAME}: desktop profile has no ${DESKTOP_UPDATES_ROW_ID} row`)
  }
  patches.push({
    id: DESKTOP_UPDATES_ROW_ID,
    config: {
      ...rowConfig(rows.get(DESKTOP_UPDATES_ROW_ID)!),
      channel: updateChannel,
    },
  })
  const sandboxPolicy = rows.get(SANDBOX_POLICY_ROW_ID)
  if (sandboxPolicy === undefined) {
    throw new Error(`${BIN_NAME}: desktop profile has no ${SANDBOX_POLICY_ROW_ID} row`)
  }
  const approval = rows.get(APPROVAL_ROW_ID)
  if (approval === undefined) {
    throw new Error(`${BIN_NAME}: desktop profile has no ${APPROVAL_ROW_ID} row`)
  }
  const permission = rows.get(PERMISSION_ROW_ID)
  if (permission === undefined) {
    throw new Error(`${BIN_NAME}: desktop profile has no ${PERMISSION_ROW_ID} row`)
  }
  patches.push(
    {
      id: SANDBOX_POLICY_ROW_ID,
      config: {
        ...rowConfig(sandboxPolicy),
        mode: resolvedPermission,
      },
    },
    {
      id: APPROVAL_ROW_ID,
      config: {
        ...rowConfig(approval),
        policy: resolvedPermission === 'danger-full-access' ? 'never' : 'ask',
      },
    },
    {
      id: PERMISSION_ROW_ID,
      config: {
        ...rowConfig(permission),
        defaultPreset: resolvedPermission,
      },
    },
  )
  if (mode === 'advanced') {
    for (const [id, packageName] of [
      ['ui-layout', UI_LAYOUT_PACKAGE],
      ['ui-sidebar', UI_SIDEBAR_PACKAGE],
      ['ui-conversation', UI_CONVERSATION_PACKAGE],
    ] as const) {
      if (rows.get(id)?.name !== packageName) {
        throw new Error(`${BIN_NAME}: advanced desktop mode must use ${packageName} in the ${id} row`)
      }
    }
    patches.push(
      { id: 'ui-layout', disabled: true },
      { id: 'ui-sidebar', disabled: false },
      { id: 'ui-conversation', disabled: false },
    )
  }
  const presets = rows.get('agent-presets')
  if (presets !== undefined) {
    patches.push({
      id: 'agent-presets',
      config: {
        ...rowConfig(presets),
        roots: [{ path: shippedPresetRoot(), trust: 'system' }],
      },
    })
  }
  if (!rows.has('webserver')) {
    throw new Error(`${BIN_NAME}: desktop profile has no webserver row`)
  }
  if (platform === 'win32') {
    if (!rows.has(DIRECTORY_PICKER_ROW_ID)) {
      throw new Error(`${BIN_NAME}: desktop profile has no directory-picker row`)
    }
    patches.push(
      {
        id: DIRECTORY_PICKER_ROW_ID,
        name: AUTO_PICKER_PACKAGE,
        disabled: true,
      },
      {
        insert: [
          {
            id: 'desktop-directory-picker-browse-host',
            name: BROWSE_PICKER_BACKEND,
          },
          {
            id: 'desktop-directory-picker-browse-surface',
            name: BROWSE_PICKER_SURFACE,
          },
        ],
      },
    )
    const pwshSandbox = rows.get(PWSH_SANDBOX_ROW_ID)
    if (pwshSandbox?.name === UPSTREAM_PWSH_SANDBOX_PACKAGE
      && !rowDisabledOnPlatform(pwshSandbox, platform)) {
      patches.push(
        {
          id: PWSH_SANDBOX_ROW_ID,
          name: UPSTREAM_PWSH_SANDBOX_PACKAGE,
          disabled: true,
        },
        {
          insert: [
            {
              id: DESKTOP_WINDOWS_PWSH_SANDBOX_ROW_ID,
              name: DESKTOP_WINDOWS_PWSH_SANDBOX_PACKAGE,
              ...(pwshSandbox.disabled === undefined ? {} : { disabled: pwshSandbox.disabled }),
              config: rowConfig(pwshSandbox),
            },
          ],
        },
      )
    }
    const credentials = rows.get(CREDENTIALS_ROW_ID)
    if (credentials?.name === UPSTREAM_LOCAL_CREDENTIALS_PACKAGE
      && !rowDisabledOnPlatform(credentials, platform)) {
      patches.push(
        {
          id: CREDENTIALS_ROW_ID,
          name: UPSTREAM_LOCAL_CREDENTIALS_PACKAGE,
          disabled: true,
        },
        {
          insert: [
            {
              id: DESKTOP_WINDOWS_CREDENTIALS_ROW_ID,
              name: DESKTOP_WINDOWS_CREDENTIALS_PACKAGE,
              config: { dshHome: home },
            },
          ],
        },
      )
    }
  }
  // Loopback-only binding is a launcher security invariant, not user config.
  patches.push({
    id: 'webserver',
    disabled: false,
    config: { host: '127.0.0.1', port: 0 },
  })
  if ((telemetryDisabled ?? '') !== '' && rows.has('session-telemetry-otel')) {
    patches.push({ id: 'session-telemetry-otel', disabled: true })
  }
  const desktopShell = rows.get('desktop-shell')
  if (desktopShell === undefined) {
    throw new Error(`${BIN_NAME}: desktop profile has no desktop-shell row`)
  }
  patches.push({
    id: 'desktop-shell',
    disabled: false,
    config: {
      ...rowConfig(desktopShell),
      mode,
      updateChannel,
    },
  })
  return {
    homeDir: home,
    profile,
    rootConfig,
    bareModuleBaseUrl,
    patches: structuredClone(patches),
    skippedOptionalEntries,
    mode,
  }
}

/** Expose the package anchor for focused resolution tests. */
export function desktopInstallAnchor(): string {
  return INSTALL_ANCHOR
}

/** Preserve the public manifest type in the declaration graph used by plugin tooling. */
export type DesktopProfileManifest = ProfileManifest
