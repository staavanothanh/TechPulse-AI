import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import AdminRedesign, { ADMIN_NAVIGATION } from '../../../client/redesign/admin/AdminShell.jsx'

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

describe('admin redesign shell', () => {
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

    expect(html).toContain('Takedown và xóa tài khoản')
    expect(html).toContain('Hide trước')
    expect(html).toContain('article · 1 target')
    expect(html).not.toMatch(
      /admin@example\.com|alice@example\.com|requester|evidence|textarea|placeholder="Lý do/i,
    )
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
