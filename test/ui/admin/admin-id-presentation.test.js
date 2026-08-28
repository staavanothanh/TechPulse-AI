import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  ArticlePreviewDialog,
  CompactId,
  SourceBadge,
  clearArticlePreviewCache,
  clearSourceDictionary,
  getCachedArticlePreview,
  registerSourceDictionary,
} from '../../../client/features/admin/ui/AdminShared.jsx'
import { AdminUsersView } from '../../../client/features/admin/ui/AdminUsersView.jsx'
import { AdminArticlesView } from '../../../client/features/admin/ui/AdminArticlesView.jsx'
import { AdminJobsView } from '../../../client/features/admin/ui/AdminJobsView.jsx'
import { AdminAuditView } from '../../../client/features/admin/ui/AdminAuditAccountViews.jsx'
import { AdminGovernanceView } from '../../../client/features/admin/ui/AdminGovernanceView.jsx'

const render = (Component, props = {}) =>
  renderToStaticMarkup(React.createElement(Component, props))

describe('Admin ID presentation & Article Preview UX', () => {
  beforeEach(() => {
    clearSourceDictionary()
    clearArticlePreviewCache()
  })

  afterEach(() => {
    clearSourceDictionary()
    clearArticlePreviewCache()
  })

  describe('<CompactId />', () => {
    it('truncates 24-character ObjectIds and retains full ID in title', () => {
      const fullId = '6a8bd737e66aeb38ac01e1f9'
      const html = render(CompactId, { id: fullId, label: 'Job ID' })

      expect(html).toContain('6a8bd73…e1f9')
      expect(html).toContain('title="6a8bd737e66aeb38ac01e1f9"')
      expect(html).toContain('aria-label="Sao chép Job ID: 6a8bd737e66aeb38ac01e1f9"')
      expect(html).toContain('admin-compact-id')
    })

    it('renders placeholder dash when ID is absent', () => {
      const html = render(CompactId, { id: null })
      expect(html).toContain('—')
      expect(html).toContain('admin-muted')
    })

    it('renders full text if length is small or showFull is true', () => {
      const shortId = 'test-id'
      const html = render(CompactId, { id: shortId, showFull: true })
      expect(html).toContain('test-id')
      expect(html).not.toContain('…')
    })
  })

  describe('<SourceBadge />', () => {
    it('resolves human-readable source name from registered dictionary', () => {
      const sourceId = '507f1f77bcf86cd799439011'
      registerSourceDictionary([
        { id: sourceId, name: 'Hacker News Top Stories', connector: 'hacker-news' },
      ])

      const html = render(SourceBadge, { sourceId })
      expect(html).toContain('Hacker News Top Stories')
      expect(html).toContain('admin-source-badge')
    })

    it('falls back gracefully to raw ID when source is unregistered', () => {
      const unknownId = '507f1f77bcf86cd799439999'
      const html = render(SourceBadge, { sourceId: unknownId })
      expect(html).toContain(unknownId)
    })

    it('shows compact ID when showId prop is enabled', () => {
      const sourceId = '507f1f77bcf86cd799439011'
      registerSourceDictionary([
        { id: sourceId, name: 'arXiv cs.AI', connector: 'arxiv' },
      ])

      const html = render(SourceBadge, { sourceId, showId: true })
      expect(html).toContain('arXiv cs.AI')
      expect(html).toContain('507f1f7…9011')
    })
  })

  describe('<ArticlePreviewDialog />', () => {
    it('does not render when open is false', () => {
      const html = render(ArticlePreviewDialog, { open: false, articleId: '123' })
      expect(html).toBe('')
    })

    it('renders article preview with title, topics, AI summary, and top-right close control', () => {
      const articleId = '60d5ec12a1b2c3d4e5f67890'
      const html = render(ArticlePreviewDialog, {
        open: true,
        articleId,
        api: {},
      })

      expect(html).toContain('Xem nhanh bài viết')
      expect(html).toContain('admin-preview-dialog')
      expect(html).toContain('role="dialog"')
      expect(html).toContain('aria-label="Đóng xem trước"')
      expect(html).not.toContain('Mở trang đọc')
    })
  })

  describe('Visual hierarchy across Admin views', () => {
    it('prioritizes user email over raw ObjectId in Users view', () => {
      const user = {
        id: '66c0a1b2c3d4e5f678901234',
        email: 'operator@techpulse.ai',
        role: 'admin',
        status: 'active',
        updatedAt: '2026-08-28T08:00:00.000Z',
      }
      const html = render(AdminUsersView, {
        api: { listAdminUsers: vi.fn() },
        initialData: { data: [user] },
      })

      expect(html).toContain('operator@techpulse.ai')
      expect(html).toContain('66c0a1b…1234')
      expect(html).toContain('Quản lý người dùng')
    })

    it('handles tombstone deleted users safely without email leakage', () => {
      const deletedUser = {
        id: '66c0a1b2c3d4e5f678909999',
        email: null,
        role: null,
        status: 'deleted',
        updatedAt: '2026-08-28T08:00:00.000Z',
      }
      const html = render(AdminUsersView, {
        api: { listAdminUsers: vi.fn() },
        initialData: { data: [deletedUser] },
      })

      expect(html).toContain('Đã ẩn theo tombstone')
      expect(html).toContain('66c0a1b…9999')
      expect(html).not.toContain('undefined')
    })

    it('prioritizes title and source badge in Articles view', () => {
      const article = {
        id: '60d5ec12a1b2c3d4e5f67890',
        titleOriginal: 'DeepSeek-V4 Flash: Architecture and Benchmarks',
        sourceId: '507f1f77bcf86cd799439011',
        status: 'published',
        summaryStatus: 'ready',
        embeddingStatus: 'ready',
        updatedAt: '2026-08-28T08:00:00.000Z',
      }
      registerSourceDictionary([
        { id: article.sourceId, name: 'arXiv cs.AI' },
      ])

      const html = render(AdminArticlesView, {
        api: { listAdminArticles: vi.fn() },
        initialData: { data: [article] },
      })

      expect(html).toContain('DeepSeek-V4 Flash: Architecture and Benchmarks')
      expect(html).toContain('arXiv cs.AI')
      expect(html).toContain('60d5ec1…7890')
      expect(html).toContain('Xem')
    })

    it('prioritizes connector and source name in Ingestion Jobs view', () => {
      const job = {
        id: '6a8bd737e66aeb38ac01e1f9',
        connectorType: 'hacker-news',
        trigger: 'cron',
        status: 'succeeded',
        sourceId: '507f1f77bcf86cd799439011',
        attempt: 1,
        batchSize: 20,
        counters: { fetched: 30, created: 5, failed: 0 },
      }
      registerSourceDictionary([
        { id: job.sourceId, name: 'Hacker News Top Stories' },
      ])

      const html = render(AdminJobsView, {
        api: { listIngestionJobs: vi.fn(), listIndexingJobs: vi.fn(), listSources: vi.fn() },
        initialData: { ingestion: { data: [job] } },
      })

      expect(html).toContain('HACKER-NEWS · cron')
      expect(html).toContain('Hacker News Top Stories')
      expect(html).toContain('6a8bd73…e1f9')
    })

    it('formats actor and target with CompactId and SourceBadge in Audit view', () => {
      const auditRecord = {
        id: '6a8fda6a02452572edd176f3',
        action: 'source_status_updated',
        actorType: 'admin',
        actorId: '6a7b82ac621661fc69a69ced',
        targetType: 'source',
        targetId: '507f1f77bcf86cd799439011',
        changedFields: ['operationalStatus'],
        result: 'succeeded',
        createdAt: '2026-08-28T08:54:00.000Z',
      }
      registerSourceDictionary([
        { id: auditRecord.targetId, name: 'The Verge Technology' },
      ])

      const html = render(AdminAuditView, {
        api: { listAuditLogs: vi.fn() },
        initialData: { data: [auditRecord] },
      })

      expect(html).toContain('source_status_updated')
      expect(html).toContain('The Verge Technology')
      expect(html).toContain('6a7b82a…9ced')
      expect(html).toContain('507f1f7…9011')
    })

    it('formats takedowns and deletions with CompactId in Governance view', () => {
      const takedown = {
        id: '6a8c1234e66aeb38ac019999',
        targetType: 'article',
        targetIds: ['60d5ec12a1b2c3d4e5f67890'],
        status: 'received',
        requestedScope: ['article'],
        createdAt: '2026-08-28T08:54:00.000Z',
      }
      const deletion = {
        id: '6a8d5678e66aeb38ac018888',
        attempt: 1,
        status: 'running',
        completion: { userSoftDeleted: true },
      }

      const html = render(AdminGovernanceView, {
        api: { listTakedownRequests: vi.fn(), listAccountDeletionRequests: vi.fn() },
        initialData: { takedowns: { data: [takedown] }, deletions: { data: [deletion] } },
      })

      expect(html).toContain('6a8c123…9999')
      expect(html).toContain('6a8d567…8888')
      expect(html).toContain('article · 1 target')
    })
  })
})
