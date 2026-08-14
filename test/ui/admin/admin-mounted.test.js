import React, { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import AdminOperations, { AdminConfirmationDialog } from '../../../client/features/admin/operations/AdminOperations.jsx'
import { projectTakedownDetail } from '../../../client/features/admin/operations/admin-utils.js'

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
  constructor() { super(null, '#document', 9); this.ownerDocument = this; this.activeElement = null; this.body = new FakeNode(this, 'body'); this.documentElement = new FakeNode(this, 'html'); this.defaultView = { document: this, HTMLElement: FakeNode, HTMLIFrameElement: FakeNode, SVGElement: FakeNode, getComputedStyle: () => ({}) } }
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

function findNode(node, predicate) {
  if (predicate(node)) return node
  for (const child of node.childNodes) {
    const match = findNode(child, predicate)
    if (match) return match
  }
  return null
}

describe('Step 11 mounted admin interactions', () => {
  let previousDocument; let previousWindow; let previousFetch; let root; let host
  afterEach(async () => { if (root) await act(async () => root.unmount()); vi.useRealTimers(); if (previousFetch) globalThis.fetch = previousFetch; previousFetch = undefined; globalThis.document = previousDocument; globalThis.window = previousWindow; root = null })

  it('mounts loading then resolves canonical overview without exposing debug fields', async () => {
    previousDocument = globalThis.document; previousWindow = globalThis.window
    const fakeDocument = new FakeDocument(); globalThis.document = fakeDocument; globalThis.window = fakeDocument.defaultView
    host = fakeDocument.createElement('div'); fakeDocument.body.appendChild(host); root = createRoot(host)
    let resolveOverview
    const api = { getAdminOverview: vi.fn(() => new Promise((resolve) => { resolveOverview = resolve })) }
    await act(async () => root.render(React.createElement(AdminOperations, { api, route: 'overview', onNavigate: vi.fn() })))
    expect(host.textContent).toContain('Đang tải tổng quan')
    await act(async () => new Promise((resolve) => setTimeout(resolve, 0)))
    await act(async () => resolveOverview({ data: { activeSources: 2, pausedSources: 1, sourcesNeedingReview: 0, queuedJobs: 1, failedJobs: 0, articlesNeedingReview: 0, failedIndexes: 0, openTakedowns: 0, failedAccountDeletions: 0, lastSuccessfulIngestionAt: null } }))
    expect(host.textContent).toContain('Việc cần xử lý')
    expect(host.textContent).toContain('failedJobs')
    expect(host.textContent).not.toMatch(/provider|vector|stack|requesterContact/i)
  })

  it('does not refetch or reset on a same-route parent rerender', async () => {
    vi.useFakeTimers()
    previousDocument = globalThis.document; previousWindow = globalThis.window
    const fakeDocument = new FakeDocument(); globalThis.document = fakeDocument; globalThis.window = fakeDocument.defaultView
    host = fakeDocument.createElement('div'); fakeDocument.body.appendChild(host); root = createRoot(host)
    const api = {
      getAdminOverview: vi.fn(async () => ({ data: { activeSources: 2, pausedSources: 1, sourcesNeedingReview: 0, queuedJobs: 1, failedJobs: 0, articlesNeedingReview: 0, failedIndexes: 0, openTakedowns: 0, failedAccountDeletions: 0, lastSuccessfulIngestionAt: null } })),
    }
    const onNavigate = vi.fn()
    await act(async () => root.render(React.createElement(AdminOperations, { api, route: 'overview', onNavigate, onSessionExpired: vi.fn() })))
    await act(async () => vi.runOnlyPendingTimersAsync())
    expect(api.getAdminOverview).toHaveBeenCalledTimes(1)
    expect(host.textContent).toContain('Việc cần xử lý')

    await act(async () => root.render(React.createElement(AdminOperations, { api, route: 'overview', onNavigate, onSessionExpired: vi.fn() })))
    expect(api.getAdminOverview).toHaveBeenCalledTimes(1)
    expect(host.textContent).toContain('Việc cần xử lý')
    await act(async () => vi.runOnlyPendingTimersAsync())
    expect(api.getAdminOverview).toHaveBeenCalledTimes(1)
  })

  it('renders no workspace for an unknown admin route without fetching another route', async () => {
    previousDocument = globalThis.document; previousWindow = globalThis.window
    const fakeDocument = new FakeDocument(); globalThis.document = fakeDocument; globalThis.window = fakeDocument.defaultView
    host = fakeDocument.createElement('div'); fakeDocument.body.appendChild(host); root = createRoot(host)
    const api = { getAdminOverview: vi.fn() }
    await act(async () => root.render(React.createElement(AdminOperations, { api, route: 'removed', onNavigate: vi.fn() })))
    await act(async () => new Promise((resolve) => setTimeout(resolve, 0)))
    expect(api.getAdminOverview).not.toHaveBeenCalled()
    expect(host.textContent).not.toContain('Việc cần xử lý')
  })

  it('does not retain a previous route failure when navigating to an unknown route', async () => {
    previousDocument = globalThis.document; previousWindow = globalThis.window
    const fakeDocument = new FakeDocument(); globalThis.document = fakeDocument; globalThis.window = fakeDocument.defaultView
    host = fakeDocument.createElement('div'); fakeDocument.body.appendChild(host); root = createRoot(host)
    const api = { getAdminOverview: vi.fn(async () => { throw { status: 503 } }) }
    await act(async () => root.render(React.createElement(AdminOperations, { api, route: 'overview', onNavigate: vi.fn() })))
    await act(async () => new Promise((resolve) => setTimeout(resolve, 0)))
    expect(host.textContent).toContain('Dịch vụ tạm thời không sẵn sàng')

    await act(async () => root.render(React.createElement(AdminOperations, { api, route: 'removed', onNavigate: vi.fn() })))
    await act(async () => new Promise((resolve) => setTimeout(resolve, 0)))
    expect(api.getAdminOverview).toHaveBeenCalledTimes(1)
    expect(host.textContent).not.toContain('Việc cần xử lý')
    expect(host.textContent).not.toContain('Dịch vụ tạm thời không sẵn sàng')
  })

  it('ignores a pending route response before an unknown route renders', async () => {
    vi.useFakeTimers()
    previousDocument = globalThis.document; previousWindow = globalThis.window
    const fakeDocument = new FakeDocument(); globalThis.document = fakeDocument; globalThis.window = fakeDocument.defaultView
    host = fakeDocument.createElement('div'); fakeDocument.body.appendChild(host); root = createRoot(host)
    const resolvers = []
    const api = { getAdminOverview: vi.fn(() => new Promise((resolve) => { resolvers.push(resolve) })) }
    await act(async () => root.render(React.createElement(AdminOperations, { api, route: 'overview', onNavigate: vi.fn() })))
    await act(async () => vi.runOnlyPendingTimersAsync())
    expect(api.getAdminOverview).toHaveBeenCalledTimes(1)

    await act(async () => root.render(React.createElement(AdminOperations, { api, route: 'removed', onNavigate: vi.fn() })))
    await act(async () => resolvers[0]({ data: { activeSources: 99, pausedSources: 0, sourcesNeedingReview: 0, queuedJobs: 0, failedJobs: 0, articlesNeedingReview: 0, failedIndexes: 0, openTakedowns: 0, failedAccountDeletions: 0, lastSuccessfulIngestionAt: null } }))
    expect(host.textContent).not.toContain('Việc cần xử lý')

    await act(async () => root.render(React.createElement(AdminOperations, { api, route: 'overview', onNavigate: vi.fn() })))
    expect(host.textContent).toContain('Đang tải tổng quan')
  })

  it('ignores a pending route failure before an unknown route renders', async () => {
    vi.useFakeTimers()
    previousDocument = globalThis.document; previousWindow = globalThis.window
    const fakeDocument = new FakeDocument(); globalThis.document = fakeDocument; globalThis.window = fakeDocument.defaultView
    host = fakeDocument.createElement('div'); fakeDocument.body.appendChild(host); root = createRoot(host)
    const rejectors = []
    const api = { getAdminOverview: vi.fn(() => new Promise((_, reject) => { rejectors.push(reject) })) }
    await act(async () => root.render(React.createElement(AdminOperations, { api, route: 'overview', onNavigate: vi.fn() })))
    await act(async () => vi.runOnlyPendingTimersAsync())
    expect(api.getAdminOverview).toHaveBeenCalledTimes(1)

    await act(async () => root.render(React.createElement(AdminOperations, { api, route: 'removed', onNavigate: vi.fn() })))
    await act(async () => rejectors[0]({ status: 503 }))
    expect(api.getAdminOverview).toHaveBeenCalledTimes(1)
    expect(host.textContent).not.toContain('Việc cần xử lý')
    expect(host.textContent).not.toContain('Dịch vụ tạm thời không sẵn sàng')
  })

  it('invalidates an old response during route render before passive cleanup', async () => {
    vi.useFakeTimers()
    previousDocument = globalThis.document; previousWindow = globalThis.window
    const fakeDocument = new FakeDocument(); globalThis.document = fakeDocument; globalThis.window = fakeDocument.defaultView
    host = fakeDocument.createElement('div'); fakeDocument.body.appendChild(host); root = createRoot(host)
    let resolveOverview
    const api = { getAdminOverview: vi.fn(() => new Promise((resolve) => { resolveOverview = resolve })) }
    function Harness({ route }) {
      React.useLayoutEffect(() => {
        if (route === 'removed') resolveOverview?.({ data: { activeSources: 99, pausedSources: 0, sourcesNeedingReview: 0, queuedJobs: 0, failedJobs: 0, articlesNeedingReview: 0, failedIndexes: 0, openTakedowns: 0, failedAccountDeletions: 0, lastSuccessfulIngestionAt: null } })
      }, [route])
      return React.createElement(AdminOperations, { api, route, onNavigate: vi.fn() })
    }
    await act(async () => root.render(React.createElement(Harness, { route: 'overview' })))
    await act(async () => vi.runOnlyPendingTimersAsync())
    expect(api.getAdminOverview).toHaveBeenCalledTimes(1)

    await act(async () => root.render(React.createElement(Harness, { route: 'removed' })))
    expect(host.textContent).not.toContain('99')
  })

  it('resets list filters and data when switching admin routes', async () => {
    vi.useFakeTimers()
    previousFetch = globalThis.fetch
    const fetchSpy = vi.fn(async () => ({}))
    globalThis.fetch = fetchSpy
    previousDocument = globalThis.document; previousWindow = globalThis.window
    const fakeDocument = new FakeDocument(); globalThis.document = fakeDocument; globalThis.window = fakeDocument.defaultView
    host = fakeDocument.createElement('div'); fakeDocument.body.appendChild(host); root = createRoot(host)
    const api = {
      listAdminArticles: vi.fn(async ({ fetchImpl }) => {
        await fetchImpl('https://techpulse.test/api/v1/admin/articles', {})
        return { data: [{ id: 'article-old', sourceId: 'source-old', titleOriginal: 'Bài cũ', status: 'published', leadMediaStatus: 'none', summaryStatus: 'ready', embeddingStatus: 'ready' }], meta: { hasNext: false } }
      }),
      listTakedownRequests: vi.fn(async ({ fetchImpl }) => {
        await fetchImpl('https://techpulse.test/api/v1/admin/takedowns', {})
        return { data: [{ id: 'takedown-new', status: 'received', targetType: 'article', targetIds: ['article-new'], requestedScope: ['metadata'], createdAt: '2026-08-13T00:00:00.000Z', updatedAt: '2026-08-13T00:00:00.000Z' }], meta: { hasNext: false } }
      }),
    }
    await act(async () => root.render(React.createElement(AdminOperations, { api, route: 'articles', onNavigate: vi.fn() })))
    await act(async () => vi.runOnlyPendingTimersAsync())
    expect(host.textContent).toContain('Bài cũ')

    const statusFilter = findNode(host, (node) => node.nodeName === 'SELECT' && node.id === 'admin-filter-status')
    const filterForm = findNode(host, (node) => node.nodeName === 'FORM')
    expect(statusFilter).not.toBeNull()
    expect(filterForm).not.toBeNull()
    statusFilter.value = 'published'
    await act(async () => statusFilter.dispatchEvent({ type: 'change', target: statusFilter, bubbles: true, cancelable: true }))
    await act(async () => filterForm.dispatchEvent({ type: 'submit', target: filterForm, bubbles: true, cancelable: true }))
    const articleFetches = fetchSpy.mock.calls.filter(([input]) => new URL(input).pathname.endsWith('/articles'))
    expect(articleFetches.map(([input]) => new URL(input).search)).toEqual(['', '?status=published'])
    expect(host.textContent).toContain('Bài cũ')

    await act(async () => root.render(React.createElement(AdminOperations, { api, route: 'governance', onNavigate: vi.fn() })))
    expect(host.textContent).not.toContain('Bài cũ')
    await act(async () => vi.runOnlyPendingTimersAsync())
    const takedownFetch = fetchSpy.mock.calls.find(([input]) => new URL(input).pathname.endsWith('/takedowns'))
    expect(new URL(takedownFetch[0]).search).toBe('')
    expect(host.textContent).not.toContain('Bài cũ')
    expect(host.textContent).toContain('takedown-new')
  })

  it('resets loading more when switching admin routes', async () => {
    vi.useFakeTimers()
    previousDocument = globalThis.document; previousWindow = globalThis.window
    const fakeDocument = new FakeDocument(); globalThis.document = fakeDocument; globalThis.window = fakeDocument.defaultView
    host = fakeDocument.createElement('div'); fakeDocument.body.appendChild(host); root = createRoot(host)
    let articleCalls = 0
    const api = {
      listAdminArticles: vi.fn(async () => {
        articleCalls += 1
        if (articleCalls === 1) return { data: [{ id: 'article-a', sourceId: 'source-a', titleOriginal: 'Bài A', status: 'published', leadMediaStatus: 'none', summaryStatus: 'ready', embeddingStatus: 'ready' }], meta: { hasNext: true, nextCursor: 'cursor-a' } }
        return new Promise(() => {})
      }),
      listTakedownRequests: vi.fn(async () => ({ data: [{ id: 'takedown-b', status: 'received', targetType: 'article', targetIds: ['article-b'], requestedScope: ['metadata'], createdAt: '2026-08-13T00:00:00.000Z', updatedAt: '2026-08-13T00:00:00.000Z' }], meta: { hasNext: true, nextCursor: 'cursor-b' } })),
    }
    await act(async () => root.render(React.createElement(AdminOperations, { api, route: 'articles', onNavigate: vi.fn() })))
    await act(async () => vi.runOnlyPendingTimersAsync())
    const loadMore = findButton(host, 'Tải thêm')
    expect(loadMore).not.toBeNull()
    await act(async () => loadMore.dispatchEvent({ type: 'click', target: loadMore, bubbles: true, cancelable: true }))
    expect(findButton(host, 'Đang tải thêm…')?.disabled).toBe(true)

    await act(async () => root.render(React.createElement(AdminOperations, { api, route: 'governance', onNavigate: vi.fn() })))
    await act(async () => vi.runOnlyPendingTimersAsync())
    const governanceLoadMore = findButton(host, 'Tải thêm')
    expect(governanceLoadMore).not.toBeNull()
    expect(governanceLoadMore.disabled).toBe(false)
  })

  it('fetches a different route instead of reusing initialData', async () => {
    vi.useFakeTimers()
    previousDocument = globalThis.document; previousWindow = globalThis.window
    const fakeDocument = new FakeDocument(); globalThis.document = fakeDocument; globalThis.window = fakeDocument.defaultView
    host = fakeDocument.createElement('div'); fakeDocument.body.appendChild(host); root = createRoot(host)
    const initialData = { activeSources: 4, pausedSources: 1, sourcesNeedingReview: 2, queuedJobs: 3, failedJobs: 1, articlesNeedingReview: 2, failedIndexes: 1, openTakedowns: 1, failedAccountDeletions: 1, lastSuccessfulIngestionAt: null }
    const api = {
      listAdminArticles: vi.fn(async () => ({ data: [{ id: 'article-new', sourceId: 'source-new', titleOriginal: 'Bài mới', status: 'published', leadMediaStatus: 'none', summaryStatus: 'ready', embeddingStatus: 'ready' }], meta: { hasNext: false } })),
    }
    await act(async () => root.render(React.createElement(AdminOperations, { api, route: 'overview', initialData, onNavigate: vi.fn() })))
    expect(api.listAdminArticles).not.toHaveBeenCalled()
    expect(host.textContent).toContain('Việc cần xử lý')

    await act(async () => root.render(React.createElement(AdminOperations, { api, route: 'articles', initialData, onNavigate: vi.fn() })))
    expect(host.textContent).toContain('Đang tải articles')
    await act(async () => vi.runOnlyPendingTimersAsync())
    expect(api.listAdminArticles).toHaveBeenCalledTimes(1)
    expect(host.textContent).toContain('Bài mới')
  })

  it('loads the canonical article detail before showing detail controls', async () => {
    previousDocument = globalThis.document; previousWindow = globalThis.window
    const fakeDocument = new FakeDocument(); globalThis.document = fakeDocument; globalThis.window = fakeDocument.defaultView
    host = fakeDocument.createElement('div'); fakeDocument.body.appendChild(host); root = createRoot(host)
    const api = {
      listAdminArticles: vi.fn(async () => ({ data: [{ id: 'a1', sourceId: 's1', titleOriginal: 'Bài một', status: 'published', leadMediaStatus: 'none', summaryStatus: 'ready', embeddingStatus: 'ready' }], meta: { hasNext: false } })),
      getAdminArticle: vi.fn(async () => ({ data: { id: 'a1', sourceId: 's1', titleOriginal: 'Bài một', status: 'published', leadMediaStatus: 'none', summaryStatus: 'ready', embeddingStatus: 'ready', topics: ['AI'] } })),
    }
    await act(async () => root.render(React.createElement(AdminOperations, { api, route: 'articles', onNavigate: vi.fn() })))
    await act(async () => new Promise((resolve) => setTimeout(resolve, 0)))
    const openButton = findButton(host, 'Mở a1')
    expect(openButton).not.toBeNull()
    await act(async () => openButton.dispatchEvent({ type: 'click', target: openButton, bubbles: true, cancelable: true }))
    expect(api.getAdminArticle).toHaveBeenCalledWith(expect.objectContaining({ pathParams: { articleId: 'a1' } }))
    expect(host.textContent).toContain('Article a1')
    expect(findButton(host, 'Đổi hiển thị media')).toBeNull()
    expect(host.textContent).toContain('không có lead media')
  })

  it('renders a removed article tombstone without metadata or mutation controls', async () => {
    previousDocument = globalThis.document; previousWindow = globalThis.window
    const fakeDocument = new FakeDocument(); globalThis.document = fakeDocument; globalThis.window = fakeDocument.defaultView
    host = fakeDocument.createElement('div'); fakeDocument.body.appendChild(host); root = createRoot(host)
    const tombstone = { id: 'a-removed', sourceId: 's1', status: 'removed', removalPolicyVersion: 4, removedAt: '2026-08-14T00:00:00.000Z', updatedAt: '2026-08-14T00:00:00.000Z' }
    const api = {
      listAdminArticles: vi.fn(async () => ({ data: [tombstone], meta: { hasNext: false } })),
      getAdminArticle: vi.fn(async () => ({ data: tombstone })),
    }
    await act(async () => root.render(React.createElement(AdminOperations, { api, route: 'articles', onNavigate: vi.fn() })))
    await act(async () => new Promise((resolve) => setTimeout(resolve, 0)))
    const openButton = findButton(host, 'Mở a-removed')
    await act(async () => openButton.dispatchEvent({ type: 'click', target: openButton, bubbles: true, cancelable: true }))
    expect(host.textContent).toContain('Metadata của article đã được xóa')
    expect(host.textContent).toContain('Không có mutation control')
    expect(findButton(host, 'Ẩn article')).toBeNull()
    expect(findButton(host, 'Sửa topics')).toBeNull()
    expect(findButton(host, 'Tạo summary job')).toBeNull()
    expect(host.textContent).not.toContain('private.example')
  })

  it('restores the exact dialog trigger after the parent unmounts the dialog', async () => {
    previousDocument = globalThis.document; previousWindow = globalThis.window
    const fakeDocument = new FakeDocument(); globalThis.document = fakeDocument; globalThis.window = fakeDocument.defaultView
    host = fakeDocument.createElement('div'); fakeDocument.body.appendChild(host); root = createRoot(host)
    function Harness() {
      const [open, setOpen] = React.useState(false)
      const [trigger, setTrigger] = React.useState(null)
      return React.createElement(React.Fragment, null,
        React.createElement('button', { type: 'button', onClick: (event) => { setTrigger(event.currentTarget); setOpen(true) } }, 'Mở dialog'),
        React.createElement(AdminConfirmationDialog, { open, trigger, title: 'Xác nhận', consequence: 'Thao tác an toàn.', reasonCode: 'article_status_changed', onCancel: () => setOpen(false), onConfirm: vi.fn() }),
      )
    }
    await act(async () => root.render(React.createElement(Harness)))
    const trigger = findButton(host, 'Mở dialog')
    await act(async () => trigger.dispatchEvent({ type: 'click', target: trigger, bubbles: true, cancelable: true }))
    const cancel = findButton(host, 'Quay lại')
    expect(cancel).not.toBeNull()
    await act(async () => cancel.dispatchEvent({ type: 'click', target: cancel, bubbles: true, cancelable: true }))
    expect(fakeDocument.activeElement).toBe(trigger)
  })

  it('renders a canonical pre-purge takedown transition and sends its fixed reason code', async () => {
    previousDocument = globalThis.document; previousWindow = globalThis.window
    const fakeDocument = new FakeDocument(); globalThis.document = fakeDocument; globalThis.window = fakeDocument.defaultView
    host = fakeDocument.createElement('div'); fakeDocument.body.appendChild(host); root = createRoot(host)
    const api = {
      listTakedownRequests: vi.fn(async () => ({ data: [{ id: 'td1', status: 'received', targetType: 'article', targetIds: ['a1'], requestedScope: ['metadata'], createdAt: '2026-08-13T00:00:00.000Z', updatedAt: '2026-08-13T00:00:00.000Z' }], meta: { hasNext: false } })),
      updateTakedownRequest: vi.fn(async () => ({ data: { id: 'td1', status: 'reviewing', targetType: 'article', targetIds: ['a1'], requestedScope: ['metadata'], completion: { hidden: false, metadataRemoved: false, mediaMetadataRemoved: false, summaryRemoved: false, embeddingRemoved: false, historicalChatCitationsRedacted: false }, decisionReasonCode: 'takedown_review_started' } })),
    }
    await act(async () => root.render(React.createElement(AdminOperations, { api, csrfToken: 'csrf', route: 'governance', onNavigate: vi.fn() })))
    await act(async () => new Promise((resolve) => setTimeout(resolve, 0)))
    const reviewButton = findButton(host, 'Bắt đầu review')
    expect(reviewButton).not.toBeNull()
    await act(async () => reviewButton.dispatchEvent({ type: 'click', target: reviewButton, bubbles: true, cancelable: true }))
    const confirmButton = findButton(host, 'Xác nhận')
    expect(confirmButton).not.toBeNull()
    await act(async () => confirmButton.dispatchEvent({ type: 'click', target: confirmButton, bubbles: true, cancelable: true }))
    expect(api.updateTakedownRequest).toHaveBeenCalledWith(expect.objectContaining({ pathParams: { takedownRequestId: 'td1' }, body: JSON.stringify({ status: 'reviewing', reasonCode: 'takedown_review_started' }) }))
  })

  it('keeps completion disabled until projected detail proves every requested scope is complete', async () => {
    previousDocument = globalThis.document; previousWindow = globalThis.window
    const fakeDocument = new FakeDocument(); globalThis.document = fakeDocument; globalThis.window = fakeDocument.defaultView
    host = fakeDocument.createElement('div'); fakeDocument.body.appendChild(host); root = createRoot(host)
    const api = {
      listTakedownRequests: vi.fn(async () => ({ data: [{ id: 'td2', status: 'approved', targetType: 'article', targetIds: ['a2'], requestedScope: ['metadata', 'summary'], createdAt: '2026-08-13T00:00:00.000Z', updatedAt: '2026-08-13T00:00:00.000Z' }], meta: { hasNext: false } })),
      getTakedownRequest: vi.fn(async () => ({ data: { id: 'td2', status: 'approved', targetType: 'article', targetIds: ['a2'], requestedScope: ['metadata', 'summary'], completion: { hidden: true, metadataRemoved: true, mediaMetadataRemoved: false, summaryRemoved: true, embeddingRemoved: false, historicalChatCitationsRedacted: true }, decisionReasonCode: null } })),
      updateTakedownRequest: vi.fn(async () => ({ data: { id: 'td2', status: 'completed' } })),
    }
    await act(async () => root.render(React.createElement(AdminOperations, { api, csrfToken: 'csrf', route: 'governance', onNavigate: vi.fn() })))
    await act(async () => new Promise((resolve) => setTimeout(resolve, 0)))
    const blockedComplete = findButton(host, 'Hoàn tất takedown')
    expect(blockedComplete).not.toBeNull()
    expect(blockedComplete.disabled).toBe(true)
    await act(async () => findButton(host, 'Mở trạng thái an toàn').dispatchEvent({ type: 'click', target: findButton(host, 'Mở trạng thái an toàn'), bubbles: true, cancelable: true }))
    const enabledComplete = findButton(host, 'Hoàn tất takedown')
    expect(enabledComplete.disabled).toBe(false)
    await act(async () => enabledComplete.dispatchEvent({ type: 'click', target: enabledComplete, bubbles: true, cancelable: true }))
    const confirmButton = findButton(host, 'Xác nhận')
    await act(async () => confirmButton.dispatchEvent({ type: 'click', target: confirmButton, bubbles: true, cancelable: true }))
    expect(api.updateTakedownRequest).toHaveBeenCalledWith(expect.objectContaining({ pathParams: { takedownRequestId: 'td2' }, body: JSON.stringify({ status: 'completed', reasonCode: 'takedown_completed' }) }))
  })

  it('projects takedown detail without requester, case or evidence fields', () => {
    const projected = projectTakedownDetail({ data: { id: 'td1', status: 'reviewing', requesterName: 'secret', requesterContact: 'secret@example.test', reason: 'private case', evidenceNote: 'private evidence', targetType: 'article', targetIds: ['a1'], requestedScope: ['metadata'], completion: { hidden: false }, updatedAt: '2026-08-14T00:00:00.000Z' } })
    expect(projected).toEqual(expect.objectContaining({ id: 'td1', status: 'reviewing', targetIds: ['a1'] }))
    expect(projected).not.toHaveProperty('requesterName')
    expect(projected).not.toHaveProperty('requesterContact')
    expect(projected).not.toHaveProperty('reason')
    expect(projected).not.toHaveProperty('evidenceNote')
  })
})
