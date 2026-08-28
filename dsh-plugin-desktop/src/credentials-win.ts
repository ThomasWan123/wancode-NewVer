/** Windows Credential Manager provider for Wancode credential references. */

import { spawn, type ChildProcess, type SpawnOptions } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { readFile, unlink } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Context, Service } from '@deepseek-ai/cordis'
import {
  CredentialProvider,
  type CredentialInfo,
  type CredentialKey,
  type CredentialRecord,
  type CredentialRecordEntry,
  type CredentialRecordInfo,
  type CredentialRef,
  type ResolvedCredential,
} from '@deepseek-ai/dsh-credentials'
import { parseCredentialsDocument } from '@deepseek-ai/dsh-credentials-local'
import {
  launchEnvironmentOf,
  type LaunchEnvironmentEntry,
} from '@deepseek-ai/dsh-launch-environment'
import z from '@deepseek-ai/schemastery'
import { unpackedAsarPath } from './packaged-runtime-path.ts'

const CREDENTIAL_PERSIST_SESSION = 1
const CREDENTIAL_PERSIST_LOCAL_MACHINE = 2
const CREDENTIAL_PERSIST_ENTERPRISE = 3
const ERROR_NOT_FOUND = 1168
const MAX_CREDENTIAL_BLOB_BYTES = 5 * 512
const LEGACY_CREDENTIALS_FILENAME = '.credentials.yaml'

/** Per-persist helper budget so a hung CredWriteW cannot freeze the Electron host. */
export const CREDENTIALS_WIN_HELPER_TIMEOUT_MS = 3000

/** Persist levels tried in order on domain-joined machines. */
export const WINDOWS_CREDENTIAL_PERSIST_TRIES = [
  CREDENTIAL_PERSIST_LOCAL_MACHINE,
  CREDENTIAL_PERSIST_ENTERPRISE,
  CREDENTIAL_PERSIST_SESSION,
] as const

/** Persist levels tried in order on workgroup machines. */
export const WINDOWS_CREDENTIAL_PERSIST_TRIES_WORKGROUP = [
  CREDENTIAL_PERSIST_LOCAL_MACHINE,
  CREDENTIAL_PERSIST_SESSION,
] as const

/** Helper protocol request. Secret `value` is never logged. */
export interface CredentialsWinHelperRequest {
  op: 'get' | 'set' | 'delete'
  target: string
  value?: string
  persist?: number
}

/** Helper protocol reply. `value` is omitted on misses and never logged. */
export interface CredentialsWinHelperResponse {
  ok: boolean
  value?: string
  error?: string
  win32?: number
}

/** Injectable spawn function used by focused helper-isolation tests. */
export type CredentialsWinHelperSpawn = (
  command: string,
  args: readonly string[],
  options: SpawnOptions,
) => ChildProcess

/** Options for one helper invocation. */
export interface CredentialsWinHelperRunOptions {
  execPath?: string
  scriptPath?: string
  env?: NodeJS.ProcessEnv
  timeoutMs?: number
  spawnImpl?: CredentialsWinHelperSpawn
}

/**
 * Workgroup heuristic: USERDOMAIN empty or equal to COMPUTERNAME.
 * @param env - process environment, injectable for tests.
 */
export function isWindowsWorkgroup(env: NodeJS.ProcessEnv = process.env): boolean {
  const userDomain = env.USERDOMAIN ?? ''
  const computerName = env.COMPUTERNAME ?? ''
  return userDomain.length === 0 || userDomain.toUpperCase() === computerName.toUpperCase()
}

/**
 * Persist levels for this Windows membership.
 * Workgroup PCs skip ENTERPRISE, which is rejected or unstable off-domain.
 * @param env - process environment, injectable for tests.
 */
export function windowsCredentialPersistLevels(
  env: NodeJS.ProcessEnv = process.env,
): readonly number[] {
  return isWindowsWorkgroup(env)
    ? WINDOWS_CREDENTIAL_PERSIST_TRIES_WORKGROUP
    : WINDOWS_CREDENTIAL_PERSIST_TRIES
}

/**
 * Attempt a Credential Manager write across persist levels until one succeeds.
 * @param write - returns true when CredWriteW accepted that persist level.
 * @param persistLevels - ordered persist values; defaults to this machine's list.
 * @returns true when any persist level succeeded.
 */
export async function writeWindowsCredential(
  write: (persist: number) => boolean | Promise<boolean>,
  persistLevels: readonly number[] = windowsCredentialPersistLevels(),
): Promise<boolean> {
  for (const persist of persistLevels) {
    if (await write(persist)) return true
  }
  return false
}

/** Resolve the unpackaged helper script next to this module. */
export function credentialsWinHelperPath(moduleUrl: string = import.meta.url): string {
  return unpackedAsarPath(fileURLToPath(new URL('../scripts/credentials-win-helper.mjs', moduleUrl)))
}

