import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { maybeImportLegacyHarnessHome } from '../src/home-migration.ts'

const homes: string[] = []

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-home-migration-'))
  homes.push(root)
  return root
}

afterEach(async () => {
  for (const home of homes.splice(0)) {
    await rm(home, { recursive: true, force: true })
  }
})

describe('legacy Harness home import', () => {
  it('copies settings, sessions, and credentials from ~/.dsh after confirmation', async () => {
    const root = await temporaryRoot()
    const sourceHome = join(root, '.dsh')
    const destinationHome = join(root, 'harness')
    const userDataPath = join(root, 'user-data')
    await mkdir(join(sourceHome, 'sessions'), { recursive: true })
    await mkdir(join(sourceHome, 'profiles', 'web', 'node_modules', 'left-behind'), { recursive: true })
    await writeFile(join(sourceHome, 'settings.yaml'), 'ui-theme:\n  preference: dark\n', { mode: 0o600 })
    await writeFile(join(sourceHome, '.credentials.yaml'), 'DEEPSEEK_API_KEY: secret\n', { mode: 0o600 })
    await writeFile(join(sourceHome, 'sessions', 'one.json'), '{"id":"one"}\n')
    await writeFile(join(sourceHome, 'profiles', 'web', 'package.json'), '{"name":"web"}\n')
    await writeFile(join(sourceHome, 'profiles', 'web', 'node_modules', 'left-behind', 'index.js'), 'export {}\n')
    const confirm = vi.fn(async () => true)

    await expect(maybeImportLegacyHarnessHome({
      userDataPath,
      destinationHome,
      sourceHome,
      explicitHome: false,
      confirm,
    })).resolves.toBe('imported')

    expect(confirm).toHaveBeenCalledWith('~/.dsh')
    expect(await readFile(join(destinationHome, 'settings.yaml'), 'utf8')).toBe('ui-theme:\n  preference: dark\n')
    expect(await readFile(join(destinationHome, '.credentials.yaml'), 'utf8')).toBe('DEEPSEEK_API_KEY: secret\n')
    expect(await readFile(join(destinationHome, 'sessions', 'one.json'), 'utf8')).toBe('{"id":"one"}\n')
    expect(await readFile(join(destinationHome, 'profiles', 'web', 'package.json'), 'utf8')).toBe('{"name":"web"}\n')
    await expect(readFile(join(destinationHome, 'profiles', 'web', 'node_modules', 'left-behind', 'index.js')))
      .rejects.toMatchObject({ code: 'ENOENT' })
    expect(await readFile(join(sourceHome, 'settings.yaml'), 'utf8')).toBe('ui-theme:\n  preference: dark\n')
  })

  it('does not import when the user starts fresh, and does not ask again', async () => {
    const root = await temporaryRoot()
    const sourceHome = join(root, '.dsh')
    const destinationHome = join(root, 'harness')
    const userDataPath = join(root, 'user-data')
    await mkdir(sourceHome)
    await writeFile(join(sourceHome, 'settings.yaml'), 'ui-theme: {}\n')
    const confirm = vi.fn(async () => false)

    await expect(maybeImportLegacyHarnessHome({
      userDataPath,
      destinationHome,
      sourceHome,
      explicitHome: false,
      confirm,
    })).resolves.toBe('declined')
    await expect(maybeImportLegacyHarnessHome({
      userDataPath,
      destinationHome,
      sourceHome,
      explicitHome: false,
      confirm,
    })).resolves.toBe('skipped')

    expect(confirm).toHaveBeenCalledOnce()
    await expect(readFile(join(destinationHome, 'settings.yaml'))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('does not offer an import when DSH_HOME already selects a shared home', async () => {
    const root = await temporaryRoot()
    const sourceHome = join(root, '.dsh')
    await mkdir(sourceHome)
    await writeFile(join(sourceHome, 'settings.yaml'), 'ui-theme: {}\n')
    const confirm = vi.fn(async () => true)

    await expect(maybeImportLegacyHarnessHome({
      userDataPath: join(root, 'user-data'),
      destinationHome: join(root, 'harness'),
      sourceHome,
      explicitHome: true,
      confirm,
    })).resolves.toBe('skipped')
    expect(confirm).not.toHaveBeenCalled()
  })

  it('does not overwrite a Wan Code home that already has user data', async () => {
    const root = await temporaryRoot()
    const sourceHome = join(root, '.dsh')
    const destinationHome = join(root, 'harness')
    await mkdir(sourceHome)
    await mkdir(destinationHome)
    await writeFile(join(sourceHome, 'settings.yaml'), 'from: source\n')
    await writeFile(join(destinationHome, 'settings.yaml'), 'from: dest\n')
    const confirm = vi.fn(async () => true)

    await expect(maybeImportLegacyHarnessHome({
      userDataPath: join(root, 'user-data'),
      destinationHome,
      sourceHome,
      explicitHome: false,
      confirm,
    })).resolves.toBe('skipped')
    expect(confirm).not.toHaveBeenCalled()
    expect(await readFile(join(destinationHome, 'settings.yaml'), 'utf8')).toBe('from: dest\n')
  })

  it('refuses a symlink that escapes the source home', async () => {
    const root = await temporaryRoot()
    const sourceHome = join(root, '.dsh')
    const outsideDir = join(root, 'outside')
    await mkdir(sourceHome)
    await mkdir(outsideDir)
    await writeFile(join(sourceHome, 'settings.yaml'), 'ui-theme: {}\n')
    await writeFile(join(outsideDir, 'secret.txt'), 'secret\n')
    await symlink(outsideDir, join(sourceHome, 'escaped'), process.platform === 'win32' ? 'junction' : undefined)
    const confirm = vi.fn(async () => true)

    await expect(maybeImportLegacyHarnessHome({
      userDataPath: join(root, 'user-data'),
      destinationHome: join(root, 'harness'),
      sourceHome,
      explicitHome: false,
      confirm,
    })).rejects.toThrow('escapes')
    await expect(readFile(join(root, 'harness', 'escaped', 'secret.txt'))).rejects.toMatchObject({ code: 'ENOENT' })
    expect(await readFile(join(outsideDir, 'secret.txt'), 'utf8')).toBe('secret\n')
  })

  it('treats the same source and destination path as already shared', async () => {
    const root = await temporaryRoot()
    const shared = join(root, '.dsh')
    await mkdir(shared)
    await writeFile(join(shared, 'settings.yaml'), 'ui-theme: {}\n')
    const confirm = vi.fn(async () => true)

    await expect(maybeImportLegacyHarnessHome({
      userDataPath: join(root, 'user-data'),
      destinationHome: resolve(shared),
      sourceHome: shared,
      explicitHome: false,
      confirm,
    })).resolves.toBe('skipped')
    expect(confirm).not.toHaveBeenCalled()
  })
})
