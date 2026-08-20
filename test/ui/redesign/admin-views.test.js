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
} from '../../../client/redesign/admin/AdminViews.jsx'
import {
  artifactJobRequest,
  createIdempotencyKey,
  createIdempotencyKeyStore,
  isAdminJobRetryable,
  listMeta,
  mutateAdmin,
} from '../../../client/redesign/admin/admin-data.js'

const session = { user: { id: 'admin-opaque', role: 'admin' }, csrfToken: 'csrf-in-memory' }

describe('admin redesign views', () => {
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