/**
 * Run one Credential Manager operation in a short-lived helper process.
 * A hang or AV kills only the helper; the caller receives a thrown JS Error.
 */
export async function runCredentialsWinHelper(
  request: CredentialsWinHelperRequest,
  options: CredentialsWinHelperRunOptions = {},
): Promise<CredentialsWinHelperResponse> {
  const execPath = options.execPath ?? process.execPath
  const scriptPath = options.scriptPath ?? credentialsWinHelperPath()
  const timeoutMs = options.timeoutMs ?? CREDENTIALS_WIN_HELPER_TIMEOUT_MS
  const spawnImpl = options.spawnImpl ?? spawn
  if (!existsSync(scriptPath)) {
    throw new Error(`credentials-win: helper script is missing at ${scriptPath}`)
  }

  const env: NodeJS.ProcessEnv = {
    ...process.env,
    ...options.env,
    ELECTRON_RUN_AS_NODE: '1',
  }

  return await new Promise((resolve, reject) => {
    let stdout = ''
    let stderr = ''
    let settled = false
    const child = spawnImpl(execPath, [scriptPath], {
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    })

    const timer = setTimeout(() => {
      finish(new Error(`credentials-win: helper timed out after ${String(timeoutMs)}ms`))
      terminateHelper(child)
    }, timeoutMs)

    child.stdout?.setEncoding('utf8')
    child.stderr?.setEncoding('utf8')
    child.stdout?.on('data', (chunk: string) => { stdout += chunk })
    child.stderr?.on('data', (chunk: string) => { stderr += chunk })
    child.on('error', (cause: Error) => {
      finish(cause)
      terminateHelper(child)
    })
    child.on('close', (code, signal) => {
      if (stderr.length > 0) process.stderr.write(stderr.endsWith('\n') ? stderr : `${stderr}\n`)
      if (settled) return
      if (code !== 0) {
        finish(new Error(
          `credentials-win: helper exited ${describeHelperExit(code, signal)}`,
        ))
        return
      }
      try {
        settleOk(parseHelperResponse(stdout))
      } catch (cause) {
        finish(cause instanceof Error ? cause : new Error(String(cause)))
      }
    })
    child.stdin?.on('error', () => {
      // Helper may exit before stdin completes (crash); close handler reports it.
    })
    child.stdin?.end(JSON.stringify(request), 'utf8')

    function settleOk(response: CredentialsWinHelperResponse): void {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(response)
    }

    function finish(cause: Error): void {
      if (settled) return
      settled = true
      clearTimeout(timer)
      reject(cause)
    }
  })
}

function terminateHelper(child: ChildProcess): void {
  if (child.exitCode !== null || child.signalCode !== null) return
  child.kill()
}

function describeHelperExit(code: number | null, signal: NodeJS.Signals | null): string {
  if (signal !== null) return `signal ${signal}`
  if (code === null) return 'without a status'
  return `code ${String(code)}`
}

function parseHelperResponse(stdout: string): CredentialsWinHelperResponse {
  const line = stdout.trim()
  if (line.length === 0) {
    throw new Error('credentials-win: helper produced no reply')
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(line)
  } catch {
    throw new Error('credentials-win: helper produced a non-JSON reply')
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('credentials-win: helper produced an invalid reply')
  }
  const body = parsed as {
    ok?: unknown
    value?: unknown
    error?: unknown
    win32?: unknown
  }
  if (typeof body.ok !== 'boolean') {
    throw new Error('credentials-win: helper produced an invalid reply')
  }
  const response: CredentialsWinHelperResponse = { ok: body.ok }
  if (typeof body.value === 'string') response.value = body.value
  if (typeof body.error === 'string') response.error = body.error
  if (typeof body.win32 === 'number') response.win32 = body.win32
  return response
}

function helperFailure(operation: string, target: string, response: CredentialsWinHelperResponse): Error {
  const win32 = response.win32 === undefined ? '' : ` (Win32 ${String(response.win32)})`
  const detail = response.error === undefined || response.error.length === 0
    ? `${operation} failed for ${target}`
    : response.error
  return new Error(`credentials-win: ${detail}${win32}`)
}

/** Minimal secure-store interface used by the provider and focused tests. */
export interface CredentialStore {
  get(target: string): Promise<string | undefined>
  set(target: string, value: string): Promise<void>
  delete(target: string): Promise<boolean>
}

/** Read-only credential layer below the managed Windows store. */
export interface CredentialFallback {
  readonly value: string
  readonly source: string
}

