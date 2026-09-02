import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import {
  AdminArticlesView,
  AdminAuditView,
  AdminConfirmDialog,
  AdminJobsView,
  AdminOverviewView,
  AdminSourcesView,
  AdminUsersView,
} from '../../../client/features/admin/ui/AdminViews.jsx'
import { ArticlePreviewDialog } from '../../../client/features/admin/ui/AdminShared.jsx'
import { JobList, JobsActionBar } from '../../../client/features/admin/ui/AdminJobsView.jsx'
import {
  AddSourcePanel,
  SourceCreateForm,
} from '../../../client/features/admin/sources/SourceRegistry.jsx'
import { submitSourceCreate } from '../../../client/features/admin/sources/source-create.js'
import * as LegacySourceForms from '../../../client/features/admin/ui/AdminSourceForms.jsx'
import {
  artifactJobRequest,
  createIdempotencyKey,
  createIdempotencyKeyStore,
  formatAdminDate,
  isAdminJobRetryable,
  listMeta,
  mutateAdmin,
} from '../../../client/features/admin/ui/admin-data.js'

const session = { user: { id: 'admin-opaque', role: 'admin' }, csrfToken: 'csrf-in-memory' }
function renderHookRunner(hookFn) {
  let hookIdx = 0
  const hooks = []
  const dispatcher = {
    useState(initial) {
      const idx = hookIdx++
      if (hooks[idx] === undefined) hooks[idx] = typeof initial === 'function' ? initial() : initial
      return [hooks[idx], (next) => { hooks[idx] = typeof next === 'function' ? next(hooks[idx]) : next }]
    },
    useRef(initial) {
      const idx = hookIdx++
      if (hooks[idx] === undefined) hooks[idx] = { current: initial }
      return hooks[idx]
    },
    useCallback(fn) { hookIdx++; return fn },
    useMemo(fn) { hookIdx++; return fn() },
    useEffect() { hookIdx++ },
  }
  return {
    render(props) {
      hookIdx = 0
      const internals = React.__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE
      const previous = internals.H
      internals.H = dispatcher
      try {
        return hookFn(props)
      } finally {
        internals.H = previous
      }
    },
  }
}

function findElement(element, predicate) {
  if (!element || typeof element !== 'object') return null
  if (predicate(element)) return element
  const children = element.props?.children
  if (Array.isArray(children)) {
    for (const child of children) {
      const found = findElement(child, predicate)
      if (found) return found
    }
  } else if (children && typeof children === 'object') {
    return findElement(children, predicate)
  }
  return null
}


