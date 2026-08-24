import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import {
  WindowsCredentialVault,
  credentialTarget,
  createWindowsCredentialStore,
  migrateLegacyCredentials,
  writeWindowsCredential,
  type CredentialStore,
} from '../src/credentials-win.ts'

class MemoryStore implements CredentialStore {
  readonly values = new Map<string, string>()

  get(target: string): string | undefined {
    return this.values.get(target)
  }

  set(target: string, value: string): void {
    this.values.set(target, value)
  }

  delete(target: string): boolean {
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
    await writeFile(filename, 'DEEPSEEK_API_KEY: secret-one\nOTHER_KEY: secret-two\n')
    const store = new MemoryStore()

    await expect(migrateLegacyCredentials(root, store)).resolves.toBe(2)

    expect([...store.values.values()].sort()).toEqual(['secret-one', 'secret-two'])
    await expect(readFile(filename, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(migrateLegacyCredentials(root, store)).resolves.toBe(0)
  })
})

describe('Windows credential persist fallback', () => {
  it('tries local-machine, enterprise, then session until a write succeeds', () => {
    const attempted: number[] = []
    expect(writeWindowsCredential((persist) => {
      attempted.push(persist)
      return persist === 1
    })).toBe(true)
    expect(attempted).toEqual([2, 3, 1])
  })

  it('reports failure when every persist level is rejected', () => {
    expect(writeWindowsCredential(() => false)).toBe(false)
  })
})

describe('Windows Credential Manager round-trip', () => {
  it.runIf(process.platform === 'win32')('stores and reads a throwaway generic credential', () => {
    const store = createWindowsCredentialStore()
    const target = `WanCodeNewVer/test-${String(process.pid)}-${String(Date.now())}/ROUND_TRIP`
    try {
      store.set(target, 'round-trip-value')
      expect(store.get(target)).toBe('round-trip-value')
    } finally {
      store.delete(target)
    }
    expect(store.get(target)).toBeUndefined()
  })
})
