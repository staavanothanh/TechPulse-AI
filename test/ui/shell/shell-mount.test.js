import React, { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import App from '../../../client/App.jsx'
import { useTheme } from '../../../client/theme/use-theme.js'
import { useScrollToTop, useScrollTopVisibility } from '../../../client/theme/use-scroll.js'

class FakeNode {
  constructor(ownerDocument, nodeName = 'div', nodeType = 1, text = '') {
    this.ownerDocument = ownerDocument; this.nodeName = nodeName.toUpperCase(); this.tagName = this.nodeName; this.localName = nodeName.toLowerCase(); this.nodeType = nodeType; this.nodeValue = text; this.childNodes = []; this.parentNode = null; this.attributes = new Map(); this.listeners = new Map(); this.style = {}; this.namespaceURI = 'http://www.w3.org/1999/xhtml'; this.isConnected = true
  }
  get parentElement() { return this.parentNode?.nodeType === 1 ? this.parentNode : null }
  get options() { return this.childNodes.filter((child) => child.nodeType === 1) }
  appendChild(child) { child.parentNode = this; this.childNodes.push(child); return child }
  insertBefore(child, before) { child.parentNode = this; const index = this.childNodes.indexOf(before); this.childNodes.splice(index < 0 ? this.childNodes.length : index, 0, child); return child }
  removeChild(child) { const index = this.childNodes.indexOf(child); if (index >= 0) this.childNodes.splice(index, 1); child.parentNode = null; return child }
  setAttribute(name, value) { this.attributes.set(name, String(value)); if (name === 'class') this.className = String(value); if (name === 'id') this.id = String(value); if (name === 'disabled') this.disabled = true }
  removeAttribute(name) { this.attributes.delete(name); if (name === 'disabled') this.disabled = false }
  hasAttribute(name) { return this.attributes.has(name) }
  getAttribute(name) { return this.attributes.get(name) ?? null }
  addEventListener(name, handler) { const handlers = this.listeners.get(name) ?? []; handlers.push(handler); this.listeners.set(name, handlers) }
  removeEventListener(name, handler) { const handlers = this.listeners.get(name) ?? []; this.listeners.set(name, handlers.filter((item) => item !== handler)) }
  dispatchEvent(event) { const next = event.__dispatch && typeof event.__dispatch === 'object' ? event : { type: event.type, ...event, target: event.target ?? this, bubbles: event.bubbles !== false, preventDefault() {}, __dispatch: {} }; next.currentTarget = this; for (const handler of this.listeners.get(event.type) ?? []) handler(next); this[`on${event.type}`]?.(next); if (next.bubbles && this.parentNode) this.parentNode.dispatchEvent(next); return true }
  focus() { this.ownerDocument.activeElement = this }
  contains(node) { return node === this || this.childNodes.some((child) => child.contains?.(node)) }
  get textContent() { return this.nodeType === 3 ? this.nodeValue : this.childNodes.map((child) => child.textContent).join('') }
  set textContent(value) { this.childNodes = [new FakeNode(this.ownerDocument, '#text', 3, String(value))] }
}

class FakeDocument extends FakeNode {
  constructor() { super(null, '#document', 9); this.ownerDocument = this; this.activeElement = null; this.body = new FakeNode(this, 'body'); this.documentElement = new FakeNode(this, 'html'); this.defaultView = { document: this, HTMLElement: FakeNode, HTMLIFrameElement: FakeNode, SVGElement: FakeNode, getComputedStyle: () => ({}), matchMedia: () => ({ matches: false }), localStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} }, addEventListener: () => {}, removeEventListener: () => {}, location: { origin: 'http://localhost:3000' } } }
  createElement(name) { return new FakeNode(this, name) }
  createElementNS(_namespace, name) { return this.createElement(name) }
  createTextNode(text) { return new FakeNode(this, '#text', 3, text) }
  createComment(text) { return new FakeNode(this, '#comment', 8, text) }
}

function findButton(node, text) {
  if (node.nodeType === 1 && node.nodeName === 'BUTTON' && node.textContent.includes(text)) return node
  for (const child of node.childNodes) {
    const match = findButton(child, text)
    if (match) return match
  }
  return null
}

function fakeFetchFor(sessionPayload) {
  return vi.fn(async (input) => {
    const url = new URL(input)
    if (url.pathname.endsWith('/health')) return { ok: true, status: 200, json: async () => ({ data: { status: 'ok', timestamp: '2026-08-18T00:00:00.000Z' } }) }
    if (url.pathname.endsWith('/me')) {
      if (sessionPayload.status === 401) return { ok: false, status: 401, json: async () => ({ error: { code: 'unauthorized', message: 'Unauthorized' } }) }
      return { ok: true, status: 200, json: async () => ({ data: sessionPayload }) }
    }
    if (url.pathname.endsWith('/articles')) return { ok: true, status: 200, json: async () => ({ data: [], meta: { hasNext: false } }) }
    if (url.pathname.endsWith('/search-results')) return { ok: true, status: 200, json: async () => ({ data: [], meta: { hasNext: false } }) }
    if (url.pathname.endsWith('/me/saved-articles')) return { ok: true, status: 200, json: async () => ({ data: [], meta: { hasNext: false } }) }
    if (url.pathname.endsWith('/chat-sessions')) return { ok: true, status: 200, json: async () => ({ data: [], meta: { hasNext: false } }) }
    if (url.pathname.endsWith('/admin/overview')) return { ok: true, status: 200, json: async () => ({ data: { activeSources: 1, pausedSources: 0, sourcesNeedingReview: 0, queuedJobs: 0, failedJobs: 0, articlesNeedingReview: 0, failedIndexes: 0, openTakedowns: 0, failedAccountDeletions: 0, lastSuccessfulIngestionAt: null } }) }
    return { ok: true, status: 200, json: async () => ({ data: {} }) }
  })
}

