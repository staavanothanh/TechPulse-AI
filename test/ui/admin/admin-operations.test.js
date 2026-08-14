import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import AdminOperations, { AdminConfirmationDialog } from '../../../client/features/admin/operations/AdminOperations.jsx'
import { normalizeAdminFailure } from '../../../client/features/admin/operations/admin-utils.js'

const api = {
  getAdminOverview: vi.fn(),
  listAdminArticles: vi.fn(),
  listTakedownRequests: vi.fn(),
  listAdminUsers: vi.fn(),
  listAccountDeletionRequests: vi.fn(),
  listAuditLogs: vi.fn(),
}

describe('Step 11 admin operations UI', () => {
  it('does not render a workspace for an unknown route', () => {
    const html = renderToStaticMarkup(React.createElement(AdminOperations, { api, csrfToken: 'csrf', route: 'removed', onNavigate: vi.fn() }))
    expect(html).not.toContain('admin-page-head')
    expect(html).not.toContain('Điều hành trạng thái')
  })

  it('does not expose arbitrary transport diagnostics in admin feedback', () => {
    expect(normalizeAdminFailure(new Error('mongodb://secret-host/private?token=secret'))).toEqual({ message: 'Không thể hoàn tất thao tác.' })
  })
  it('renders the approved admin shell and overview exception-first metrics', () => {
    const html = renderToStaticMarkup(React.createElement(AdminOperations, { api, csrfToken: 'csrf', route: 'overview', onNavigate: vi.fn(), initialData: { activeSources: 4, pausedSources: 1, sourcesNeedingReview: 2, queuedJobs: 3, failedJobs: 1, articlesNeedingReview: 2, failedIndexes: 1, openTakedowns: 1, failedAccountDeletions: 1, lastSuccessfulIngestionAt: null } }))
    expect(html).toContain('Điều hành quản trị')
    expect(html).toContain('Việc cần xử lý')
    expect(html).toContain('failedJobs')
    expect(html).toContain('openTakedowns')
    expect(html).toContain('lastSuccessfulIngestionAt')
    expect(html).not.toMatch(/private chat|user question|requesterName|requesterContact|evidenceNote/i)
  })

  it('renders safe canonical records without sensitive fields and labels mobile records', () => {
    const html = renderToStaticMarkup(React.createElement(AdminOperations, {
      api,
      csrfToken: 'csrf',
      route: 'articles',
      onNavigate: vi.fn(),
      initialData: { data: [{ id: 'a1', sourceId: 's1', titleOriginal: 'Bài an toàn', status: 'published', topics: ['AI'], leadMedia: null, leadMediaStatus: 'none', summaryStatus: 'ready', embeddingStatus: 'ready', embeddingModel: 'baai/bge-m3', embeddingVersion: 1, updatedAt: '2026-08-13T00:00:00.000Z' }], meta: { hasNext: false } },
    }))
    expect(html).toContain('Bài an toàn')
    expect(html).toContain('data-label="Article ID"')
    expect(html).toContain('Embedding')
    expect(html).not.toMatch(/excerpt|fullText|vector|provider|rawHtml|requester|evidenceNote/i)
  })

  it('keeps takedown list PII-minimized and shows hide-first progress only', () => {
    const html = renderToStaticMarkup(React.createElement(AdminOperations, {
      api,
      csrfToken: 'csrf',
      route: 'governance',
      onNavigate: vi.fn(),
      initialData: { data: [{ id: 'td1', status: 'approved', targetType: 'article', targetIds: ['a1'], requestedScope: ['metadata', 'summary'], createdAt: '2026-08-13T00:00:00.000Z', updatedAt: '2026-08-13T01:00:00.000Z' }], meta: { hasNext: false } },
    }))
    expect(html).toContain('Hide trước')
    expect(html).toContain('Completion chỉ hợp lệ khi server xác nhận')
    expect(html).not.toMatch(/requesterName|requesterContact|reason|evidenceNote/i)
  })

  it('renders deleted users as null identity and account deletion seven flags', () => {
    const users = renderToStaticMarkup(React.createElement(AdminOperations, { api, csrfToken: 'csrf', route: 'users', onNavigate: vi.fn(), initialData: { data: [{ id: 'u1', email: null, role: null, status: 'deleted', createdAt: '2026-08-13T00:00:00.000Z', updatedAt: '2026-08-13T00:00:00.000Z' }], meta: { hasNext: false } } }))
    expect(users).toContain('Email')
    expect(users).toContain('Đã xóa')
    expect(users).not.toContain('alice@example.com')
    const deletion = renderToStaticMarkup(React.createElement(AdminOperations, { api, csrfToken: 'csrf', route: 'deletions', onNavigate: vi.fn(), initialData: { data: [{ id: 'd1', status: 'failed', priority: 50, attempt: 2, availableAt: '2026-08-13T00:00:00.000Z', completion: { sessionsRevoked: true, sessionsDeleted: false, savedArticlesDeleted: true, chatSessionsDeleted: false, answerAttemptsDeleted: false, userQuotaDataDeleted: false, identityAnonymized: false }, error: { code: 'service_unavailable', message: 'Tạm thời không sẵn sàng', retryable: true, occurredAt: '2026-08-13T00:00:00.000Z' }, requestedAt: '2026-08-12T00:00:00.000Z', startedAt: null, completedAt: null }], meta: { hasNext: false } } }))
    expect(deletion).toContain('answerAttemptsDeleted')
    expect(deletion).toContain('Thử lại xóa dữ liệu')
    expect(deletion).not.toMatch(/stack|token|sessionId|credential/i)
  })

  it('renders read-only audit without mutation controls or arbitrary values', () => {
    const html = renderToStaticMarkup(React.createElement(AdminOperations, { api, csrfToken: 'csrf', route: 'audit', onNavigate: vi.fn(), initialData: { data: [{ id: 'ev1', actorType: 'admin', actorId: 'admin-1', action: 'article_status_changed', targetType: 'article', targetId: 'a1', changedFields: ['status'], stateTransition: { from: 'published', to: 'hidden' }, reasonCode: 'article_status_changed', requestId: 'req1', result: 'succeeded', createdAt: '2026-08-13T00:00:00.000Z' }], meta: { hasNext: false } } }))
    expect(html).toContain('Audit bất biến')
    expect(html).toContain('article_status_changed')
    expect(html).not.toContain('admin-record-actions')
    expect(html).not.toContain('<textarea')
  })

  it.each([
    [401, 'Phiên đăng nhập đã hết hạn'],
    [403, 'Bạn không có quyền quản trị'],
    [404, 'Bản ghi không còn khả dụng'],
    [409, 'Trạng thái vừa thay đổi'],
    [422, 'Dữ liệu bộ lọc chưa hợp lệ'],
    [429, 'Thử lại sau'],
    [500, 'Không thể hoàn tất thao tác'],
    [503, 'Dịch vụ tạm thời không sẵn sàng'],
  ])('maps %s to a safe operator message', (status, expected) => {
    expect(normalizeAdminFailure({ status, retryAfter: 12 }).message).toContain(expected)
  })

  it('provides a focus-trapped confirmation dialog with fixed reason enum and no free-form reason', () => {
    const html = renderToStaticMarkup(React.createElement(AdminConfirmationDialog, { open: true, title: 'Ẩn bài?', consequence: 'Bài sẽ không còn hiển thị.', reasonCode: 'article_status_changed', busy: false, onCancel: vi.fn(), onConfirm: vi.fn() }))
    expect(html).toContain('role="dialog"')
    expect(html).toContain('aria-modal="true"')
    expect(html).toContain('article_status_changed')
    expect(html).toContain('Escape')
    expect(html).not.toMatch(/textarea|name="reason"|reason text/i)
  })
})
