import { describe, expect, it, vi } from 'vitest'
import { installBrandCopy, rewriteBrandText } from '../src/client/brand-copy.ts'

describe('visible WanCodeNewVer brand copy', () => {
  it('replaces DeepSeek product copy without touching ids or endpoints', () => {
    expect(rewriteBrandText('DeepSeek Harness')).toBe('WanCodeNewVer')
    expect(rewriteBrandText('DeepSeek-V4-Flash High')).toBe('WanCodeNewVer-V4-Flash High')
    expect(rewriteBrandText('Configure the official DeepSeek provider to start building.')).toBe(
      'Configure the official WanCodeNewVer provider to start building.',
    )
    expect(rewriteBrandText('配置 DeepSeek 官方模型，即可开始使用。')).toBe(
      '配置 WanCodeNewVer 官方模型，即可开始使用。',
    )
    expect(rewriteBrandText('HARNESS')).toBe('WanCodeNewVer')
    expect(rewriteBrandText('https://api.deepseek.com')).toBe('https://api.deepseek.com')
    expect(rewriteBrandText('@deepseek-ai/dsh-base')).toBe('@deepseek-ai/dsh-base')
    expect(rewriteBrandText('deepseek-official')).toBe('deepseek-official')
    expect(rewriteBrandText('deepseek-v4-flash')).toBe('deepseek-v4-flash')
    expect(rewriteBrandText('Harness developers')).toBe('Harness developers')
    expect(rewriteBrandText('WanCodeNewVer')).toBe('WanCodeNewVer')
  })

  it('rewrites the document title and injects the boxed-W favicon', () => {
    const appendChild = vi.fn()
    const remove = vi.fn()
    const link = {
      dataset: {} as Record<string, string>,
      setAttribute: vi.fn(),
      remove,
    }
    const doc = {
      title: 'DeepSeek Harness',
      head: { appendChild, querySelector: () => null },
      body: { childNodes: [] },
      documentElement: { childNodes: [] },
      createElement: (tag: string) => {
        expect(tag).toBe('link')
        return link
      },
    }
    const observe = vi.fn()
    const disconnect = vi.fn()
    vi.stubGlobal('MutationObserver', class {
      observe = observe
      disconnect = disconnect
    })

    try {
      const dispose = installBrandCopy(doc as unknown as Document)
      expect(doc.title).toBe('WanCodeNewVer')
      expect(link.setAttribute).toHaveBeenCalledWith('rel', 'icon')
      expect(link.setAttribute).toHaveBeenCalledWith('type', 'image/svg+xml')
      expect(appendChild).toHaveBeenCalledWith(link)
      expect(observe).toHaveBeenCalledOnce()
      dispose()
      expect(disconnect).toHaveBeenCalledOnce()
      expect(remove).toHaveBeenCalledOnce()
    }
    finally {
      vi.unstubAllGlobals()
    }
  })
})
