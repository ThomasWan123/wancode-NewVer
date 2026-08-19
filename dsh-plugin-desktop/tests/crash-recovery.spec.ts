import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  DESKTOP_CLEAN_EXIT_MARKER,
  DESKTOP_GPU_CACHE_DIRECTORY,
  markDesktopCleanExit,
  prepareDesktopCrashRecovery,
} from '../src/crash-recovery.ts'

const roots: string[] = []

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-desktop-crash-'))
  roots.push(root)
  return root
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

describe('desktop crash recovery', () => {
  it('leaves hardware acceleration on for a first launch without GPU cache', async () => {
    const userDataPath = join(await temporaryRoot(), 'user-data')
    await mkdir(userDataPath, { recursive: true })

    expect(prepareDesktopCrashRecovery(userDataPath)).toEqual({
      disableHardwareAcceleration: false,
      recoveredFromCrash: false,
    })
  })

  it('disables GPU and clears cache after an unclean exit', async () => {
    const userDataPath = join(await temporaryRoot(), 'user-data')
    const gpuCache = join(userDataPath, DESKTOP_GPU_CACHE_DIRECTORY)
    await mkdir(gpuCache, { recursive: true })
    await writeFile(join(gpuCache, 'data_0'), 'poison')

    expect(prepareDesktopCrashRecovery(userDataPath)).toEqual({
      disableHardwareAcceleration: true,
      recoveredFromCrash: true,
    })
    await expect(readFile(join(gpuCache, 'data_0'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('keeps GPU enabled after an orderly quit', async () => {
    const userDataPath = join(await temporaryRoot(), 'user-data')
    const gpuCache = join(userDataPath, DESKTOP_GPU_CACHE_DIRECTORY)
    await mkdir(gpuCache, { recursive: true })
    await writeFile(join(gpuCache, 'data_0'), 'keep')
    markDesktopCleanExit(userDataPath)

    expect(prepareDesktopCrashRecovery(userDataPath)).toEqual({
      disableHardwareAcceleration: false,
      recoveredFromCrash: false,
    })
    expect(await readFile(join(gpuCache, 'data_0'), 'utf8')).toBe('keep')
    await expect(readFile(join(userDataPath, DESKTOP_CLEAN_EXIT_MARKER), 'utf8'))
      .rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('refuses a relative user-data path', () => {
    expect(() => prepareDesktopCrashRecovery('relative')).toThrow(/absolute user-data path/)
    expect(() => markDesktopCleanExit('')).toThrow(/absolute user-data path/)
  })
})