/** Build an opaque per-home target without disclosing the user's path. */
export function credentialTarget(home: string, ref: CredentialRef): string {
  const homeId = createHash('sha256').update(resolve(home).toLowerCase()).digest('hex').slice(0, 24)
  return `WanCodeNewVer/${homeId}/${ref}`
}

/**
 * Credential behavior independent of Cordis and Win32 binding details.
 * Environment wins, then Credential Manager, then project/user dotenv.
 */
export class WindowsCredentialVault {
  constructor(
    private readonly home: string,
    private readonly store: CredentialStore,
    private readonly inherited: (ref: CredentialRef) => string | undefined,
    private readonly fallback: (ref: CredentialRef) => CredentialFallback | undefined,
    private readonly updated: (ref: CredentialRef) => void,
  ) {}

  async resolve(ref: CredentialRef): Promise<ResolvedCredential | undefined> {
    const inherited = this.inherited(ref)
    if (inherited !== undefined && inherited.length > 0) {
      return { value: inherited, source: 'env' }
    }
    const stored = await this.store.get(credentialTarget(this.home, ref))
    if (stored !== undefined && stored.length > 0) {
      return { value: stored, source: 'credential-manager' }
    }
    const fallback = this.fallback(ref)
    return fallback === undefined || fallback.value.length === 0
      ? undefined
      : { value: fallback.value, source: fallback.source }
  }

  async describe(ref: CredentialRef): Promise<CredentialInfo> {
    const inherited = this.inherited(ref)
    if (inherited !== undefined && inherited.length > 0) {
      return { configured: true, source: 'env', writable: false }
    }
    const stored = await this.store.get(credentialTarget(this.home, ref))
    if (stored !== undefined && stored.length > 0) {
      return { configured: true, source: 'credential-manager', writable: true }
    }
    const fallback = this.fallback(ref)
    return fallback === undefined || fallback.value.length === 0
      ? { configured: false, writable: true }
      : { configured: true, source: fallback.source, writable: true }
  }

  async set(ref: CredentialRef, value: string): Promise<void> {
    if (value.length === 0) {
      throw new Error(`credentials-win: an empty value cannot be stored for "${ref}"; use unset`)
    }
    this.assertUnshadowed(ref, 'set')
    await this.store.set(credentialTarget(this.home, ref), value)
    this.updated(ref)
  }

  async unset(ref: CredentialRef): Promise<void> {
    this.assertUnshadowed(ref, 'unset')
    if (await this.store.delete(credentialTarget(this.home, ref))) this.updated(ref)
  }

  private assertUnshadowed(ref: CredentialRef, operation: 'set' | 'unset'): void {
    const inherited = this.inherited(ref)
    if (inherited === undefined || inherited.length === 0) return
    throw new Error(
      `credentials-win: "${ref}" is supplied read-only by the launching environment, so ${operation} would be shadowed`,
    )
  }
}

/** Import the old plaintext file, deleting it only after every secure write succeeds. */
export async function migrateLegacyCredentials(
  home: string,
  store: CredentialStore,
): Promise<number> {
  const filename = join(home, LEGACY_CREDENTIALS_FILENAME)
  let text: string
  try {
    text = await readFile(filename, 'utf8')
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === 'ENOENT') return 0
    throw cause
  }
  const document = parseCredentialsDocument(text, filename)
  for (const [rawRef, value] of document.refs) {
    await store.set(credentialTarget(home, rawRef as CredentialRef), value)
  }
  await unlink(filename)
  return document.refs.size
}

/** Create the production Windows Credential Manager adapter. */
export function createWindowsCredentialStore(
  platform: NodeJS.Platform = process.platform,
): CredentialStore {
  if (platform !== 'win32') {
    throw new Error('credentials-win: Windows Credential Manager is available only on win32')
  }
  productionStore ??= bindWindowsCredentialStore()
  return productionStore
}

let productionStore: CredentialStore | undefined

