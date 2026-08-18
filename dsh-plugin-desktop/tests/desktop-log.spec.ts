import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  appendDesktopLog,
  desktopLogFilePath,
  desktopLogsDirectory,
  ensureDesktopLogsDirectory,
  installDesktopLogMirror,
} from '../src/desktop-log.ts'

const roots: string[] = []

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-desktop-log-'))
  roots.push(root)
  return root
}

afterEach(async () => {
  for (const root of roots.splice(0)) {
    await rm(root, { recursive: true, force: true })
  }
})

describe('desktop diagnostics log', () => {
  it('places the log file under an absolute user-data logs directory', async () => {
    const userDataPath = join(await temporaryRoot(), 'user-data')

    expect(desktopLogsDirectory(userDataPath)).toBe(join(userDataPath, 'logs'))
    expect(desktopLogFilePath(userDataPath)).toBe(join(userDataPath, 'logs', 'wancode.log'))
  })

  it('refuses a relative or empty user-data path', () => {
    expect(() => desktopLogsDirectory('relative')).toThrow(/absolute user-data path/)
    expect(() => desktopLogsDirectory('')).toThrow(/absolute user-data path/)
  })

  it('creates the logs directory and appends a crash line', async () => {
    const userDataPath = join(await temporaryRoot(), 'user-data')

    expect(ensureDesktopLogsDirectory(userDataPath)).toBe(join(userDataPath, 'logs'))
    appendDesktopLog(userDataPath, 'renderer process gone: crashed (1)\n')

    expect(await readFile(desktopLogFilePath(userDataPath), 'utf8'))
      .toBe('renderer process gone: crashed (1)\n')
  })

  it('rotates the current log once it would exceed the size cap', async () => {
    const userDataPath = join(await temporaryRoot(), 'user-data')
    await mkdir(join(userDataPath, 'logs'), { recursive: true })
    await writeFile(desktopLogFilePath(userDataPath), 'old-log\n')

    appendDesktopLog(userDataPath, 'new-log\n', 8)

    expect(await readFile(join(userDataPath, 'logs', 'wancode.previous.log'), 'utf8')).toBe('old-log\n')
    expect(await readFile(desktopLogFilePath(userDataPath), 'utf8')).toBe('new-log\n')
  })

  it('mirrors stdout and stderr into the diagnostics file without changing the original write', async () => {
    const userDataPath = join(await temporaryRoot(), 'user-data')
    const stdoutChunks: string[] = []
    const stderrChunks: string[] = []
    const stdout = {
      write(chunk: string) {
        stdoutChunks.push(chunk)
        return true
      },
    }
    const stderr = {
      write(chunk: string) {
        stderrChunks.push(chunk)
        return true
      },
    }

    const dispose = installDesktopLogMirror(userDataPath, {
      stdout: stdout as unknown as NodeJS.WriteStream,
      stderr: stderr as unknown as NodeJS.WriteStream,
    })
    stdout.write('boot\n')
    stderr.write('failed to import existing Harness data\n')
    dispose()
    stdout.write('after-dispose\n')

    expect(stdoutChunks).toEqual(['boot\n', 'after-dispose\n'])
    expect(stderrChunks).toEqual(['failed to import existing Harness data\n'])
    expect(await readFile(desktopLogFilePath(userDataPath), 'utf8'))
      .toBe('boot\nfailed to import existing Harness data\n')
  })
})
