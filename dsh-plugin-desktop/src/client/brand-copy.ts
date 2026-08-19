const TEXT_NODE = 3
const ELEMENT_NODE = 1
const SKIP_TAGS = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEXTAREA', 'INPUT'])
const LABEL_ATTRIBUTES = ['aria-label', 'title', 'alt', 'placeholder'] as const

const WANCODE_FAVICON = `data:image/svg+xml,${encodeURIComponent(
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1024 1024">'
  + '<rect width="1024" height="1024" rx="224" fill="#4D6BFE"/>'
  + '<path fill="#FFFFFF" d="M248 292h112l92 292 60-188h92l60 188 92-292h112L748 732H620L512 422 404 732H276z"/>'
  + '</svg>',
)}`

/**
 * Rewrite visible DeepSeek product copy to Wan Code.
 * Leaves hostnames, package names, and lowercase model ids unchanged.
 */
export function rewriteBrandText(value: string): string {
  if (value === 'HARNESS') return 'Wan Code'
  return value.replaceAll('DeepSeek Harness', 'Wan Code').replaceAll('DeepSeek', 'Wan Code')
}

function rewriteAttributes(element: Element): void {
  if (typeof element.getAttribute !== 'function' || typeof element.setAttribute !== 'function') return
  for (const name of LABEL_ATTRIBUTES) {
    const current = element.getAttribute(name)
    if (current === null) continue
    const next = rewriteBrandText(current)
    if (next !== current) element.setAttribute(name, next)
  }
}

function rewriteNode(node: Node): void {
  if (node.nodeType === ELEMENT_NODE) {
    const element = node as Element
    if (typeof element.tagName === 'string' && SKIP_TAGS.has(element.tagName)) return
    rewriteAttributes(element)
    const children = Array.from(node.childNodes ?? [])
    for (const child of children) rewriteNode(child)
    return
  }
  if (node.nodeType !== TEXT_NODE) return
  const text = node as Text
  const next = rewriteBrandText(text.data)
  if (next !== text.data) text.data = next
}

function rewriteTitle(doc: Document): void {
  if (typeof doc.title !== 'string') return
  const next = rewriteBrandText(doc.title)
  if (next !== doc.title) doc.title = next
}

function installFavicon(doc: Document): () => void {
  const head = doc.head
  if (head === null || typeof doc.createElement !== 'function') return () => {}
  const link = doc.createElement('link')
  link.setAttribute('rel', 'icon')
  link.setAttribute('type', 'image/svg+xml')
  link.setAttribute('href', WANCODE_FAVICON)
  link.dataset.plugin = 'dsh-plugin-desktop'
  link.dataset.pluginCss = 'dsh-plugin-desktop/favicon'
  head.appendChild(link)
  return () => { link.remove() }
}

/**
 * Keep visible DeepSeek product copy on the live document rewritten to Wan Code.
 * @param doc - document to restyle; defaults to the renderer document.
 * @returns disposer that disconnects the observer and removes the favicon.
 */
export function installBrandCopy(doc: Document = document): () => void {
  rewriteTitle(doc)
  if (doc.body) rewriteNode(doc.body)
  else if (doc.documentElement) rewriteNode(doc.documentElement)
  const removeFavicon = installFavicon(doc)

  const Observer = globalThis.MutationObserver
  if (Observer === undefined) return removeFavicon

  const observer = new Observer((mutations) => {
    rewriteTitle(doc)
    for (const mutation of mutations) {
      if (mutation.type === 'characterData') rewriteNode(mutation.target)
      else if (mutation.type === 'attributes' && mutation.target.nodeType === ELEMENT_NODE) {
        rewriteAttributes(mutation.target as Element)
      }
      else if (mutation.type === 'childList') {
        for (const added of mutation.addedNodes) rewriteNode(added)
      }
    }
  })
  const root = doc.documentElement ?? doc.body
  if (root) {
    observer.observe(root, {
      subtree: true,
      childList: true,
      characterData: true,
      attributes: true,
      attributeFilter: [...LABEL_ATTRIBUTES],
    })
  }
  return () => {
    observer.disconnect()
    removeFavicon()
  }
}
