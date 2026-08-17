/** Windows Credential Manager provider for Wancode credential references. */

import { createHash } from 'node:crypto'
import { readFile, unlink } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { Context, Service } from '@deepseek-ai/cordis'
import {
  CredentialProvider,
  type CredentialInfo,
  type CredentialRef,
  type ResolvedCredential,
} from '@deepseek-ai/dsh-credentials'
import { parseCredentialsDocument } from '@deepseek-ai/dsh-credentials-local'
import {
  launchEnvironmentOf,
  type LaunchEnvironmentEntry,
} from '@deepseek-ai/dsh-launch-environment'
import z from '@deepseek-ai/schemastery'
import koffi from 'koffi'

const CREDENTIAL_TYPE_GENERIC = 1
const CREDENTIAL_PERSIST_LOCAL_MACHINE = 2
const ERROR_NOT_FOUND = 1168
const MAX_CREDENTIAL_BLOB_BYTES = 5 * 512
const LEGACY_CREDENTIALS_FILENAME = '.credentials.yaml'

/** Minimal secure-store interface used by the provider and focused tests. */
export interface CredentialStore {
  get(target: string): string | undefined
  set(target: string, value: string): void
  delete(target: string): boolean
}

/** Read-only credential layer below the managed Windows store. */
export interface CredentialFallback {
  readonly value: string
  readonly source: string
}

/** Build an opaque per-home target without disclosing the user's path. */
export function credentialTarget(home: string, ref: CredentialRef): string {
  const homeId = createHash('sha256').update(resolve(home).toLowerCase()).digest('hex').slice(0, 24)
  return `Wancode NewVer/${homeId}/${ref}`
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
    const stored = this.store.get(credentialTarget(this.home, ref))
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
    const stored = this.store.get(credentialTarget(this.home, ref))
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
    this.store.set(credentialTarget(this.home, ref), value)
    this.updated(ref)
  }

  async unset(ref: CredentialRef): Promise<void> {
    this.assertUnshadowed(ref, 'unset')
    if (this.store.delete(credentialTarget(this.home, ref))) this.updated(ref)
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
  const entries = parseCredentialsDocument(text, filename)
  for (const [rawRef, value] of entries) {
    store.set(credentialTarget(home, rawRef as CredentialRef), value)
  }
  await unlink(filename)
  return entries.size
}

/** Create the production Windows Credential Manager adapter. */
export function createWindowsCredentialStore(
  platform: NodeJS.Platform = process.platform,
): CredentialStore {
  if (platform !== 'win32') {
    throw new Error('credentials-win: Windows Credential Manager is available only on win32')
  }

  const FILETIME = koffi.struct('WANCODE_FILETIME', {
    dwLowDateTime: 'uint32',
    dwHighDateTime: 'uint32',
  })
  const CREDENTIALW = koffi.struct('WANCODE_CREDENTIALW', {
    Flags: 'uint32',
    Type: 'uint32',
    TargetName: 'str16',
    Comment: 'str16',
    LastWritten: FILETIME,
    CredentialBlobSize: 'uint32',
    CredentialBlob: koffi.pointer('uint8'),
    Persist: 'uint32',
    AttributeCount: 'uint32',
    Attributes: koffi.pointer('void'),
    TargetAlias: 'str16',
    UserName: 'str16',
  })
  const advapi32 = koffi.load('advapi32.dll')
  const kernel32 = koffi.load('kernel32.dll')
  const credRead = advapi32.func(
    'int __stdcall CredReadW(str16 target, uint32 type, uint32 flags, _Out_ WANCODE_CREDENTIALW **credential)',
  )
  const credWrite = advapi32.func(
    'int __stdcall CredWriteW(const WANCODE_CREDENTIALW *credential, uint32 flags)',
  )
  const credDelete = advapi32.func(
    'int __stdcall CredDeleteW(str16 target, uint32 type, uint32 flags)',
  )
  const credFree = advapi32.func('void __stdcall CredFree(void *buffer)')
  const getLastError = kernel32.func('uint32 __stdcall GetLastError()')

  const failure = (operation: string, target: string): Error =>
    new Error(`credentials-win: ${operation} failed for ${target} (Win32 ${String(getLastError())})`)

  return {
    get(target) {
      const out: unknown[] = [null]
      if (credRead(target, CREDENTIAL_TYPE_GENERIC, 0, out) === 0) {
        if (getLastError() === ERROR_NOT_FOUND) return undefined
        throw failure('CredReadW', target)
      }
      const pointer = out[0]
      try {
        const credential = koffi.decode(pointer, CREDENTIALW) as {
          CredentialBlobSize: number
          CredentialBlob: unknown
        }
        if (credential.CredentialBlobSize === 0) return undefined
        const bytes = Buffer.from(
          koffi.view(credential.CredentialBlob, credential.CredentialBlobSize),
        )
        const value = bytes.toString('utf16le')
        return value.length === 0 ? undefined : value
      } finally {
        credFree(pointer)
      }
    },
    set(target, value) {
      const blob = Buffer.from(value, 'utf16le')
      if (blob.byteLength > MAX_CREDENTIAL_BLOB_BYTES) {
        throw new Error(`credentials-win: credential for ${target} exceeds the Windows generic credential limit`)
      }
      const written = credWrite({
        Flags: 0,
        Type: CREDENTIAL_TYPE_GENERIC,
        TargetName: target,
        Comment: null,
        LastWritten: { dwLowDateTime: 0, dwHighDateTime: 0 },
        CredentialBlobSize: blob.byteLength,
        CredentialBlob: blob,
        Persist: CREDENTIAL_PERSIST_LOCAL_MACHINE,
        AttributeCount: 0,
        Attributes: null,
        TargetAlias: null,
        UserName: 'Wancode NewVer',
      }, 0)
      if (written === 0) throw failure('CredWriteW', target)
    },
    delete(target) {
      if (credDelete(target, CREDENTIAL_TYPE_GENERIC, 0) !== 0) return true
      if (getLastError() === ERROR_NOT_FOUND) return false
      throw failure('CredDeleteW', target)
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
