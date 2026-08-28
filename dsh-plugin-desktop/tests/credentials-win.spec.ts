import { existsSync } from 'node:fs'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import {
  CREDENTIALS_WIN_HELPER_TIMEOUT_MS,
  WINDOWS_CREDENTIAL_PERSIST_TRIES,
  WINDOWS_CREDENTIAL_PERSIST_TRIES_WORKGROUP,
  WindowsCredentialVault,
  credentialTarget,
  createWindowsCredentialStore,
  credentialsWinHelperPath,
  isWindowsWorkgroup,
  migrateLegacyCredentials,
  runCredentialsWinHelper,
  windowsCredentialPersistLevels,
  writeWindowsCredential,
  type CredentialStore,
} from '../src/credentials-win.ts'

class MemoryStore implements CredentialStore {
  readonly values = new Map<string, string>()

  async get(target: string): Promise<string | undefined> {
    return this.values.get(target)
  }

  async set(target: string, value: string): Promise<void> {
    this.values.set(target, value)
  }

  async delete(target: string): Promise<boolean> {
    return this.values.delete(target)
  }
}

const temporaryRoots: string[] = []

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

describe('Windows credential vault', () => {
  it('uses an opaque, home-scoped Credential Manager target', () => {
    const first = credentialTarget('C:\\Users\\A\\Wancode\\harness', credentialRef('DEEPSEEK_API_KEY'))
    const second = credentialTarget('D:\\Portable\\Wancode\\harness', credentialRef('DEEPSEEK_API_KEY'))

    expect(first).toMatch(/^WanCodeNewVer\/[a-f0-9]{24}\/DEEPSEEK_API_KEY$/u)
    expect(second).not.toBe(first)
    expect(first).not.toContain('Users')
  })

  it('preserves environment precedence and writes through the secure store', async () => {
    const store = new MemoryStore()
    const updated = vi.fn()
    const inherited = new Map([['ENV_KEY', 'from-process']])
    const fallbacks = new Map([
      ['PROJECT_KEY', { value: 'from-project', source: 'project-env' }],
    ])
    const vault = new WindowsCredentialVault(
      'C:\\Wancode\\harness',
      store,
      ref => inherited.get(ref),
      ref => fallbacks.get(ref),
      updated,
    )

    await expect(vault.resolve(credentialRef('ENV_KEY'))).resolves.toEqual({
      value: 'from-process',
      source: 'env',
    })
    await expect(vault.describe(credentialRef('ENV_KEY'))).resolves.toEqual({
      configured: true,
      source: 'env',
      writable: false,
    })
    await expect(vault.set(credentialRef('ENV_KEY'), 'shadowed')).rejects.toThrow('read-only')

    await expect(vault.resolve(credentialRef('PROJECT_KEY'))).resolves.toEqual({
      value: 'from-project',
      source: 'project-env',
    })
    await vault.set(credentialRef('PROJECT_KEY'), 'managed')
    await expect(vault.resolve(credentialRef('PROJECT_KEY'))).resolves.toEqual({
      value: 'managed',
      source: 'credential-manager',
    })
    expect(updated).toHaveBeenCalledWith(credentialRef('PROJECT_KEY'))

    await expect(vault.set(credentialRef('EMPTY_KEY'), '')).rejects.toThrow('empty')
    await vault.unset(credentialRef('PROJECT_KEY'))
    await expect(vault.resolve(credentialRef('PROJECT_KEY'))).resolves.toEqual({
      value: 'from-project',
      source: 'project-env',
    })
  })

  it('imports and removes a legacy plaintext credential document only after all writes succeed', async () => {
    const root = await mkdtemp(join(tmpdir(), 'wancode-credentials-'))
    temporaryRoots.push(root)
    const filename = join(root, '.credentials.yaml')
    await writeFile(filename, 'version: 1\nrefs:\n  DEEPSEEK_API_KEY: secret-one\n  OTHER_KEY: secret-two\n')
    const store = new MemoryStore()

    await expect(migrateLegacyCredentials(root, store)).resolves.toBe(2)

    expect([...store.values.values()].sort()).toEqual(['secret-one', 'secret-two'])
    await expect(readFile(filename, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(migrateLegacyCredentials(root, store)).resolves.toBe(0)
  })
})

describe('Windows credential persist fallback', () => {
  it('tries local-machine, enterprise, then session until a write succeeds', async () => {
    const attempted: number[] = []
    await expect(writeWindowsCredential((persist) => {
      attempted.push(persist)
      return persist === 1
    }, WINDOWS_CREDENTIAL_PERSIST_TRIES)).resolves.toBe(true)
    expect(attempted).toEqual([2, 3, 1])
  })

  it('reports failure when every persist level is rejected', async () => {
    await expect(writeWindowsCredential(() => false, WINDOWS_CREDENTIAL_PERSIST_TRIES)).resolves.toBe(false)
  })

  it('skips ENTERPRISE persist on a workgroup PC', () => {
    expect(isWindowsWorkgroup({ USERDOMAIN: 'HMM1560049-IT', COMPUTERNAME: 'HMM1560049-IT' })).toBe(true)
    expect(isWindowsWorkgroup({ USERDOMAIN: '', COMPUTERNAME: 'PC' })).toBe(true)
    expect(isWindowsWorkgroup({ USERDOMAIN: 'pc', COMPUTERNAME: 'PC' })).toBe(true)
    expect(windowsCredentialPersistLevels({
      USERDOMAIN: 'HMM1560049-IT',
      COMPUTERNAME: 'HMM1560049-IT',
    })).toEqual([...WINDOWS_CREDENTIAL_PERSIST_TRIES_WORKGROUP])
    expect(WINDOWS_CREDENTIAL_PERSIST_TRIES_WORKGROUP).toEqual([2, 1])
  })

  it('keeps ENTERPRISE persist when domain-joined', () => {
    expect(isWindowsWorkgroup({ USERDOMAIN: 'CORP', COMPUTERNAME: 'PC' })).toBe(false)
    expect(windowsCredentialPersistLevels({
      USERDOMAIN: 'CORP',
      COMPUTERNAME: 'PC',
    })).toEqual([...WINDOWS_CREDENTIAL_PERSIST_TRIES])
  })

  it('tries local-machine then session on a workgroup until a write succeeds', async () => {
    const attempted: number[] = []
    await expect(writeWindowsCredential((persist) => {
      attempted.push(persist)
      return persist === 1
    }, windowsCredentialPersistLevels({
      USERDOMAIN: 'WORKSTATION',
      COMPUTERNAME: 'WORKSTATION',
    }))).resolves.toBe(true)
    expect(attempted).toEqual([2, 1])
  })
})

describe('Windows credential helper isolation', () => {
  it('resolves the helper beside the package scripts directory', () => {
    const filename = credentialsWinHelperPath()
    expect(filename).toMatch(/credentials-win-helper\.mjs$/u)
    expect(existsSync(filename)).toBe(true)
    expect(CREDENTIALS_WIN_HELPER_TIMEOUT_MS).toBe(3000)
  })

  it('returns a JS error when the helper times out without taking down the parent', async () => {
    const root = await mkdtemp(join(tmpdir(), 'wancode-cred-helper-'))
    temporaryRoots.push(root)
    const script = join(root, 'hang.mjs')
    await writeFile(script, 'setInterval(() => {}, 1000)\n')
    let ticks = 0
    const timer = setInterval(() => {
      ticks += 1
    }, 20)
    try {
      await expect(runCredentialsWinHelper(
        { op: 'get', target: 'WanCodeNewVer/isolation-timeout' },
        { scriptPath: script, timeoutMs: 150 },
      )).rejects.toThrow(/timed out/u)
      expect(ticks).toBeGreaterThan(0)
      expect(process.pid).toBeGreaterThan(0)
    } finally {
      clearInterval(timer)
    }
  })

  it('returns a JS error when the helper crashes without taking down the parent', async () => {
    const root = await mkdtemp(join(tmpdir(), 'wancode-cred-helper-'))
    temporaryRoots.push(root)
    const script = join(root, 'crash.mjs')
    await writeFile(script, 'process.exit(37)\n')
    await expect(runCredentialsWinHelper(
      { op: 'set', target: 'WanCodeNewVer/isolation-crash', value: 'unused', persist: 2 },
      { scriptPath: script, timeoutMs: 2000 },
    )).rejects.toThrow(/helper exited code 37/u)
    expect(process.pid).toBeGreaterThan(0)
  })
})

describe('Windows Credential Manager round-trip', () => {
  it.runIf(process.platform === 'win32')('stores and reads a throwaway generic credential', async () => {
    const store = createWindowsCredentialStore()
    const target = `WanCodeNewVer/test-${String(process.pid)}-${String(Date.now())}/ROUND_TRIP`
    try {
      await store.set(target, 'round-trip-value')
      await expect(store.get(target)).resolves.toBe('round-trip-value')
    } finally {
      await store.delete(target)
    }
    await expect(store.get(target)).resolves.toBeUndefined()
  })
})
