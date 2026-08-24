/** Opt-in copy of an existing `~/.dsh` tree into the isolated WanCodeNewVer home. */

import { writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'
import { DEFAULT_DSH_HOME_DISPLAY } from '@deepseek-ai/dsh-home-paths'
import { open } from 'node:fs/promises'
import {
  chmod,
  copyFile,
  lstat,
  mkdir,
  readdir,
  readlink,
  realpath,
  rename,
  rm,
  symlink,
} from 'node:fs/promises'
import { basename, isAbsolute, join, relative, resolve } from 'node:path'

const BIN_NAME = 'dsh-plugin-desktop'
const STATE_VERSION = 1
const MAX_STATE_BYTES = 4 * 1024
const MAX_IMPORT_BYTES = 1024 * 1024 * 1024
const SKIP_DIRECTORY_NAMES = new Set(['node_modules'])

/** Outcome of one first-run legacy-home decision. */
export type HomeMigrationStatus = 'skipped' | 'declined' | 'imported'

/** Inputs for one isolated-home import attempt. */
export interface HomeMigrationOptions {
  /** Electron user-data directory that stores the import decision. */
  readonly userDataPath: string
  /** Isolated WanCodeNewVer Harness home that will receive the copy. */
  readonly destinationHome: string
  /** Existing default Harness home, normally `~/.dsh`. */
  readonly sourceHome: string
  /** Whether `DSH_HOME` already selected a user-owned shared home. */
  readonly explicitHome: boolean
  /** Ask whether the copy may proceed. */
  readonly confirm: (sourceDisplay: string) => Promise<boolean>
}

interface HomeMigrationStateV1 {
  readonly version: 1
  readonly status: 'declined' | 'imported'
}

/**
 * Copy `~/.dsh` into the WanCodeNewVer home only after an explicit confirmation.
 * The original tree is left unchanged. Plugin `node_modules` directories are
 * omitted, and a symlink that escapes the source home fails closed.
 * @param options - source, destination, and confirmation adapter.
 * @returns whether the copy ran, was declined, or was not offered.
 */
export async function maybeImportLegacyHarnessHome(
  options: HomeMigrationOptions,
): Promise<HomeMigrationStatus> {
  if (options.explicitHome || sameDirectory(options.sourceHome, options.destinationHome)) {
    return 'skipped'
  }
  const statePath = join(options.userDataPath, 'migration', 'state.json')
  const previous = await readState(statePath)
  if (previous?.status === 'declined') return 'skipped'
  if (!await hasUserData(options.sourceHome)) return 'skipped'
  if (await hasUserData(options.destinationHome)) return 'skipped'

  const confirmed = await options.confirm(DEFAULT_DSH_HOME_DISPLAY)
  if (!confirmed) {
    await persistState(statePath, { version: STATE_VERSION, status: 'declined' })
    return 'declined'
  }

  await importHarnessHome(options.sourceHome, options.destinationHome)
  await persistState(statePath, { version: STATE_VERSION, status: 'imported' })
  return 'imported'
}

async function importHarnessHome(sourceHome: string, destinationHome: string): Promise<void> {
  const source = await realpath(resolve(sourceHome))
  const destination = resolve(destinationHome)
  const staging = `${destination}.importing`
  await rm(staging, { recursive: true, force: true })
  try {
    await copyTree(source, source, staging, { bytes: 0 })
    if (await hasUserData(destination)) {
      throw new Error(`${BIN_NAME}: WanCodeNewVer home already contains user data`)
    }
    await rm(destination, { recursive: true, force: true })
    await rename(staging, destination)
  } catch (cause) {
    await rm(staging, { recursive: true, force: true })
    throw cause
  }
}

async function copyTree(
  sourceRoot: string,
  from: string,
  to: string,
  totals: { bytes: number },
): Promise<void> {
  const canonicalFrom = await realpath(from)
  if (!isInside(sourceRoot, canonicalFrom)) {
    throw new Error(`${BIN_NAME}: legacy home entry ${basename(from)} escapes the source home`)
  }
  await mkdir(to, { recursive: true, mode: 0o700 })
  for (const entry of await readdir(from, { withFileTypes: true })) {
    if (SKIP_DIRECTORY_NAMES.has(entry.name)) continue
    const sourcePath = join(from, entry.name)
    const destinationPath = join(to, entry.name)
    const listing = await lstat(sourcePath)
    if (listing.isSymbolicLink()) {
      const target = await readlink(sourcePath)
      const resolved = resolve(from, target)
      if (!isInside(sourceRoot, resolved)) {
        throw new Error(`${BIN_NAME}: legacy home entry ${entry.name} escapes the source home`)
      }
      await symlink(target, destinationPath)
      continue
    }
    if (listing.isDirectory()) {
      await copyTree(sourceRoot, sourcePath, destinationPath, totals)
      continue
    }
    if (!listing.isFile()) continue
    totals.bytes += listing.size
    if (totals.bytes > MAX_IMPORT_BYTES) {
      throw new Error(`${BIN_NAME}: legacy home exceeds ${MAX_IMPORT_BYTES} bytes`)
    }
    await copyFile(sourcePath, destinationPath)
    await chmod(destinationPath, listing.mode & 0o777)
  }
}

async function hasUserData(path: string): Promise<boolean> {
  let listing
  try {
    listing = await lstat(path)
  } catch (cause) {
    if (isEnoent(cause)) return false
    throw cause
  }
  if (listing.isSymbolicLink() || listing.isFile()) return true
  if (!listing.isDirectory()) return false
  return await directoryHasUserData(path)
}

async function directoryHasUserData(path: string): Promise<boolean> {
  for (const entry of await readdir(path, { withFileTypes: true })) {
    if (SKIP_DIRECTORY_NAMES.has(entry.name)) continue
    const child = join(path, entry.name)
    const listing = await lstat(child)
    if (listing.isDirectory() && !listing.isSymbolicLink()) {
      if (await directoryHasUserData(child)) return true
      continue
    }
    if (listing.isFile() || listing.isSymbolicLink()) return true
  }
  return false
}

async function readState(filename: string): Promise<HomeMigrationStateV1 | undefined> {
  let handle
  try {
    handle = await open(filename, 'r')
  } catch (cause) {
    if (isEnoent(cause)) return undefined
    throw cause
  }
  try {
    const buffer = Buffer.alloc(MAX_STATE_BYTES + 1)
    const { bytesRead } = await handle.read(buffer, 0, buffer.byteLength, 0)
    if (bytesRead > MAX_STATE_BYTES) return undefined
    return parseState(new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, bytesRead)))
  } catch {
    return undefined
  } finally {
    await handle.close()
  }
}