describe('admin feature views', () => {
  it('keeps opaque cursor metadata alongside list response data', () => {
    const response = {
      data: [{ id: 'row-1' }],
      meta: { hasNext: true, nextCursor: 'cursor-next' },
    }
    expect(listMeta(response)).toEqual({ hasNext: true, nextCursor: 'cursor-next' })
  })

  it('keeps artifact jobs on their canonical operation and reuses an intent key', () => {
    expect(artifactJobRequest('summary')).toEqual({
      operation: 'createSummaryJob',
      body: { reasonCode: 'artifact_regeneration_requested' },
    })
    expect(artifactJobRequest('embedding')).toEqual({
      operation: 'createIndexingJob',
      body: { task: 'embedding', reasonCode: 'artifact_regeneration_requested' },
    })
    const keys = createIdempotencyKeyStore()
    const first = createIdempotencyKey('retry:job-opaque', keys)
    expect(first).toBe(createIdempotencyKey('retry:job-opaque', keys))
    expect(createIdempotencyKey('retry:other-job', keys)).not.toBe(first)
  })

  it('keeps an ambiguous mutation key for retry, then releases it after success', async () => {
    const keys = createIdempotencyKeyStore()
    const api = {
      updateAdminArticle: vi
        .fn()
        .mockRejectedValueOnce(new Error('network interrupted'))
        .mockResolvedValueOnce({ status: 204 }),
    }
    const options = {
      csrfToken: 'csrf-in-memory',
      pathParams: { articleId: 'article-opaque' },
      body: { status: 'hidden', reasonCode: 'article_status_changed' },
      idempotencyIntent: 'status:article-opaque:hidden',
      idempotencyStore: keys,
    }

    await expect(mutateAdmin(api, 'updateAdminArticle', options)).rejects.toThrow(
      'network interrupted',
    )
    const firstKey = api.updateAdminArticle.mock.calls[0][0].headers['Idempotency-Key']
    expect(firstKey).toBe(keys.get('status:article-opaque:hidden'))

    await mutateAdmin(api, 'updateAdminArticle', options)
    const secondKey = api.updateAdminArticle.mock.calls[1][0].headers['Idempotency-Key']
    expect(secondKey).toBe(firstKey)
    expect(keys.get('status:article-opaque:hidden')).toBeUndefined()
  })

  it('releases an idempotency key when the server reports a mismatched intent', async () => {
    const keys = createIdempotencyKeyStore()
    const api = {
      updateAdminArticle: vi
        .fn()
        .mockRejectedValue(
          Object.assign(new Error('mismatch'), { status: 409, code: 'idempotency_mismatch' }),
        ),
    }
    await expect(
      mutateAdmin(api, 'updateAdminArticle', {
        csrfToken: 'csrf-in-memory',
        pathParams: { articleId: 'article-opaque' },
        body: { status: 'hidden' },
        idempotencyIntent: 'status:article-opaque:hidden',
        idempotencyStore: keys,
      }),
    ).rejects.toMatchObject({ status: 409, code: 'idempotency_mismatch' })
    expect(keys.get('status:article-opaque:hidden')).toBeUndefined()
  })

  it('only exposes retry for server-eligible attempts across ingestion and indexing', () => {
    expect(isAdminJobRetryable({ status: 'partial', attempt: 2 })).toBe(true)
    expect(isAdminJobRetryable({ status: 'failed', attempt: 2, error: { retryable: true } })).toBe(
      true,
    )
    expect(isAdminJobRetryable({ status: 'failed', attempt: 2, error: { retryable: false } })).toBe(
      false,
    )
    expect(isAdminJobRetryable({ status: 'partial', attempt: 3 })).toBe(false)
  })

  it('uses a fixed-reason confirmation dialog with no free-form reason input', () => {
    const html = renderToStaticMarkup(
      React.createElement(AdminConfirmDialog, {
        open: true,
        title: 'Tạm dừng source?',
        consequence: 'Server sẽ kiểm tra lifecycle.',
        reasonCode: 'source_status_changed',
        onCancel: vi.fn(),
        onConfirm: vi.fn(),
      }),
    )
    expect(html).toContain('role="dialog"')
    expect(html).toContain('source_status_changed')
    expect(html).not.toContain('<textarea')
  })
  it('keeps article action dialogs in the SSR tree with return-focus refs', () => {
    const props = {
      api: {},
      session,
      cacheScope: {},
      initialData: {
        data: [
          {
            id: 'article-focus',
            sourceId: 'source-opaque',
            titleOriginal: 'Bài viết focus',
            status: 'published',
            summaryStatus: 'ready',
            embeddingStatus: 'ready',
            updatedAt: '2026-08-19T08:30:00.000Z',
          },
        ],
        meta: { hasNext: false },
      },
    }
    const runner = renderHookRunner((input) => AdminArticlesView(input))
    const tree = runner.render(props)
    const confirmationDialog = findElement(tree, (element) => element?.type === AdminConfirmDialog)
    const previewDialog = findElement(tree, (element) => element?.type === ArticlePreviewDialog)

    expect(confirmationDialog).not.toBeNull()
    expect(previewDialog).not.toBeNull()
    expect(confirmationDialog.props.returnFocusRef).toBeDefined()
    expect(previewDialog.props.returnFocusRef).toBeDefined()

    const html = renderToStaticMarkup(React.createElement(AdminArticlesView, props))
    expect(html).toContain('admin-articles-view')
    expect(html).not.toContain('undefined')
  })

  it('uses next-status-specific intents and keeps ambiguous retries on the same key', async () => {
    const article = (status) => ({
      id: 'article-opaque',
      sourceId: 'source-opaque',
      titleOriginal: 'Bài viết status',
      status,
      summaryStatus: 'ready',
      embeddingStatus: 'ready',
      updatedAt: '2026-08-19T08:30:00.000Z',
    })
    const renderStatusConfirmation = (status, api) => {
      const props = {
        api,
        session,
        cacheScope: {},
        initialData: { data: [article(status)], meta: { hasNext: false } },
      }
      const runner = renderHookRunner((input) => AdminArticlesView(input))
      const tree = runner.render(props)
      const table = findElement(tree, (element) => element?.props?.label === 'Danh sách articles')
      const actionElement = table.props.children(article(status))
      const actionTree = actionElement.type(actionElement.props)
      const actionButton = findElement(
        actionTree,
        (element) => element?.props?.children === (status === 'published' ? 'Ẩn bài' : 'Hiện bài'),
      )
      const trigger = { focus: vi.fn() }
      actionButton.props.onClick({ currentTarget: trigger })
      const confirmedTree = runner.render(props)
      const dialog = findElement(confirmedTree, (element) => element?.type === AdminConfirmDialog)
      expect(dialog.props.open).toBe(true)
      expect(dialog.props.returnFocusRef.current).toBe(trigger)
      return dialog
    }

    const hiddenApi = {
      updateAdminArticle: vi
        .fn()
        .mockRejectedValueOnce(new Error('network interrupted'))
        .mockResolvedValueOnce({ status: 204 }),
    }
    const hiddenDialog = renderStatusConfirmation('published', hiddenApi)
    await hiddenDialog.props.onConfirm()
    await hiddenDialog.props.onConfirm()
    const hiddenKey = hiddenApi.updateAdminArticle.mock.calls[0][0].headers['Idempotency-Key']
    expect(hiddenKey).toContain('status:article-opaque:hidden')
    expect(hiddenApi.updateAdminArticle.mock.calls[1][0].headers['Idempotency-Key']).toBe(hiddenKey)

    const publishedApi = { updateAdminArticle: vi.fn().mockResolvedValue({ status: 204 }) }
    const publishedDialog = renderStatusConfirmation('hidden', publishedApi)
    await publishedDialog.props.onConfirm()
    const publishedKey = publishedApi.updateAdminArticle.mock.calls[0][0].headers['Idempotency-Key']
    expect(publishedKey).toContain('status:article-opaque:published')
    expect(publishedKey).not.toBe(hiddenKey)
  })


  it('renders created and finished timestamps for ingestion and indexing jobs', () => {
    const createdAt = '2026-08-19T08:30:00.000Z'
    const finishedAt = '2026-08-19T09:45:00.000Z'
    const renderJobList = (kind, overrides = {}) =>
      renderToStaticMarkup(
        React.createElement(JobList, {
          data: {
            data: [
              {
                id: `${kind}-job`,
                sourceId: 'source-opaque',
                articleId: 'article-opaque',
                connectorType: 'rss',
                trigger: 'cron',
                task: 'embedding',
                status: 'succeeded',
                attempt: 1,
                batchSize: 20,
                counters: { fetched: 1, created: 1, failed: 0 },
                error: null,
                createdAt,
                finishedAt,
                ...overrides,
              },
            ],
            meta: { hasNext: false },
          },
          state: 'ready',
          error: null,
          reload: vi.fn(),
          loadMore: vi.fn(),
          loadingMore: false,
          kind,
          onRetry: vi.fn(),
          onCancel: vi.fn(),
          onPreviewArticle: vi.fn(),
          busy: false,
        }),
      )
    const firstRowCells = (html) => {
      const body = html.match(/<tbody>([\s\S]*?)<\/tbody>/)?.[1] ?? ''
      return [...body.matchAll(/<td(?:\s[^>]*)?>([\s\S]*?)<\/td>/g)].map((match) => match[1])
    }

    const ingestionHtml = renderJobList('ingestion', {
      status: 'failed',
      attempt: 2,
      error: { code: 'connector_timeout', message: 'Timeout', retryable: true },
    })
    const indexingHtml = renderJobList('indexing', { status: 'queued' })

    for (const html of [ingestionHtml, indexingHtml]) {
      const cells = firstRowCells(html)
      expect(html).toContain('<th>Tạo lúc</th>')
      expect(html).toContain('<th>Hoàn thành lúc</th>')
      expect(cells[2]).toContain(`dateTime="${createdAt}"`)
      expect(cells[2]).toContain(formatAdminDate(createdAt))
      expect(cells[3]).toContain(`dateTime="${finishedAt}"`)
      expect(cells[3]).toContain(formatAdminDate(finishedAt))
    }

    expect(ingestionHtml).toContain('Thử lại')
    expect(indexingHtml).toContain('Yêu cầu dừng')

    for (const kind of ['ingestion', 'indexing']) {
      const cells = firstRowCells(renderJobList(kind, { finishedAt: null }))
      expect(cells[3]).toContain('Chưa ghi nhận')
    }
  })
  it('passes the indexing preview trigger through the JobList callback', () => {
    const onPreviewArticle = vi.fn()
    const row = {
      id: 'indexing-job',
      articleId: 'article-opaque',
      sourceId: 'source-opaque',
      task: 'embedding',
      trigger: 'admin',
      status: 'succeeded',
      attempt: 1,
      createdAt: '2026-08-19T08:30:00.000Z',
      finishedAt: '2026-08-19T09:30:00.000Z',
      error: null,
    }
    const tree = JobList({
      data: { data: [row], meta: { hasNext: false } },
      state: 'ready',
      error: null,
      reload: vi.fn(),
      loadMore: vi.fn(),
      loadingMore: false,
      kind: 'indexing',
      onRetry: vi.fn(),
      onCancel: vi.fn(),
      onPreviewArticle,
      busy: false,
    })
    const table = tree.props.children
    const articleColumn = table.props.columns.find((column) => column.key === 'articleId')
    const cell = articleColumn.render(row.articleId, row)
    const previewButton = findElement(
      cell,
      (element) => element?.type === 'button' && element?.props?.className === 'admin-btn-preview',
    )
    const trigger = { focus: vi.fn() }

    expect(previewButton).not.toBeNull()
    previewButton.props.onClick({ currentTarget: trigger })
    expect(onPreviewArticle).toHaveBeenCalledWith(row.articleId, trigger)
  })


  it('shows jobs as durable operational records with safe action affordances', () => {
    const html = renderToStaticMarkup(
      React.createElement(AdminJobsView, {
        api: {},
        session,
        initialData: {
          ingestion: {
            data: [
              {
                id: 'job-opaque',
                sourceId: 'source-opaque',
                connectorType: 'rss',
                trigger: 'admin',
                status: 'failed',
                attempt: 2,
                batchSize: 20,
                counters: {
                  fetched: 10,
                  created: 7,
                  updated: 1,
                  duplicate: 1,
                  skipped: 0,
                  failed: 1,
                },
                error: {
                  code: 'connector_timeout',
                  message: 'Nguồn tạm thời không phản hồi',
                  retryable: true,
                  occurredAt: '2026-08-19T08:30:00.000Z',
                },
                createdAt: '2026-08-19T08:30:00.000Z',
                startedAt: null,
                finishedAt: null,
              },
              {
                id: 'job-running',
                sourceId: 'source-opaque',
                connectorType: 'rss',
                trigger: 'cron',
                status: 'running',
                attempt: 1,
                batchSize: 20,
                counters: {
                  fetched: 3,
                  created: 2,
                  updated: 0,
                  duplicate: 0,
                  skipped: 0,
                  failed: 0,
                },
                createdAt: '2026-08-19T08:31:00.000Z',
                startedAt: '2026-08-19T08:32:00.000Z',
                finishedAt: null,
              },
            ],
            meta: { hasNext: false },
          },
          indexing: { data: [], meta: { hasNext: false } },
        },
        onSessionExpired: vi.fn(),
      }),
    )

    expect(html).toContain('Jobs và queue')
    expect(html).toContain('job-opaque')
    expect(html).toContain('Thử lại')
    expect(html).not.toMatch(/idempotencyKey|leaseGeneration|provider|token/i)
  })

  it('renders the job create forms above the queue tables beside the filter controls', () => {
    const ingestionHtml = renderToStaticMarkup(
      React.createElement(AdminJobsView, {
        api: {},
        session,
        initialData: {
          ingestion: { data: [], meta: { hasNext: false } },
          indexing: { data: [], meta: { hasNext: false } },
          sources: {
            data: [
              {
                id: 'source-opaque',
                name: 'Nguồn ingestion',
                sourceKey: 'rss:nguon',
                operationalStatus: 'active',
                licenseStatus: 'permitted',
                technicalCheck: { status: 'passed' },
              },
            ],
            meta: { hasNext: false },
          },
        },
        onSessionExpired: vi.fn(),
      }),
    )
    const toolbarStart = ingestionHtml.indexOf('class="admin-toolbar"')
    const panelStart = ingestionHtml.indexOf('Ingestion queue')
    const ingestionFormStart = ingestionHtml.indexOf('id="admin-job-source"')
    const indexingFormStart = ingestionHtml.indexOf('id="admin-index-article"')

    expect(ingestionFormStart).toBeGreaterThan(-1)
    expect(ingestionFormStart).toBeGreaterThan(toolbarStart)
    expect(ingestionFormStart).toBeLessThan(panelStart)
    expect(indexingFormStart).toBe(-1)

    const ingestionSlotStart = ingestionHtml.indexOf('class="admin-jobs-action-slot"')
    const ingestionSlotEnd = ingestionHtml.indexOf('</form>', ingestionSlotStart)
    expect(ingestionSlotStart).toBeGreaterThan(-1)
    expect(ingestionSlotEnd).toBeGreaterThan(-1)
    expect(ingestionHtml.slice(ingestionSlotStart, ingestionSlotEnd)).toContain(
      'Trigger ingestion',
    )
    expect(ingestionHtml.slice(0, panelStart)).not.toContain(
      'class="admin-inline-form admin-indexing-form"',
    )
  })

  it('exposes the ingestion and indexing forms only inside the toolbar action slot', () => {
    const ingestionProps = {
      sources: [
        {
          id: 'source-opaque',
          name: 'Nguồn ingestion',
          sourceKey: 'rss:nguon',
          operationalStatus: 'active',
          licenseStatus: 'permitted',
          technicalCheck: { status: 'passed' },
        },
      ],
      onSubmit: vi.fn(),
      busy: false,
    }
    const ingestionFormHtml = renderToStaticMarkup(
      React.createElement(JobsActionBar, {
        ingestion: ingestionProps,
        indexing: { onSubmit: vi.fn(), busy: false },
        tab: 'ingestion',
      }),
    )
    expect(ingestionFormHtml).toContain('id="admin-job-source"')
    expect(ingestionFormHtml).toContain('Trigger ingestion')
    expect(ingestionFormHtml).not.toContain('id="admin-index-article"')

    const indexingFormHtml = renderToStaticMarkup(
      React.createElement(JobsActionBar, {
        ingestion: ingestionProps,
        indexing: { onSubmit: vi.fn(), busy: false },
        tab: 'indexing',
      }),
    )
    expect(indexingFormHtml).toContain('id="admin-index-article"')
    expect(indexingFormHtml).toContain('Xếp indexing job')
    expect(indexingFormHtml).not.toContain('id="admin-job-source"')
  })

  it('renders article index health without source text, vectors, or provider payloads', () => {
    const html = renderToStaticMarkup(
      React.createElement(AdminArticlesView, {
        api: {},
        session,
        initialData: {
          data: [
            {
              id: 'article-opaque',
              sourceId: 'source-opaque',
              titleOriginal: 'Bài kiểm tra an toàn',
              status: 'published',
              topics: ['AI'],
              leadMedia: null,
              leadMediaStatus: 'none',
              summaryStatus: 'ready',
              embeddingStatus: 'failed',
              embeddingModel: 'model-safe',
              embeddingVersion: 2,
              updatedAt: '2026-08-19T08:30:00.000Z',
            },
          ],
          meta: { hasNext: false },
        },
      }),
    )

    expect(html).toContain('Bài kiểm tra an toàn')
    expect(html).toContain('Regenerate summary')
    expect(html).toContain('Regenerate embedding')
    expect(html).not.toMatch(/fullText|rawHtml|vector|providerPayload|excerpt/i)
  })

  it('renders Source Registry policy controls without secret or credential inputs', () => {
    const html = renderToStaticMarkup(
      React.createElement(AdminSourcesView, {
        api: {},
        session,
        initialData: {
          data: [
            {
              id: 'source-opaque',
              name: 'Nguồn kiểm thử',
              sourceKey: 'source:test',
              publisherName: 'Nhà xuất bản',
              domain: 'example.test',
              connectorType: 'rss',
              accessMethod: 'rss',
              authorityTier: 'primary',
              operationalStatus: 'active',
              licenseStatus: 'metadata-only',
              policyVersion: 3,
              llmInputScope: 'metadata',
              reconciliation: { status: 'ready', requiredPolicyVersion: 3 },
              technicalCheck: { status: 'passed' },
              connectorConfig: { feedUrl: 'https://example.test/feed.xml' },
              mediaPolicy: { imageMode: 'none', videoMode: 'none', allowedHosts: [] },
              attributionRequired: false,
              attributionText: null,
            },
          ],
          meta: { hasNext: false },
        },
      }),
    )

    expect(html).toContain('Source Registry')
    expect(html).toContain('Nguồn kiểm thử')
    expect(html).toContain('LLM scope')
    expect(html).not.toMatch(/password|secret|api[_-]?key|token|credential/i)
  })

  it('keeps the single add-source control in the source tab and refresh in the header', () => {
    const html = renderToStaticMarkup(
      React.createElement(AdminSourcesView, {
        api: {},
        session,
        initialData: { data: [], meta: { hasNext: false } },
      }),
    )
    const headerStart = html.indexOf('<header')
    const headerEnd = html.indexOf('</header>', headerStart)
    const pageHeader = html.slice(headerStart, headerEnd)

    expect(pageHeader).toContain('>Làm mới<')
    expect(pageHeader).not.toContain('+ Thêm nguồn')
    expect(html.match(/>\+ Thêm nguồn</g)).toHaveLength(1)
    expect(html).not.toContain('M5 12h13')
    expect(html).toContain('role="tablist"')
    expect(html).toContain('id="admin-source-create-tab"')
    expect(html).toContain('id="admin-source-registry-panel"')
    expect(html).toContain('aria-labelledby="admin-source-registry-tab"')
    expect(html).toContain('aria-controls="admin-source-registry-panel"')
    expect(html).not.toContain('aria-controls="admin-source-create-panel"')
    expect(html).toContain('role="tabpanel"')
    expect(html).toContain('tabindex="0"')
    expect(html).toContain('tabindex="-1"')
    expect(html).not.toContain('Tạo nguồn draft')
  })

  it('renders the extracted source form as a disclosure with all supported connectors', () => {
    const html = renderToStaticMarkup(
      React.createElement(AddSourcePanel, {
        onSubmit: vi.fn(),
        busy: false,
        error: null,
      }),
    )
    expect(html).toContain('Thêm nguồn')
    expect(html).not.toContain('Tạo nguồn draft')

    const openHtml = renderToStaticMarkup(
      React.createElement(AddSourcePanel, {
        initialOpen: true,
        onSubmit: vi.fn(),
        busy: false,
        error: null,
      }),
    )
    expect(openHtml).toContain('role="region"')
    expect(openHtml).not.toContain('aria-modal="true"')
    expect(openHtml).toContain('Tạo nguồn draft')
    expect(openHtml).toContain('aria-expanded="true"')

    const formHtml = renderToStaticMarkup(
      React.createElement(SourceCreateForm, {
        onSubmit: vi.fn(),
        busy: false,
        error: 'Dữ liệu nguồn chưa hợp lệ.',
        onClose: vi.fn(),
      }),
    )
    expect(formHtml).toContain('RSS / Atom')
    expect(formHtml).toContain('arXiv API')
    expect(formHtml).toContain('Hacker News API')
    expect(formHtml).toContain('Dữ liệu nguồn chưa hợp lệ.')
    expect(formHtml).toMatch(/maxlength="120"/i)
    expect(formHtml).toMatch(/maxlength="160"/i)
    expect(formHtml).toMatch(/maxlength="253"/i)
    expect(formHtml).not.toMatch(/password|secret|api[_-]?key|token|credential/i)
    expect(formHtml).not.toContain('M5 12h13')
    expect(LegacySourceForms.SourceCreateForm).toBeUndefined()
  })

  it('closes the extracted form only after a successful create response', async () => {
    const form = {
      name: 'Hacker News',
      sourceKey: 'hacker-news',
      publisherName: 'Hacker News',
      domain: 'news.ycombinator.com',
      connectorType: 'hacker-news',
      accessMethod: 'api',
      endpoint: 'topstories',
      batchSize: '20',
    }
    const onClose = vi.fn()
    const onError = vi.fn()
    const onSubmit = vi.fn().mockResolvedValue(null)

    await submitSourceCreate({ form, onSubmit, onClose, onError })
    expect(onSubmit).toHaveBeenCalledWith(
      expect.objectContaining({
        connectorType: 'hacker-news',
        connectorConfig: { kind: 'hacker-news', hackerNewsStream: 'topstories', batchSize: 20 },
      }),
    )
    expect(onClose).not.toHaveBeenCalled()
    expect(onError).not.toHaveBeenCalled()

    onSubmit.mockResolvedValueOnce({ data: { sourceId: 'source-opaque' } })
    await submitSourceCreate({ form, onSubmit, onClose, onError })
    expect(onClose).toHaveBeenCalledTimes(1)

    onSubmit.mockRejectedValueOnce(new Error('network interrupted'))
    await submitSourceCreate({ form, onSubmit, onClose, onError })
    expect(onError).toHaveBeenCalledWith('Không thể tạo source. Hãy kiểm tra dữ liệu và thử lại.')
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('keeps users and audit views PII-minimized and audit read-only', () => {
    const users = renderToStaticMarkup(
      React.createElement(AdminUsersView, {
        api: {},
        session,
        initialData: {
          data: [
            {
              id: 'user-opaque',
              email: null,
              role: null,
              status: 'deleted',
              createdAt: '2026-08-19T08:30:00.000Z',
              updatedAt: '2026-08-19T08:30:00.000Z',
            },
          ],
          meta: { hasNext: false },
        },
      }),
    )
    const audit = renderToStaticMarkup(
      React.createElement(AdminAuditView, {
        api: {},
        session,
        initialData: {
          data: [
            {
              id: 'audit-opaque',
              actorType: 'admin',
              actorId: 'admin-opaque',
              action: 'article_status_changed',
              targetType: 'article',
              targetId: 'article-opaque',
              changedFields: ['status'],
              stateTransition: { from: 'published', to: 'hidden' },
              reasonCode: 'article_status_changed',
              requestId: 'request-opaque',
              result: 'succeeded',
              createdAt: '2026-08-19T08:30:00.000Z',
            },
          ],
          meta: { hasNext: false },
        },
      }),
    )

    expect(users).toContain('Đã xóa')
    expect(users).not.toContain('email@example.com')
    expect(audit).toContain('Audit bất biến')
    expect(audit).toContain('article_status_changed')
    expect(audit).not.toContain('textarea')
    expect(audit).not.toContain('Xóa audit')
  })

  it('navigates to Source Registry when sourcesNeedingReview exception is selected', () => {
    const onNavigate = vi.fn()
    const runner = renderHookRunner((props) => AdminOverviewView(props))
    const vdom = runner.render({
      api: {},
      initialData: { sourcesNeedingReview: 3 },
      onNavigate,
    })
    const button = findElement(
      vdom,
      (el) => el?.type === 'button' && el?.key === 'sourcesNeedingReview',
    )
    expect(button).toBeDefined()
    expect(button).not.toBeNull()
    button.props.onClick()
    expect(onNavigate).toHaveBeenCalledWith('sources')
  })
})