describe('TechPulse shell (artifact redesign)', () => {
  let previousDocument; let previousWindow; let previousFetch; let root; let host
  afterEach(async () => { if (root) await act(async () => root.unmount()); if (previousFetch) globalThis.fetch = previousFetch; previousFetch = undefined; globalThis.document = previousDocument; globalThis.window = previousWindow; root = null })

  async function mount(sessionPayload) {
    previousDocument = globalThis.document; previousWindow = globalThis.window
    const fakeDocument = new FakeDocument(); globalThis.document = fakeDocument; globalThis.window = fakeDocument.defaultView
    globalThis.fetch = fakeFetchFor(sessionPayload)
    host = fakeDocument.createElement('div'); fakeDocument.body.appendChild(host); root = createRoot(host)
    await act(async () => root.render(React.createElement(App)))
    await act(async () => new Promise((resolve) => setTimeout(resolve, 0)))
  }

  it('renders the guest hero with the locked slogan, auth panel and marquee', async () => {
    await mount({ status: 401 })
    expect(host.textContent).toContain('Nắm nhanh công nghệ.')
    expect(host.textContent).toMatch(/Biết rõ nguồn[\s\u00a0]+gốc/)
    expect(host.textContent).toContain('Tiếp tục đọc tin công nghệ')
    expect(host.textContent).toContain('TechPulse AI')
    expect(host.textContent).toContain('© 2026 TechPulse AI')
    expect(host.textContent).not.toContain('STEP 02')
  })

  it('renders a reader topnav with Feed/Tìm kiếm/Đã lưu/Hỏi đáp and mobile nav', async () => {
    await mount({ user: { id: 'u1', email: 'user@test.dev', role: 'user', topicPreferences: [] }, csrfToken: 'csrf' })
    expect(host.textContent).toContain('Feed')
    expect(host.textContent).toContain('Tìm kiếm')
    expect(host.textContent).toContain('Đã lưu')
    expect(host.textContent).toContain('Hỏi đáp')
    expect(host.textContent).toContain('Tài khoản')
  })

  it('renders the admin sidebar with the dot-grid brand and all destinations', async () => {
    await mount({ user: { id: 'a1', email: 'admin@test.dev', role: 'admin', topicPreferences: [] }, csrfToken: 'csrf' })
    expect(host.textContent).toContain('TechPulse Admin')
    expect(host.textContent).toContain('Tổng quan')
    expect(host.textContent).toContain('Jobs')
    expect(host.textContent).toContain('Source Registry')
    expect(host.textContent).toContain('Audit bất biến')
    expect(host.textContent).toContain('Tài khoản')
  })

  it('keeps the theme toggle switching data-theme and persisting to localStorage', async () => {
    previousDocument = globalThis.document; previousWindow = globalThis.window
    const fakeDocument = new FakeDocument(); globalThis.document = fakeDocument; globalThis.window = fakeDocument.defaultView
    fakeDocument.documentElement.setAttribute('data-theme', 'light')
    const stored = {}
    fakeDocument.defaultView.localStorage = { getItem: (k) => stored[k] ?? null, setItem: (k, v) => { stored[k] = v } }
    globalThis.window.localStorage = fakeDocument.defaultView.localStorage
    const setAttribute = vi.fn()
    fakeDocument.documentElement.setAttribute = setAttribute
    let renderedTheme = null
    function Harness() {
      const [theme, toggle] = useTheme()
      renderedTheme = theme
      return React.createElement('button', { type: 'button', onClick: toggle }, 'toggle')
    }
    host = fakeDocument.createElement('div'); fakeDocument.body.appendChild(host); root = createRoot(host)
    await act(async () => root.render(React.createElement(Harness)))
    const button = findButton(host, 'toggle')
    await act(async () => button.dispatchEvent({ type: 'click', target: button, bubbles: true, cancelable: true }))
    expect(renderedTheme).toBe('dark')
    expect(stored['techpulse-theme']).toBe('dark')
  })

  it('scrolls to top with rAF and exposes visibility past threshold', async () => {
    previousDocument = globalThis.document; previousWindow = globalThis.window
    const fakeDocument = new FakeDocument(); globalThis.document = fakeDocument; globalThis.window = fakeDocument.defaultView
    let visible = false
    let scrollTop = null
    function Harness() {
      const toTop = useScrollToTop()
      const isVisible = useScrollTopVisibility(320)
      visible = isVisible
      scrollTop = toTop
      return React.createElement('button', { type: 'button', onClick: toTop }, 'up')
    }
    host = fakeDocument.createElement('div'); fakeDocument.body.appendChild(host); root = createRoot(host)
    await act(async () => root.render(React.createElement(Harness)))
    expect(typeof scrollTop).toBe('function')
    expect(visible).toBe(false)
  })
})