function parseState(text: string): HomeMigrationStateV1 | undefined {
  const value: unknown = JSON.parse(text)
  if (!isRecord(value) || value.version !== STATE_VERSION) return undefined
  if (value.status !== 'declined' && value.status !== 'imported') return undefined
  if (Object.keys(value).some(key => !['version', 'status'].includes(key))) return undefined
  return { version: STATE_VERSION, status: value.status }
}

async function persistState(filename: string, state: HomeMigrationStateV1): Promise<void> {
  await writeFileAtomic(filename, `${JSON.stringify(state, null, 2)}\n`, {
    mode: 0o600,
    dirMode: 0o700,
  })
}

function sameDirectory(left: string, right: string): boolean {
  const resolvedLeft = resolve(left)
  const resolvedRight = resolve(right)
  if (process.platform === 'win32') {
    return resolvedLeft.toLowerCase() === resolvedRight.toLowerCase()
  }
  return resolvedLeft === resolvedRight
}

function isInside(root: string, path: string): boolean {
  const resolvedRoot = resolve(root)
  const resolvedPath = resolve(path)
  const left = process.platform === 'win32' ? resolvedRoot.toLowerCase() : resolvedRoot
  const right = process.platform === 'win32' ? resolvedPath.toLowerCase() : resolvedPath
  const relativePath = relative(left, right)
  return relativePath === '' || (!relativePath.startsWith('..') && !isAbsolute(relativePath))
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isEnoent(value: unknown): boolean {
  return isRecord(value) && value.code === 'ENOENT'
}
