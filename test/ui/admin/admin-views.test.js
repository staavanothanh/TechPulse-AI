import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import {
  AdminArticlesView,
  AdminAuditView,
  AdminConfirmDialog,
  AdminJobsView,
  AdminSourcesView,
  AdminUsersView,
} from '../../../client/features/admin/ui/AdminViews.jsx'
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
  isAdminJobRetryable,
  listMeta,
  mutateAdmin,
} from '../../../client/features/admin/ui/admin-data.js'

const session = { user: { id: 'admin-opaque', role: 'admin' }, csrfToken: 'csrf-in-memory' }

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
      idempotencyIntent: 'status:article-opaque',
      idempotencyStore: keys,
    }

    await expect(mutateAdmin(api, 'updateAdminArticle', options)).rejects.toThrow(
      'network interrupted',
    )
    const firstKey = api.updateAdminArticle.mock.calls[0][0].headers['Idempotency-Key']
    expect(firstKey).toBe(keys.get('status:article-opaque'))

    await mutateAdmin(api, 'updateAdminArticle', options)
    const secondKey = api.updateAdminArticle.mock.calls[1][0].headers['Idempotency-Key']
    expect(secondKey).toBe(firstKey)
    expect(keys.get('status:article-opaque')).toBeUndefined()
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
        idempotencyIntent: 'status:article-opaque',
        idempotencyStore: keys,
      }),
    ).rejects.toMatchObject({ status: 409, code: 'idempotency_mismatch' })
    expect(keys.get('status:article-opaque')).toBeUndefined()
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

  it('keeps source creation behind an explicit Add source action', () => {
    const html = renderToStaticMarkup(
      React.createElement(AdminSourcesView, {
        api: {},
        session,
        initialData: { data: [], meta: { hasNext: false } },
      }),
    )

    expect(html).toMatch(/>\+ Thêm nguồn<|aria-label="Thêm nguồn"/)
    expect(html).not.toContain('Tạo draft source')
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
})
