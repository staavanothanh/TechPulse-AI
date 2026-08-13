import React, { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import ChatSessionList from '../../../client/features/qa/ChatSessionList.jsx'

class FakeNode {
  constructor(ownerDocument, nodeName = 'div', nodeType = 1, text = '') {
    this.ownerDocument = ownerDocument
    this.nodeName = nodeName.toUpperCase()
    this.tagName = this.nodeName
    this.localName = nodeName.toLowerCase()
    this.nodeType = nodeType
    this.nodeValue = text
    this.childNodes = []
    this.parentNode = null
    this.attributes = new Map()
    this.listeners = new Map()
    this.style = {}
    this.namespaceURI = 'http://www.w3.org/1999/xhtml'
    this.isConnected = true
  }
  get parentElement() { return this.parentNode?.nodeType === 1 ? this.parentNode : null }
  appendChild(child) { child.parentNode = this; this.childNodes.push(child); return child }
  insertBefore(child, before) { child.parentNode = this; const index = this.childNodes.indexOf(before); this.childNodes.splice(index < 0 ? this.childNodes.length : index, 0, child); return child }
  removeChild(child) { const index = this.childNodes.indexOf(child); if (index >= 0) this.childNodes.splice(index, 1); child.parentNode = null; return child }
  setAttribute(name, value) { this.attributes.set(name, String(value)); if (name === 'class') this.className = String(value); if (name === 'id') this.id = String(value) }
  removeAttribute(name) { this.attributes.delete(name) }
  hasAttribute(name) { return this.attributes.has(name) }
  getAttribute(name) { return this.attributes.get(name) ?? null }
  addEventListener(name, handler) { this.listeners.set(name, handler) }
  removeEventListener(name) { this.listeners.delete(name) }
  dispatchEvent(event) { const next = { ...event, target: event.target ?? this, currentTarget: this, bubbles: event.bubbles !== false, preventDefault() {} }; this.listeners.get(event.type)?.(next); if (next.bubbles && this.parentNode) this.parentNode.dispatchEvent(next); return true }
  focus() { this.ownerDocument.activeElement = this }
  contains(node) { return node === this || this.childNodes.some((child) => child.contains?.(node)) }
  get textContent() { return this.nodeType === 3 ? this.nodeValue : this.childNodes.map((child) => child.textContent).join('') }
  set textContent(value) { this.childNodes = [new FakeNode(this.ownerDocument, '#text', 3, String(value))] }
}

class FakeDocument extends FakeNode {
  constructor() {
    super(null, '#document', 9)
    this.ownerDocument = this
    this.activeElement = null
    this.body = new FakeNode(this, 'body')
    this.documentElement = new FakeNode(this, 'html')
    this.defaultView = { document: this, HTMLElement: FakeNode, HTMLIFrameElement: FakeNode, SVGElement: FakeNode, getComputedStyle: () => ({}) }
  }
  createElement(name) { return new FakeNode(this, name) }
  createElementNS(_namespace, name) { return this.createElement(name) }
  createTextNode(text) { return new FakeNode(this, '#text', 3, text) }
  createComment(text) { return new FakeNode(this, '#comment', 8, text) }
}

describe('Step 10 mounted Q&A list interaction', () => {
  let documentRef
  let host
  let root

  afterEach(async () => {
    if (root) await act(async () => root.unmount())
    globalThis.document = documentRef
    root = null
  })

  it('mounts a list, keeps the loaded row during refresh error, and updates retry state', async () => {
    documentRef = globalThis.document
    const fakeDocument = new FakeDocument()
    globalThis.document = fakeDocument
    globalThis.window = fakeDocument.defaultView
    host = fakeDocument.createElement('div')
    root = createRoot(host)
    const onRetry = vi.fn()
    await act(async () => root.render(React.createElement(ChatSessionList, { sessions: [{ id: 's1', title: 'Phiên đã tải', updatedAt: '2026-08-12T00:00:00.000Z' }], listError: { status: 503 }, onRetry })))
    expect(host.textContent).toContain('Phiên đã tải')
    expect(host.textContent).toContain('Đọc lại lịch sử')
    await act(async () => root.render(React.createElement(ChatSessionList, { sessions: [{ id: 's1', title: 'Phiên đã tải', updatedAt: '2026-08-12T00:00:00.000Z' }], listError: { status: 503 }, retryCooldown: 12, onRetry })))
    expect(host.textContent).toContain('Thử lại sau 12 giây')
    expect(onRetry).not.toHaveBeenCalled()
  })
})
