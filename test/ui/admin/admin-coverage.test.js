import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import {
  AdminAccountView,
  AdminArticlesView,
  AdminAuditView,
  AdminGovernanceView,
  AdminJobsView,
  AdminOverviewView,
  AdminSourcesView,
  AdminUsersView,
} from '../../../client/features/admin/ui/AdminViews.jsx'
import {
  AdminButton,
  AdminConfirmDialog,
  EmptyState,
  ErrorState,
  Icon,
  LoadingState,
  PageHeader,
  Panel,
  ResourceFrame,
  StatusBadge,
  Table,
} from '../../../client/features/admin/ui/AdminShared.jsx'
import {
  AddSourcePanel,
  SourceCreateForm,
} from '../../../client/features/admin/sources/SourceRegistry.jsx'
import {
  SourcePolicy,
  SourcePolicyReviewForm,
} from '../../../client/features/admin/ui/AdminSourceForms.jsx'

const render = (Component, props = {}) =>
  renderToStaticMarkup(React.createElement(Component, props))
const noop = vi.fn()
const session = {
  user: { id: 'admin-1', role: 'admin', email: 'admin@example.test' },
  csrfToken: 'csrf-token',
}
const now = '2026-08-20T08:00:00.000Z'

const source = {
  id: 'source-1',
  name: 'Coverage source',
  sourceKey: 'rss:coverage',
  domain: 'example.com',
  connectorType: 'rss',
  accessMethod: 'rss',
  operationalStatus: 'active',
  licenseStatus: 'permitted',
  policyVersion: 3,
  llmInputScope: 'excerpt',
  attributionRequired: true,
  attributionText: 'Coverage attribution',
  termsUrl: 'https://example.com/terms',
  licenseUrl: 'https://example.com/license',
  evidenceNote: 'Reviewed by the operator.',
  connectorConfig: { kind: 'rss', feedUrl: 'https://example.com/feed.xml', batchSize: 20 },
  storageScope: { metadata: true, excerpt: true, summary: true, embedding: true },
  mediaPolicy: {
    imageMode: 'remote-preview',
    videoMode: 'link-only',
    allowedHosts: ['cdn.example.com'],
    attributionRequired: true,
    evidenceNote: 'Media reviewed.',
  },
  technicalCheck: { status: 'passed' },
  reconciliation: { status: 'idle' },
}

const baseJob = {
  id: 'job-1',
  sourceId: source.id,
  articleId: 'article-1',
  connectorType: 'rss',
  trigger: 'admin',
  task: 'embedding',
  attempt: 1,
  batchSize: 20,
  status: 'queued',
  counters: { fetched: 2, created: 1, failed: 0 },
  updatedAt: now,
  error: null,
}

const baseArticle = {
  id: 'article-1',
  sourceId: source.id,
  titleOriginal: 'Original article',
  status: 'published',
  summaryStatus: 'ready',
  embeddingStatus: 'ready',
  updatedAt: now,
}

const baseTakedown = {
  id: 'takedown-1',
  targetType: 'article',
  targetIds: ['article-1', 'article-2'],
  requestedScope: ['metadata', 'summary'],
  status: 'received',
  createdAt: now,
}

const baseDeletion = {
  id: 'deletion-1',
  status: 'failed',
  attempt: 2,
  priority: 50,
  completion: { sessionsRevoked: true, sessionsDeleted: false, identityAnonymized: false },
  error: { code: 'cleanup_failed', message: 'Cleanup needs retry.' },
}

function response(data, meta = { hasNext: false }) {
  return { data, meta }
}

const adminApi = {}

