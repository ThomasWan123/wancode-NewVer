/** Headless version checks against the Wancode GitHub release feed. */

/** Public endpoint returning the latest Wancode release. */
export const DESKTOP_VERSION_ENDPOINT =
  'https://api.github.com/repos/ThomasWan123/wancode-NewVer/releases/latest'

/** Public endpoint used to select stable or prerelease builds for beta users. */
export const DESKTOP_BETA_VERSION_ENDPOINT =
  'https://api.github.com/repos/ThomasWan123/wancode-NewVer/releases?per_page=100&page=1'

/** Maximum response body bytes accepted from the version service. */
export const MAX_VERSION_RESPONSE_BYTES = 64 * 1024
const MAX_BETA_VERSION_RESPONSE_BYTES = 2 * 1024 * 1024
const BETA_RELEASES_PER_PAGE = 100
const MAX_BETA_RELEASE_PAGES = 5

/** User-selected release stream. */
export type UpdateChannel = 'stable' | 'beta'

/** Strictly parsed SemVer components. Numeric components remain strings to avoid overflow. */
export interface ParsedSemVer {
  /** Canonical version without the optional leading `v`. */
  readonly version: string
  /** Major numeric identifier. */
  readonly major: string
  /** Minor numeric identifier. */
  readonly minor: string
  /** Patch numeric identifier. */
  readonly patch: string
  /** Ordered prerelease identifiers, or an empty list for a stable version. */
  readonly prerelease: readonly string[]
  /** Build identifiers, ignored for version precedence. */
  readonly build: readonly string[]
}

/** Fetch-compatible request function used by the headless checker. */
export type UpdateRequest = (url: string, init: RequestInit) => Promise<Response>

/** Inputs for one stable version check. */
export interface UpdateCheckOptions {
  /** Installed application version, expressed as canonical stable SemVer. */
  readonly currentVersion: string
  /** Caller-owned cancellation signal; the checker does not create its own timeout. */
  readonly signal?: AbortSignal
  /** Optional fetch implementation for a host adapter or test. */
  readonly request?: UpdateRequest
}

/** Inputs for a stable or beta version check. */
export interface ChannelUpdateCheckOptions extends UpdateCheckOptions {
  readonly channel: UpdateChannel
}

/** Successful comparison returned by the stable version service. */
export type UpdateCheckResult = {
  /** Whether the service reports a version newer than the installed application. */
  readonly status: 'up-to-date' | 'update-available'
  /** Canonical installed stable version. */
  readonly currentVersion: string
  /** Canonical latest stable version returned by the service. */
  readonly latestVersion: string
}

const SEMVER_PATTERN =
  /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/u

/**
 * Parse strict SemVer with an optional lowercase `v` prefix.
 * @param input - complete version or release tag.
 * @returns parsed identifiers, or null when the input is not valid SemVer.
 */
export function parseSemVer(input: string): ParsedSemVer | null {
  const version = input.startsWith('v') ? input.slice(1) : input
  const match = SEMVER_PATTERN.exec(version)
  if (match === null) return null

  const prerelease = match[4]?.split('.') ?? []
  if (prerelease.some(identifier => isNumeric(identifier) && hasLeadingZero(identifier))) return null

  return {
    version,
    major: match[1]!,
    minor: match[2]!,
    patch: match[3]!,
    prerelease,
    build: match[5]?.split('.') ?? [],
  }
}

/**
 * Compare two strict SemVer strings without numeric overflow.
 * @param left - first strict SemVer value.
 * @param right - second strict SemVer value.
 * @returns negative, zero, or positive precedence, or null when either value is invalid.
 */
export function compareSemVerVersions(left: string, right: string): number | null {
  const leftVersion = parseSemVer(left)
  const rightVersion = parseSemVer(right)
  if (leftVersion === null || rightVersion === null) return null
  return compareParsedSemVer(leftVersion, rightVersion)
}

/**
 * Check the fixed Wancode GitHub release endpoint for a newer stable release.
 * @param options - installed version, caller-owned signal, and optional request adapter.
 * @returns a successful comparison, or null when any request or validation step fails.
 */
export async function checkForStableUpdate(
  options: UpdateCheckOptions,
): Promise<UpdateCheckResult | null> {
  return checkForUpdate({ ...options, channel: 'stable' })
}

/** Check the fixed GitHub endpoint for the selected release channel. */
export async function checkForUpdate(
  options: ChannelUpdateCheckOptions,
): Promise<UpdateCheckResult | null> {
  const current = parseCanonicalVersion(options.currentVersion)
  if (current === null) return null

  const init: RequestInit = {
    method: 'GET',
    headers: { Accept: 'application/json' },
    cache: 'no-store',
    redirect: 'error',
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  }
  const request = options.request ?? defaultRequest
  if (options.channel === 'beta') {
    return checkBetaUpdatePages(current, init, request)
  }

  let response: Response
  try {
    response = await request(DESKTOP_VERSION_ENDPOINT, init)
  } catch {
    return null
  }
  if (response.status !== 200) return null

  let body: string
  try {
    body = await readLimitedBody(response, MAX_VERSION_RESPONSE_BYTES)
  } catch {
    return null
  }

  const latest = parseVersionResponse(body)
  if (latest === null) return null
  return {
    status: compareParsedSemVer(latest, current) > 0 ? 'update-available' : 'up-to-date',
    currentVersion: current.version,
    latestVersion: latest.version,
  }
}