function bindWindowsCredentialStore(): CredentialStore {
  return {
    async get(target) {
      process.stderr.write('credentials-win: CredReadW begin\n')
      const response = await runCredentialsWinHelper({ op: 'get', target })
      if (!response.ok) throw helperFailure('CredReadW', target, response)
      return response.value !== undefined && response.value.length > 0 ? response.value : undefined
    },
    async set(target, value) {
      const blobBytes = Buffer.byteLength(value, 'utf16le')
      if (blobBytes > MAX_CREDENTIAL_BLOB_BYTES) {
        throw new Error(`credentials-win: credential for ${target} exceeds the Windows generic credential limit`)
      }
      process.stderr.write(`credentials-win: CredWriteW begin blobBytes=${String(blobBytes)}\n`)
      let lastDetail: string | undefined
      const written = await writeWindowsCredential(async (persist) => {
        try {
          const response = await runCredentialsWinHelper({ op: 'set', target, value, persist })
          const win32 = response.win32 ?? (response.ok ? 0 : -1)
          process.stderr.write(
            `credentials-win: CredWriteW persist=${String(persist)} win32=${String(win32)} ok=${response.ok ? '1' : '0'}\n`,
          )
          if (!response.ok) {
            lastDetail = `Win32 ${String(win32)}`
            return false
          }
          return true
        } catch (cause) {
          const detail = cause instanceof Error ? cause.message : String(cause)
          lastDetail = detail
          process.stderr.write(
            `credentials-win: CredWriteW persist=${String(persist)} win32= helper=${detail} ok=0\n`,
          )
          return false
        }
      })
      if (!written) {
        const suffix = lastDetail === undefined ? '' : ` (${lastDetail})`
        throw new Error(`credentials-win: CredWriteW failed for ${target}${suffix}`)
      }
    },
    async delete(target) {
      const response = await runCredentialsWinHelper({ op: 'delete', target })
      if (!response.ok) throw helperFailure('CredDeleteW', target, response)
      if (response.win32 === ERROR_NOT_FOUND || response.value === '0') return false
      return true
    },
  }
}

/** Cordis provider that preserves the upstream credential service contract. */
export class WindowsCredentialProvider extends CredentialProvider {
  static Config: z<Config> = z.object({
    dshHome: z.string().required(),
  })

  private readonly store: CredentialStore
  private readonly vault: WindowsCredentialVault

  constructor(ctx: Context, public config: Config & InternalConfig) {
    super(ctx)
    this.store = config.store ?? createWindowsCredentialStore()
    this.vault = new WindowsCredentialVault(
      config.dshHome,
      this.store,
      ref => this.inherited(ref),
      ref => this.dotenvFallback(ref),
      ref => this.notifyUpdated(ref),
    )
  }

  async* [Service.init](): AsyncGenerator<void, void, void> {
    await migrateLegacyCredentials(this.config.dshHome, this.store)
  }

  override resolve(ref: CredentialRef): Promise<ResolvedCredential | undefined> {
    return this.vault.resolve(ref)
  }

  override describe(ref: CredentialRef): Promise<CredentialInfo> {
    return this.vault.describe(ref)
  }

  override set(ref: CredentialRef, value: string): Promise<void> {
    return this.vault.set(ref, value)
  }

  override unset(ref: CredentialRef): Promise<void> {
    return this.vault.unset(ref)
  }

  override async readRecord(key: CredentialKey): Promise<CredentialRecord | undefined> {
    const target = this.recordTarget(key)
    const raw = await this.store.get(target)
    if (raw === undefined) return undefined
    return JSON.parse(raw) as CredentialRecord
  }

  override async describeRecord(key: CredentialKey): Promise<CredentialRecordInfo> {
    const target = this.recordTarget(key)
    const raw = await this.store.get(target)
    if (raw === undefined) return { configured: false, writable: true }
    const record = JSON.parse(raw) as CredentialRecord
    return { configured: true, kind: record.kind, writable: true }
  }

  override async listRecords(): Promise<readonly CredentialRecordEntry[]> {
    return []
  }

  override async modifyRecord(
    key: CredentialKey,
    mutate: (current: CredentialRecord | undefined) => Promise<CredentialRecord | undefined>,
  ): Promise<CredentialRecord | undefined> {
    const target = this.recordTarget(key)
    const raw = await this.store.get(target)
    const current = raw !== undefined ? JSON.parse(raw) as CredentialRecord : undefined
    const next = await mutate(current)
    if (next === undefined) return current
    await this.store.set(target, JSON.stringify(next))
    return next
  }

  override async deleteRecord(key: CredentialKey): Promise<void> {
    const target = this.recordTarget(key)
    await this.store.delete(target)
  }

  private recordTarget(key: CredentialKey): string {
    const homeId = createHash('sha256').update(resolve(this.config.dshHome).toLowerCase()).digest('hex').slice(0, 24)
    return `WanCodeNewVer/${homeId}/record/${key as string}`
  }

  private inherited(ref: CredentialRef): string | undefined {
    const entry = launchEnvironmentOf(this.ctx).getFrom(ref, ['process'])
    return entry !== undefined && entry.value.length > 0 ? entry.value : undefined
  }

  private dotenvFallback(ref: CredentialRef): LaunchEnvironmentEntry | undefined {
    const entry = launchEnvironmentOf(this.ctx).getFrom(ref, ['project-env', 'user-env'])
    return entry !== undefined && entry.value.length > 0 ? entry : undefined
  }
}

/** Public plugin configuration. */
export interface Config {
  dshHome: string
}

/** Programmatic test seam excluded from Schemastery configuration. */
interface InternalConfig {
  store?: CredentialStore
}

export default WindowsCredentialProvider
