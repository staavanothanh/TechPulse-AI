import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { AdminJobsView } from '../../../client/features/admin/ui/AdminJobsView.jsx'
import {
  aggregateDueWorkCounters,
  normalizeDueWorkRun,
  runAdminDueWork,
} from '../../../client/features/admin/ui/admin-data.js'

const session = { user: { id: 'admin-opaque', role: 'admin' }, csrfToken: 'csrf-in-memory' }

const run = {
  runId: 'run-admin-opaque',
  startedAt: '2026-08-23T06:00:00.000Z',
  finishedAt: '2026-08-23T06:00:01.000Z',
  recovery: { inspected: 2, recovered: 1, retriesCreated: 0, failed: 0 },
  queues: {
    ingestion: { claimed: 2, succeeded: 1, partial: 1, failed: 0, deferred: 0 },
    indexing: { claimed: 3, succeeded: 2, partial: 0, failed: 1, deferred: 0 },
    accountDeletion: { claimed: 1, succeeded: 0, partial: 0, failed: 0, deferred: 1 },
  },
  nextAvailableAt: null,
}

describe('admin due-work controls', () => {
  it('normalizes the canonical response and aggregates every registered queue', () => {
    const normalized = normalizeDueWorkRun({ data: run })

    expect(normalized).toEqual(run)
    expect(aggregateDueWorkCounters(normalized)).toEqual({
      claimed: 6,
      succeeded: 3,
      partial: 1,
      failed: 1,
      deferred: 1,
    })
  })

  it('fails closed to zero counters when a queue summary is missing or malformed', () => {
    expect(
      normalizeDueWorkRun({
        data: {
          runId: 'run-partial-payload',
          queues: { ingestion: { claimed: 2, succeeded: 'not-a-count' } },
        },
      }),
    ).toEqual({
      runId: 'run-partial-payload',
      startedAt: null,
      finishedAt: null,
      nextAvailableAt: null,
      queues: {
        ingestion: { claimed: 2, succeeded: 0, partial: 0, failed: 0, deferred: 0 },
        indexing: { claimed: 0, succeeded: 0, partial: 0, failed: 0, deferred: 0 },
        accountDeletion: { claimed: 0, succeeded: 0, partial: 0, failed: 0, deferred: 0 },
      },
    })
  })

  it('uses the admin operation without caller-supplied queue bounds', async () => {
    const api = { runAdminDueWork: vi.fn().mockResolvedValue({ data: run }) }

    await expect(runAdminDueWork(api, { csrfToken: session.csrfToken })).resolves.toEqual({
      data: run,
    })
    expect(api.runAdminDueWork).toHaveBeenCalledWith({
      pathParams: undefined,
      headers: {
        'Content-Type': 'application/json',
        'X-CSRF-Token': session.csrfToken,
      },
      body: undefined,
      credentials: 'same-origin',
    })
  })

  it('renders the manual run action and aggregate counters for the three queues', () => {
    const html = renderToStaticMarkup(
      React.createElement(AdminJobsView, {
        api: {},
        session,
        initialData: {
          dueWorkRun: { data: run },
          ingestion: { data: [], meta: { hasNext: false } },
          indexing: { data: [], meta: { hasNext: false } },
          sources: { data: [], meta: { hasNext: false } },
        },
        onSessionExpired: vi.fn(),
      }),
    )

    expect(html).toContain('Chạy queue bounded')
    expect(html).toContain('Kết quả bounded run gần nhất')
    expect(html).toContain('Ingestion')
    expect(html).toContain('Indexing')
    expect(html).toContain('Account deletion')
    expect(html).toContain('Claimed')
    expect(html).toContain('Succeeded')
    expect(html).toContain('Partial')
    expect(html).toContain('Failed')
    expect(html).toContain('Deferred')
    expect(html).toContain('>6<')
    expect(html).toContain('>3<')
  })
})
