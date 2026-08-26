import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import AdminRedesign, { ADMIN_NAVIGATION } from '../../../client/features/admin/ui/AdminShell.jsx'

const session = {
  user: { id: 'admin-opaque', role: 'admin', email: 'operator@example.test' },
  csrfToken: 'csrf-in-memory',
}

const overview = {
  activeSources: 4,
  pausedSources: 1,
  sourcesNeedingReview: 2,
  queuedJobs: 3,
  failedJobs: 1,
  articlesNeedingReview: 2,
  failedIndexes: 1,
  openTakedowns: 1,
  failedAccountDeletions: 1,
  lastSuccessfulIngestionAt: '2026-08-19T08:30:00.000Z',
}

describe('admin shell', () => {
  it('renders the artifact navigation and exception-first overview from props', () => {
    const html = renderToStaticMarkup(
      React.createElement(AdminRedesign, {
        api: {},
        session,
        route: 'overview',
        initialData: { overview },
        onNavigate: vi.fn(),
      }),
    )

    expect(ADMIN_NAVIGATION.map((item) => item.id)).toEqual([
      'overview',
      'jobs',
      'articles',
      'governance',
      'sources',
      'users',
      'audit',
      'account',
    ])
    expect(html).toContain('TechPulse Admin')
    expect(html).toContain('Tổng quan vận hành')
    expect(html).toContain('failedJobs')
    expect(html).toContain('openTakedowns')
    expect(html).toContain('aria-current="page"')
    expect(html).not.toContain('API sẵn sàng')
    expect(html).not.toContain('CSRF trong memory · phiên no-store')
    expect(html).toContain('M9 5h6M9 12h6M9 19h6')
    expect(html).toContain('M4 5h16M4 12h16M4 19h10')
    expect(html).toContain('M12 3v18M5 6l14 12M19 6L5 18')
    expect(html).toContain('M4 21c0-4 3.6-6 8-6s8 2 8 6')
    expect(html).not.toMatch(
      /requesterContact|requesterName|evidenceNote|private chat|provider payload/i,
    )
  })

  it('renders a controlled governance route without copying artifact demo records or free-form PII controls', () => {
    const html = renderToStaticMarkup(
      React.createElement(AdminRedesign, {
        api: {},
        session,
        route: 'governance',
        initialData: {
          governance: {
            takedowns: {
              data: [
                {
                  id: 'td-opaque',
                  status: 'approved',
                  targetType: 'article',
                  targetIds: ['article-opaque'],
                  requestedScope: ['metadata', 'summary'],
                  createdAt: '2026-08-19T08:30:00.000Z',
                  updatedAt: '2026-08-19T08:30:00.000Z',
                },
              ],
              meta: { hasNext: false },
            },
            deletions: { data: [], meta: { hasNext: false } },
          },
        },
        onNavigate: vi.fn(),
      }),
    )

    expect(html).toContain('Takedown &amp; xóa tài khoản')
    expect(html).toContain('Hide trước')
    expect(html).toContain('article · 1 target')
    expect(html).not.toMatch(
      /admin@example\.com|alice@example\.com|requester|evidence|textarea|placeholder="Lý do/i,
    )
  })

  it('mounts the Source Registry add-source action from the live admin route', () => {
    const html = renderToStaticMarkup(
      React.createElement(AdminRedesign, {
        api: {},
        session,
        route: 'sources',
        initialData: { sources: { data: [], meta: { hasNext: false } } },
        onNavigate: vi.fn(),
      }),
    )

    expect(html).toMatch(/>\+ Thêm nguồn<|aria-label="Thêm nguồn"/)
    expect(html).not.toContain('Tạo draft source')
  })

  it('keeps the admin account surface session-bound and exposes logout through props', () => {
    const html = renderToStaticMarkup(
      React.createElement(AdminRedesign, {
        api: {},
        session,
        route: 'account',
        onNavigate: vi.fn(),
        onLogout: vi.fn(),
      }),
    )

    expect(html).toContain('Phiên admin')
    expect(html).toMatch(/csrf trong memory/i)
    expect(html).toContain('Đăng xuất')
    expect(html).not.toContain('localStorage')
    expect(html).not.toContain('csrf-in-memory')
  })
})
