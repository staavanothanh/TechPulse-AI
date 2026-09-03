import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { AdminJobsView, reloadAdminJobResources, reloadAfterDueWork } from '../../../client/features/admin/ui/AdminJobsView.jsx'

const session = { user: { id: 'admin-opaque', role: 'admin' }, csrfToken: 'csrf-in-memory' }

const event = {
  eventId: 'e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1',
  runId: 'run-cron-1234',
  queueName: 'indexing',
  task: 'summary',
  jobId: '507f1f77bcf86cd799439011',
  articleId: '507f1f77bcf86cd799439012',
  sourceId: '507f1f77bcf86cd799439013',
  stage: 'indexing.executor',
  status: 'succeeded',
  elapsedMs: 340,
  occurredAt: '2026-09-03T10:00:00.000Z',
  counters: null,
  error: null,
}

describe('AdminJobsView lifecycle events tab', () => {
  it('renders Lifecycle Events tab and event table', () => {
    const html = renderToStaticMarkup(
      React.createElement(AdminJobsView, {
        api: {},
        session,
        initialData: {
          tab: 'events',
          events: { data: [event], meta: { hasNext: false } },
        },
        onSessionExpired: vi.fn(),
      }),
    )

    expect(html).toContain('Lifecycle Events')
    expect(html).toContain('run-cron-1234')
    expect(html).toContain('indexing.executor')
    expect(html).toContain('summary')
    expect(html).toContain('Lọc theo jobId')
    expect(html).toContain('Lọc theo sourceId')
    expect(html).toContain('Lọc theo articleId')
    expect(html).toContain('Từ thời gian')
    expect(html).toContain('Đến thời gian')
    expect(html).not.toContain('Xếp indexing job')
  })
  it('reloads the Events resource for refresh and all job resources after bounded work', () => {
    const resources = {
      ingestion: { reload: vi.fn() },
      indexing: { reload: vi.fn() },
      events: { reload: vi.fn() },
      sources: { reload: vi.fn() },
    }

    reloadAdminJobResources({ ...resources, tab: 'events' })
    expect(resources.events.reload).toHaveBeenCalledOnce()
    expect(resources.ingestion.reload).not.toHaveBeenCalled()
    expect(resources.indexing.reload).not.toHaveBeenCalled()
    expect(resources.sources.reload).not.toHaveBeenCalled()

    reloadAdminJobResources({ ...resources, tab: 'ingestion' })
    expect(resources.ingestion.reload).toHaveBeenCalledOnce()
    expect(resources.sources.reload).toHaveBeenCalledOnce()
    reloadAdminJobResources({ ...resources, tab: 'indexing' })
    expect(resources.indexing.reload).toHaveBeenCalledOnce()

    reloadAfterDueWork(resources)
    expect(resources.ingestion.reload).toHaveBeenCalledTimes(2)
    expect(resources.indexing.reload).toHaveBeenCalledTimes(2)
    expect(resources.events.reload).toHaveBeenCalledTimes(2)
  })
})
