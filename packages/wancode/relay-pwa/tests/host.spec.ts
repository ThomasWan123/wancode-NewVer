import { request as httpRequest } from 'node:http'
import { afterEach, describe, expect, it } from 'vitest'
import { startPwaShellHost, type PwaShellHost } from '../src/host.ts'
import { createPwaShellFiles, createPwaShellIcons } from '../src/index.ts'

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
    expect(await index.text()).toBe(createPwaShellFiles()['index.html'])

    const manifest = await fetch(new URL('manifest.webmanifest', host.url))
    expect(manifest.ok).toBe(true)
    expect(await manifest.json()).toEqual(JSON.parse(createPwaShellFiles()['manifest.webmanifest']))

    const icon = await fetch(new URL('icons/wancode-192.png', host.url))
    expect(icon.headers.get('content-type')).toBe('image/png')
    expect(Buffer.from(await icon.arrayBuffer())).toEqual(createPwaShellIcons()['icons/wancode-192.png'])

    const missing = await fetch(new URL('missing.html', host.url))
    expect(missing.status).toBe(404)

    const denied = await fetch(`${host.url}?access_token=tok-live`)
    expect(denied.status).toBe(403)
    expect(await denied.json()).toEqual({ error: { code: 'plaintext' } })
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
})
