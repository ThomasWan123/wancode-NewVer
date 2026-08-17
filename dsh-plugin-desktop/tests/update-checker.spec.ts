import { describe, expect, it, vi } from 'vitest'
import {
  DESKTOP_BETA_VERSION_ENDPOINT,
  DESKTOP_VERSION_ENDPOINT,
  MAX_VERSION_RESPONSE_BYTES,
  checkForUpdate,
  checkForStableUpdate,
  compareSemVerVersions,
  parseSemVer,
  type UpdateRequest,
} from '../src/update-checker.ts'

function versionResponse(version: unknown, init: ResponseInit = {}): Response {
  return Response.json({ tag_name: typeof version === 'string' ? `v${version}` : version }, init)
}

describe('strict SemVer parsing', () => {
  it('accepts a three-part version, optional lowercase v, prerelease, and build metadata', () => {
    expect(parseSemVer('v2.10.3-alpha.1+mac.arm64')).toEqual({
      version: '2.10.3-alpha.1+mac.arm64',
      major: '2',
      minor: '10',
      patch: '3',
      prerelease: ['alpha', '1'],
      build: ['mac', 'arm64'],
    })
    expect(parseSemVer('0.0.0')).not.toBeNull()
  })

  it.each([
    '1',
    '1.2',
    '01.2.3',
    '1.02.3',
    '1.2.03',
    '1.2.3-01',
    '1.2.3-alpha..1',
    '1.2.3+',
    'V1.2.3',
    ' 1.2.3',
  ])('rejects invalid SemVer %s', version => {
    expect(parseSemVer(version)).toBeNull()
  })

  it('compares strict versions without numeric overflow', () => {
    expect(compareSemVerVersions('2.1.0', '2.0.9')).toBeGreaterThan(0)
    expect(compareSemVerVersions('2.0.0-rc.1', '2.0.0')).toBeLessThan(0)
    expect(compareSemVerVersions('2.0', '2.0.0')).toBeNull()
    expect(compareSemVerVersions(
      '10000000000000000.0.0',
      '9007199254740992.0.0',
    )).toBeGreaterThan(0)
  })
})

