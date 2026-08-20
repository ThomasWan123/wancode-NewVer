import { request as httpRequest } from 'node:http'
import { afterEach, describe, expect, it } from 'vitest'
import { startPwaShellHost, type PwaShellHost, PWA_SHELL_LOCKDOWN_HEADERS } from '../src/host.ts'
import { createPwaPairingScriptSource, createPwaShellFiles, createPwaShellIcons, PWA_SHELL_CSP } from '../src/index.ts'

describe('PWA loopback shell host', () => {
  const hosts: PwaShellHost[] = []

  afterEach(async () => {
    const pending = hosts.splice(0)
    await Promise.all(pending.map(host => host.close()))
  })

  it('serves the installable shell on loopback without embedding secrets', async () => {
    const host = await startPwaShellHost()
    hosts.push(host)
    expect(host.address).toBe('127.0.0.1')
    expect(host.url).toBe(`http://127.0.0.1:${host.port}/`)

    const index = await fetch(host.url)
    expect(index.headers.get('content-type')).toContain('text/html')
    expect(index.headers.get('content-security-policy')).toBe(PWA_SHELL_CSP)
    expect(index.headers.get('x-content-type-options')).toBe('nosniff')
    expect(index.headers.get('referrer-policy')).toBe(PWA_SHELL_LOCKDOWN_HEADERS['referrer-policy'])
    expect(index.headers.get('permissions-policy')).toBe(PWA_SHELL_LOCKDOWN_HEADERS['permissions-policy'])
    expect(index.headers.get('cross-origin-opener-policy')).toBe('same-origin')
    expect(index.headers.get('cross-origin-resource-policy')).toBe('same-origin')
    expect(await index.text()).toBe(createPwaShellFiles()['index.html'])

    const pairing = await fetch(new URL('pair.js', host.url))
    expect(pairing.headers.get('content-type')).toContain('javascript')
    expect(pairing.headers.get('x-content-type-options')).toBe('nosniff')
    expect(await pairing.text()).toBe(createPwaPairingScriptSource())

    const manifest = await fetch(new URL('manifest.webmanifest', host.url))
    expect(manifest.ok).toBe(true)
    expect(await manifest.json()).toEqual(JSON.parse(createPwaShellFiles()['manifest.webmanifest']))

    const icon = await fetch(new URL('icons/wancode-192.png', host.url))
    expect(icon.headers.get('content-type')).toBe('image/png')
    expect(Buffer.from(await icon.arrayBuffer())).toEqual(createPwaShellIcons()['icons/wancode-192.png'])

    const missing = await fetch(new URL('missing.html', host.url))
    expect(missing.status).toBe(404)
    expect(missing.headers.get('content-security-policy')).toBe(PWA_SHELL_CSP)
    expect(missing.headers.get('x-content-type-options')).toBe('nosniff')

    const denied = await fetch(`${host.url}?access_token=tok-live`)
    expect(denied.status).toBe(403)
    expect(denied.headers.get('referrer-policy')).toBe('no-referrer')
    expect(await denied.json()).toEqual({ error: { code: 'plaintext' } })
  })

  it('serves HEAD and refuses mutating methods', async () => {
    const host = await startPwaShellHost()
    hosts.push(host)
    const head = await fetch(host.url, { method: 'HEAD' })
    expect(head.status).toBe(200)
    expect(head.headers.get('content-security-policy')).toBe(PWA_SHELL_CSP)
    expect(await head.text()).toBe('')

    const posted = await fetch(host.url, { method: 'POST', body: 'origin=https://evil.example' })
    expect(posted.status).toBe(400)
    expect(posted.headers.get('x-content-type-options')).toBe('nosniff')
    expect(await posted.json()).toEqual({ error: { code: 'malformed' } })
  })

  it('refuses a public bind address and does not listen', async () => {
    await expect(startPwaShellHost({ bindAddress: '0.0.0.0' })).rejects.toMatchObject({
      code: 'inbound-forbidden',
    })
  })

  it('refuses a non-loopback Host header and does not serve the shell', async () => {
    const host = await startPwaShellHost()
    hosts.push(host)
    const denied = await new Promise<{ status: number, body: string }>((resolve, reject) => {
      const request = httpRequest({
        host: '127.0.0.1',
        port: host.port,
        path: '/',
        headers: { host: 'evil.example' },
      }, response => {
        const chunks: Buffer[] = []
        response.on('data', chunk => chunks.push(chunk))
        response.on('end', () => resolve({
          status: response.statusCode ?? 0,
          body: Buffer.concat(chunks).toString('utf8'),
        }))
      })
      request.on('error', reject)
      request.end()
    })
    expect(denied.status).toBe(403)
    expect(JSON.parse(denied.body)).toEqual({ error: { code: 'inbound-forbidden' } })
  })

  it('refuses a non-loopback Origin header and does not serve the shell', async () => {
    const host = await startPwaShellHost()
    hosts.push(host)
    const denied = await new Promise<{ status: number, body: string }>((resolve, reject) => {
      const request = httpRequest({
        host: '127.0.0.1',
        port: host.port,
        path: '/',
        headers: {
          host: `127.0.0.1:${host.port}`,
          origin: 'https://evil.example',
        },
      }, response => {
        const chunks: Buffer[] = []
        response.on('data', chunk => chunks.push(chunk))
        response.on('end', () => resolve({
          status: response.statusCode ?? 0,
          body: Buffer.concat(chunks).toString('utf8'),
        }))
      })
      request.on('error', reject)
      request.end()
    })
    expect(denied.status).toBe(403)
    expect(JSON.parse(denied.body)).toEqual({ error: { code: 'inbound-forbidden' } })
  })

  it('refuses a non-loopback Referer header and does not serve the shell', async () => {
    const host = await startPwaShellHost()
    hosts.push(host)
    const denied = await new Promise<{ status: number, body: string }>((resolve, reject) => {
      const request = httpRequest({
        host: '127.0.0.1',
        port: host.port,
        path: '/',
        headers: {
          host: `127.0.0.1:${host.port}`,
          referer: 'https://evil.example/app',
        },
      }, response => {
        const chunks: Buffer[] = []
        response.on('data', chunk => chunks.push(chunk))
        response.on('end', () => resolve({
          status: response.statusCode ?? 0,
          body: Buffer.concat(chunks).toString('utf8'),
        }))
      })
      request.on('error', reject)
      request.end()
    })
    expect(denied.status).toBe(403)
    expect(JSON.parse(denied.body)).toEqual({ error: { code: 'inbound-forbidden' } })
  })

  it('refuses path traversal before serving an indexed shell file', async () => {
    const host = await startPwaShellHost()
    hosts.push(host)
    for (const path of ['/foo/../pair.js', '/icons/%2e%2e/pair.js', '/..%2fpair.js']) {
      const denied = await new Promise<{ status: number, body: string }>((resolve, reject) => {
        const request = httpRequest({
          host: '127.0.0.1',
          port: host.port,
          path,
          headers: { host: `127.0.0.1:${host.port}` },
        }, response => {
          const chunks: Buffer[] = []
          response.on('data', chunk => chunks.push(chunk))
          response.on('end', () => resolve({
            status: response.statusCode ?? 0,
            body: Buffer.concat(chunks).toString('utf8'),
          }))
        })
        request.on('error', reject)
        request.end()
      })
      expect(denied.status).toBe(400)
      expect(JSON.parse(denied.body)).toEqual({ error: { code: 'malformed' } })
    }
  })
})