describe('admin coverage states', () => {
  it('covers shared primitives, table states, pagination and all icon fallbacks', () => {
    const iconNames = [
      'activity',
      'archive',
      'arrow',
      'book',
      'check',
      'globe',
      'jobs',
      'articles',
      'audit',
      'grid',
      'lock',
      'moon',
      'pause',
      'play',
      'refresh',
      'shield',
      'sun',
      'user',
      'account',
      'x',
      'unknown',
    ]
    const icons = iconNames.map((name) => render(Icon, { name })).join('')
    const button = render(AdminButton, {
      variant: 'primary',
      size: 'small',
      icon: 'check',
      children: 'Save',
    })
    const badge = render(StatusBadge, { value: 'failed' })
    const header = render(PageHeader, {
      eyebrow: 'Eyebrow',
      title: 'Header',
      description: 'Description',
      action: React.createElement('button', null, 'Action'),
    })
    const panel = render(Panel, {
      title: 'Panel',
      hint: 'Hint',
      children: React.createElement('p', null, 'Body'),
    })
    const loading = render(LoadingState, { label: 'Loading' })
    const error = render(ErrorState, { message: 'Error', onRetry: noop })
    const empty = render(EmptyState, { title: 'Empty', description: 'No rows' })
    const table = render(Table, {
      label: 'Rows',
      columns: [
        { key: 'name', label: 'Name' },
        {
          key: 'status',
          label: 'Status',
          render: (value) => React.createElement(StatusBadge, { value }),
        },
      ],
      rows: [{ id: 'row-1', name: 'Row', status: 'active' }],
      children: (row) => React.createElement('span', null, row.id),
    })
    const emptyTable = render(Table, {
      label: 'Empty rows',
      columns: [],
      rows: [],
      emptyTitle: 'No rows',
    })
    const resourceLoading = render(ResourceFrame, {
      resource: { state: 'loading' },
      loadingLabel: 'Loading resource',
    })
    const resourceError = render(ResourceFrame, {
      resource: { state: 'error', error: 'Resource error', reload: noop },
    })
    const resourceReady = render(ResourceFrame, {
      resource: {
        state: 'ready',
        data: { meta: { hasNext: true }, data: [] },
        loadMore: noop,
        loadingMore: false,
      },
      children: React.createElement('p', null, 'Ready resource'),
    })
    const dialogClosed = render(AdminConfirmDialog, {
      open: false,
      onCancel: noop,
      onConfirm: noop,
    })
    const dialogOpen = render(AdminConfirmDialog, {
      open: true,
      title: 'Confirm',
      consequence: 'Consequence',
      reasonCode: 'fixed_reason',
      onCancel: noop,
      onConfirm: noop,
    })
    const dialogBusy = render(AdminConfirmDialog, {
      open: true,
      title: 'Busy',
      consequence: 'Busy consequence',
      reasonCode: 'busy_reason',
      busy: true,
      onCancel: noop,
      onConfirm: noop,
    })

    expect(icons).toContain('M4 12h3l2-6')
    expect(button).toContain('Save')
    expect(badge).toContain('Lỗi')
    expect(header).toContain('Description')
    expect(panel).toContain('Body')
    expect(loading).toContain('Loading')
    expect(error).toContain('Thử lại')
    expect(empty).toContain('No rows')
    expect(table).toContain('aria-label="Rows"')
    expect(emptyTable).toContain('No rows')
    expect(resourceLoading).toContain('Loading resource')
    expect(resourceError).toContain('Resource error')
    expect(resourceReady).toContain('Tải thêm')
    expect(dialogClosed).toBe('')
    expect(dialogOpen).toContain('fixed_reason')
    expect(dialogBusy).toContain('Đang xử lý')
  })

  it('covers jobs, governance, articles, users, audit and overview data states', () => {
    const jobs = render(AdminJobsView, {
      api: adminApi,
      session,
      cacheScope: {},
      initialData: {
        ingestion: response(
          [
            baseJob,
            {
              ...baseJob,
              id: 'job-2',
              status: 'failed',
              error: { code: 'provider_error', message: 'Provider failed', retryable: true },
              attempt: 2,
            },
            { ...baseJob, id: 'job-3', status: 'succeeded', counters: null },
          ],
          { hasNext: true, nextCursor: 'opaque' },
        ),
        indexing: response([
          {
            ...baseJob,
            id: 'index-1',
            task: 'summary',
            status: 'partial',
            error: { code: 'partial', message: 'Partial result', retryable: false },
          },
        ]),
        sources: response([source]),
        dueWorkRun: {
          runId: 'run-1',
          startedAt: now,
          finishedAt: now,
          queues: {
            ingestion: { claimed: 1, succeeded: 1, partial: 0, failed: 0, deferred: 0 },
            indexing: { claimed: 1, succeeded: 0, partial: 1, failed: 0, deferred: 0 },
            accountDeletion: { claimed: 1, succeeded: 0, partial: 0, failed: 1, deferred: 0 },
          },
        },
      },
    })
    const governance = render(AdminGovernanceView, {
      api: adminApi,
      session,
      cacheScope: {},
      initialData: {
        takedowns: response([
          baseTakedown,
          {
            ...baseTakedown,
            id: 'takedown-2',
            status: 'completed',
            targetIds: null,
            requestedScope: null,
          },
        ]),
        deletions: response([
          baseDeletion,
          { ...baseDeletion, id: 'deletion-2', status: 'running', error: null, completion: {} },
        ]),
      },
    })
    const articles = render(AdminArticlesView, {
      api: adminApi,
      session,
      cacheScope: {},
      initialData: response(
        [
          baseArticle,
          { ...baseArticle, id: 'article-removed', status: 'removed', titleOriginal: null },
          {
            ...baseArticle,
            id: 'article-review',
            status: 'review-needed',
            summaryStatus: 'pending',
            embeddingStatus: 'failed',
          },
        ],
        { hasNext: true, nextCursor: 'opaque' },
      ),
    })
    const users = render(AdminUsersView, {
      api: adminApi,
      session,
      cacheScope: {},
      initialData: response([
        {
          id: 'user-1',
          email: 'user@example.test',
          role: 'user',
          status: 'active',
          updatedAt: now,
        },
        {
          id: 'user-2',
          email: 'suspended@example.test',
          role: 'user',
          status: 'suspended',
          updatedAt: now,
        },
      ]),
    })
    const audit = render(AdminAuditView, {
      api: adminApi,
      session,
      cacheScope: {},
      initialData: response([
        {
          id: 'audit-1',
          createdAt: now,
          action: 'user_suspended',
          actorType: 'admin',
          actorId: 'admin-1',
          targetType: 'user',
          targetId: 'user-1',
          changedFields: ['status'],
          result: 'succeeded',
        },
        {
          id: 'audit-2',
          createdAt: now,
          action: 'article_hidden',
          actorType: 'system-worker',
          actorId: 'worker',
          targetType: 'article',
          targetId: 'article-1',
          changedFields: null,
          result: 'failed',
        },
      ]),
    })
    const overview = render(AdminOverviewView, {
      api: adminApi,
      cacheScope: {},
      initialData: {
        failedJobs: 2,
        failedIndexes: 1,
        openTakedowns: 1,
        failedAccountDeletions: 1,
        sourcesNeedingReview: 1,
        articlesNeedingReview: 1,
        queuedJobs: 3,
        activeSources: 4,
        pausedSources: 1,
        lastSuccessfulIngestionAt: now,
      },
      onNavigate: noop,
    })
    const overviewEmpty = render(AdminOverviewView, {
      api: adminApi,
      cacheScope: {},
      initialData: {},
    })

    expect(jobs).toContain('Jobs và queue')
    expect(jobs).toContain('Tải thêm')
    expect(governance).toContain('Takedown requests')
    expect(governance).toContain('Bắt đầu xem xét')
    expect(governance).toContain('Không có bước tiếp theo')
    expect(governance).toContain('Thử lại xóa dữ liệu')
    expect(governance).toContain('Theo dõi')
    expect(articles).toContain('Ẩn bài')
    expect(articles).toContain('Tombstone')
    expect(articles).toContain('Hiện bài')
    expect(users).toContain('user@example.test')
    expect(users).toContain('Tạm dừng')
    expect(users).toContain('Khôi phục')
    expect(audit).toContain('user_suspended')
    expect(audit).toContain('Chưa ghi nhận')
    expect(overview).toContain('Cần xử lý')
    expect(overview).toContain('lastSuccessfulIngestionAt')
    expect(overviewEmpty).toContain('Không có ngoại lệ mở.')
  })

  it('covers source registry, policy review and account views without secret fields', () => {
    const sources = render(AdminSourcesView, {
      api: adminApi,
      session,
      cacheScope: {},
      initialData: response([
        source,
        {
          ...source,
          id: 'source-draft',
          operationalStatus: 'draft',
          licenseStatus: 'review-needed',
        },
        { ...source, id: 'source-paused', operationalStatus: 'paused' },
      ]),
    })
    const sourcesDraft = render(AdminSourcesView, {
      api: adminApi,
      session,
      cacheScope: {},
      initialData: response([
        {
          ...source,
          id: 'source-draft-first',
          operationalStatus: 'draft',
          licenseStatus: 'review-needed',
        },
        source,
      ]),
    })
    const create = render(SourceCreateForm, {
      onSubmit: noop,
      onClose: noop,
      error: 'Create error',
    })
    const addClosed = render(AddSourcePanel, { onSubmit: noop })
    const addOpen = render(AddSourcePanel, { onSubmit: noop, initialOpen: true })
    const policy = render(SourcePolicy, {
      source: {
        connectorType: 'rss',
        accessMethod: 'rss',
        policyVersion: 4,
        licenseStatus: 'permitted',
        llmInputScope: 'excerpt',
        technicalCheck: { status: 'passed' },
        reconciliation: { status: 'completed' },
      },
    })
    const review = render(SourcePolicyReviewForm, { source, onSubmit: noop })
    const account = render(AdminAccountView, {
      api: {},
      session,
      onLogout: noop,
      onSessionExpired: noop,
    })
    const anonymousAccount = render(AdminAccountView, {
      api: {},
      session: { user: {}, csrfToken: null },
    })

    expect(sources).toContain('Danh sách nguồn')
    expect(sources).toContain('Coverage source')
    expect(sourcesDraft).toContain('Chuyển sang kiểm thử')
    expect(sources).toContain('Tạm dừng')
    expect(sources).toContain('Kiểm tra kỹ thuật')
    expect(create).toContain('Create error')
    expect(create).toContain('Tạo draft')
    expect(addClosed).toContain('+ Thêm nguồn')
    expect(addOpen).toContain('Tạo nguồn draft')
    expect(policy).toContain('v4')
    expect(review).toContain('Lưu quyết định review')
    expect(account).toContain('admin@example.test')
    expect(anonymousAccount).toContain('Không hiển thị')
    expect(sources).not.toMatch(/password|secret|credential/i)
  })
})