describe('public Desktop version check', () => {
  it('selects the newest non-draft prerelease for the beta channel', async () => {
    const calls: string[] = []
    const result = await checkForUpdate({
      channel: 'beta',
      currentVersion: '2.0.0',
      request: async (url) => {
        calls.push(url)
        return Response.json([
          { tag_name: 'v2.1.0-beta.1', draft: false, prerelease: true },
          { tag_name: 'v2.0.1', draft: false, prerelease: false },
          { tag_name: 'v9.0.0-beta.1', draft: true, prerelease: true },
        ])
      },
    })

    expect(calls).toEqual([DESKTOP_BETA_VERSION_ENDPOINT])
    expect(result).toEqual({
      status: 'update-available',
      currentVersion: '2.0.0',
      latestVersion: '2.1.0-beta.1',
    })
  })

  it('paginates beta releases before selecting the highest SemVer', async () => {
    const calls: string[] = []
    const firstPage = Array.from({ length: 100 }, (_, index) => ({
      tag_name: `v1.0.${String(index)}`,
      draft: false,
      prerelease: false,
    }))
    const result = await checkForUpdate({
      channel: 'beta',
      currentVersion: '2.0.0',
      request: async (url) => {
        calls.push(url)
        return Response.json(calls.length === 1
          ? firstPage
          : [{ tag_name: 'v3.0.0-beta.1', draft: false, prerelease: true }])
      },
    })

    expect(calls).toEqual([
      DESKTOP_BETA_VERSION_ENDPOINT,
      'https://api.github.com/repos/ThomasWan123/wancode-NewVer/releases?per_page=100&page=2',
    ])
    expect(result?.latestVersion).toBe('3.0.0-beta.1')
  })

  it('fails closed when the bounded beta release scan is exhausted', async () => {
    const request = vi.fn(async () => Response.json(
      Array.from({ length: 100 }, () => ({
        tag_name: 'v2.1.0-beta.1',
        draft: false,
        prerelease: true,
      })),
    ))

    await expect(checkForUpdate({
      channel: 'beta',
      currentVersion: '2.0.0',
      request,
    })).resolves.toBeNull()
    expect(request).toHaveBeenCalledTimes(5)
  })

  it('uses only the fixed no-cache version endpoint and reports a newer stable version', async () => {
    const controller = new AbortController()
    const calls: Array<{ url: string, init: RequestInit }> = []
    const request: UpdateRequest = async (url, init) => {
      calls.push({ url, init })
      return versionResponse('2.10.0')
    }

    await expect(checkForStableUpdate({
      currentVersion: '2.9.9',
      signal: controller.signal,
      request,
    })).resolves.toEqual({
      status: 'update-available',
      currentVersion: '2.9.9',
      latestVersion: '2.10.0',
    })

    expect(calls).toHaveLength(1)
    expect(calls[0]?.url).toBe(DESKTOP_VERSION_ENDPOINT)
    expect(calls[0]?.url).toBe(
      'https://api.github.com/repos/ThomasWan123/wancode-NewVer/releases/latest',
    )
    expect(calls[0]?.url).not.toContain('/api/downloads/')
    expect(calls[0]?.init).toMatchObject({
      method: 'GET',
      cache: 'no-store',
      redirect: 'error',
      signal: controller.signal,
    })
    const headers = new Headers(calls[0]?.init.headers)
    expect(headers.get('accept')).toBe('application/json')
    expect(headers.has('if-none-match')).toBe(false)
    expect(headers.has('x-github-api-version')).toBe(false)
  })

  it.each([
    ['2.0.0', '2.0.0'],
    ['2.0.1', '2.0.0'],
    ['2.0.0+installed', '2.0.0+release'],
  ])('reports no update for installed %s and service %s', async (currentVersion, latestVersion) => {
    await expect(checkForStableUpdate({
      currentVersion,
      request: async () => versionResponse(latestVersion),
    })).resolves.toEqual({
      status: 'up-to-date',
      currentVersion,
      latestVersion,
    })
  })

  it('compares service versions without overflowing JavaScript numbers', async () => {
    await expect(checkForStableUpdate({
      currentVersion: '9007199254740992.0.0',
      request: async () => versionResponse('10000000000000000.0.0'),
    })).resolves.toMatchObject({ status: 'update-available' })
  })

  it('offers the stable release when leaving beta on the same version line', async () => {
    await expect(checkForStableUpdate({
      currentVersion: '2.1.0-beta.2',
      request: async () => versionResponse('2.1.0'),
    })).resolves.toEqual({
      status: 'update-available',
      currentVersion: '2.1.0-beta.2',
      latestVersion: '2.1.0',
    })
  })

  it.each([
    ['missing v prefix', { tag_name: '2.1.0' }],
    ['prerelease', { tag_name: 'v2.1.0-rc.1' }],
    ['invalid SemVer', { tag_name: 'v2.01.0' }],
    ['missing version', {}],
    ['non-string version', { tag_name: 2 }],
    ['array response', ['2.1.0']],
  ])('silently ignores a service response with %s', async (_case, value) => {
    await expect(checkForStableUpdate({
      currentVersion: '2.0.0',
      request: async () => Response.json(value),
    })).resolves.toBeNull()
  })

  it('silently ignores malformed JSON and non-200 statuses', async () => {
    await expect(checkForStableUpdate({
      currentVersion: '2.0.0',
      request: async () => new Response('{'),
    })).resolves.toBeNull()
    await expect(checkForStableUpdate({
      currentVersion: '2.0.0',
      request: async () => new Response('unavailable', { status: 503 }),
    })).resolves.toBeNull()
    await expect(checkForStableUpdate({
      currentVersion: '2.0.0',
      request: async () => new Response(null, { status: 304 }),
    })).resolves.toBeNull()
  })

  it('silently ignores network failure and caller cancellation', async () => {
    await expect(checkForStableUpdate({
      currentVersion: '2.0.0',
      request: async () => { throw new TypeError('offline') },
    })).resolves.toBeNull()

    const controller = new AbortController()
    controller.abort()
    await expect(checkForStableUpdate({
      currentVersion: '2.0.0',
      signal: controller.signal,
      request: async () => { throw new DOMException('cancelled', 'AbortError') },
    })).resolves.toBeNull()
  })

  it('silently ignores declared and streamed oversized responses', async () => {
    await expect(checkForStableUpdate({
      currentVersion: '2.0.0',
      request: async () => new Response('{}', {
        headers: { 'content-length': String(MAX_VERSION_RESPONSE_BYTES + 1) },
      }),
    })).resolves.toBeNull()
    await expect(checkForStableUpdate({
      currentVersion: '2.0.0',
      request: async () => new Response('x'.repeat(MAX_VERSION_RESPONSE_BYTES + 1)),
    })).resolves.toBeNull()
  })

  it.each(['2.0', 'v2.0.0'])('skips invalid installed version %s before requesting', async currentVersion => {
    const request = vi.fn(async () => versionResponse('2.1.0'))

    await expect(checkForStableUpdate({ currentVersion, request })).resolves.toBeNull()
    expect(request).not.toHaveBeenCalled()
  })
})