async function checkBetaUpdatePages(
  current: ParsedSemVer,
  init: RequestInit,
  request: UpdateRequest,
): Promise<UpdateCheckResult | null> {
  let latest: ParsedSemVer | null = null
  for (let page = 1; page <= MAX_BETA_RELEASE_PAGES; page += 1) {
    const url = page === 1
      ? DESKTOP_BETA_VERSION_ENDPOINT
      : `https://api.github.com/repos/ThomasWan123/wancode-NewVer/releases?per_page=${String(BETA_RELEASES_PER_PAGE)}&page=${String(page)}`
    let response: Response
    try {
      response = await request(url, init)
    } catch {
      return null
    }
    if (response.status !== 200) return null

    let body: string
    try {
      body = await readLimitedBody(response, MAX_BETA_VERSION_RESPONSE_BYTES)
    } catch {
      return null
    }
    const releasePage = parseBetaVersionResponse(body)
    if (releasePage === null) return null
    if (releasePage.latest !== null
      && (latest === null || compareParsedSemVer(releasePage.latest, latest) > 0)) {
      latest = releasePage.latest
    }
    if (releasePage.count < BETA_RELEASES_PER_PAGE) {
      if (latest === null) return null
      return {
        status: compareParsedSemVer(latest, current) > 0 ? 'update-available' : 'up-to-date',
        currentVersion: current.version,
        latestVersion: latest.version,
      }
    }
  }
  // Never report a potentially stale result when the bounded scan was exhausted.
  return null
}

async function defaultRequest(url: string, init: RequestInit): Promise<Response> {
  return globalThis.fetch(url, init)
}

async function readLimitedBody(response: Response, maximumBytes: number): Promise<string> {
  const declaredLength = response.headers.get('content-length')
  if (declaredLength !== null
    && /^[0-9]+$/u.test(declaredLength)
    && BigInt(declaredLength) > BigInt(maximumBytes)) {
    throw new Error('version response is too large')
  }

  if (response.body === null) return ''
  const reader = response.body.getReader()
  const decoder = new TextDecoder('utf-8', { fatal: true })
  let bytesRead = 0
  let body = ''
  try {
    while (true) {
      const chunk = await reader.read()
      if (chunk.done) break
      bytesRead += chunk.value.byteLength
      if (bytesRead > maximumBytes) {
        await reader.cancel().catch(() => undefined)
        throw new Error('version response is too large')
      }
      body += decoder.decode(chunk.value, { stream: true })
    }
    return body + decoder.decode()
  } finally {
    reader.releaseLock()
  }
}

function parseVersionResponse(body: string): ParsedSemVer | null {
  let value: unknown
  try {
    value = JSON.parse(body)
  } catch {
    return null
  }
  if (!isRecord(value) || typeof value.tag_name !== 'string' || !value.tag_name.startsWith('v')) {
    return null
  }
  const parsed = parseSemVer(value.tag_name)
  return parsed !== null && parsed.prerelease.length === 0 ? parsed : null
}

function parseBetaVersionResponse(
  body: string,
): { readonly count: number, readonly latest: ParsedSemVer | null } | null {
  let value: unknown
  try {
    value = JSON.parse(body)
  } catch {
    return null
  }
  if (!Array.isArray(value)) return null
  let latest: ParsedSemVer | null = null
  for (const release of value) {
    if (!isRecord(release)
      || release.draft !== false
      || typeof release.prerelease !== 'boolean'
      || typeof release.tag_name !== 'string'
      || !release.tag_name.startsWith('v')) {
      continue
    }
    const parsed = parseSemVer(release.tag_name)
    if (parsed === null || (parsed.prerelease.length > 0) !== release.prerelease) continue
    if (latest === null || compareParsedSemVer(parsed, latest) > 0) latest = parsed
  }
  return { count: value.length, latest }
}

function parseCanonicalVersion(input: string): ParsedSemVer | null {
  const parsed = parseSemVer(input)
  return parsed !== null && parsed.version === input ? parsed : null
}

function compareParsedSemVer(left: ParsedSemVer, right: ParsedSemVer): number {
  for (const key of ['major', 'minor', 'patch'] as const) {
    const comparison = compareNumeric(left[key], right[key])
    if (comparison !== 0) return comparison
  }
  if (left.prerelease.length === 0) return right.prerelease.length === 0 ? 0 : 1
  if (right.prerelease.length === 0) return -1

  const length = Math.max(left.prerelease.length, right.prerelease.length)
  for (let index = 0; index < length; index += 1) {
    const leftIdentifier = left.prerelease[index]
    const rightIdentifier = right.prerelease[index]
    if (leftIdentifier === undefined) return -1
    if (rightIdentifier === undefined) return 1
    if (leftIdentifier === rightIdentifier) continue

    const leftNumeric = isNumeric(leftIdentifier)
    const rightNumeric = isNumeric(rightIdentifier)
    if (leftNumeric && rightNumeric) return compareNumeric(leftIdentifier, rightIdentifier)
    if (leftNumeric) return -1
    if (rightNumeric) return 1
    return leftIdentifier < rightIdentifier ? -1 : 1
  }
  return 0
}

function compareNumeric(left: string, right: string): number {
  if (left.length !== right.length) return left.length < right.length ? -1 : 1
  if (left === right) return 0
  return left < right ? -1 : 1
}

function isNumeric(identifier: string): boolean {
  return /^[0-9]+$/u.test(identifier)
}

function hasLeadingZero(identifier: string): boolean {
  return identifier.length > 1 && identifier.startsWith('0')
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
