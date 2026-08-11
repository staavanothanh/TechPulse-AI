import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { IndexingActionDialog, IndexingJobDetails, IndexingJobsPanelView } from '../../client/features/admin/jobs/indexing/IndexingJobsPanel.jsx'
import { createIndexingJobActions, indexingJobPrerequisites } from '../../client/features/admin/jobs/indexing/indexing-job-actions.js'
import { focusTrapTarget } from '../../client/features/saved/dialog-focus.js'

const job = {
  id: '507f1f77bcf86cd799439041', idempotencyKey: 'must-not-render', articleId: '507f1f77bcf86cd799439011', sourceId: '507f1f77bcf86cd799439021',
  expectedSourcePolicyVersion: 4, task: 'embedding', trigger: 'admin', status: 'failed', attempt: 1, availableAt: '2026-08-10T00:00:00.000Z', leaseGeneration: 2,
  parentJobId: null, error: { code: 'provider_unavailable', message: 'Provider unavailable safely', retryable: true, occurredAt: '2026-08-10T00:01:00.000Z' },
  createdAt: '2026-08-10T00:00:00.000Z', startedAt: '2026-08-10T00:00:10.000Z', finishedAt: '2026-08-10T00:01:00.000Z',
}
const handlers = { onReload: vi.fn(), onSelect: vi.fn(), onRetry: vi.fn(), onCancel: vi.fn(), onCreate: vi.fn(), onFilterChange: vi.fn(), onApplyFilters: vi.fn() }

describe('Step 9 minimalist indexing jobs UI', () => {
  it('renders safe task/status context and never exposes coordination/provider fields', () => {
    const html = renderToStaticMarkup(React.createElement(IndexingJobsPanelView, { state: 'ready', jobs: [job], selected: job, filters: { status: '', task: '', articleId: '', sourceId: '' }, handlers }))
    expect(html).toContain('Indexing jobs')
    expect(html).toContain('embedding')
    expect(html).toContain('failed')
    expect(html).toContain(job.articleId)
    expect(html).toContain('aria-live="polite"')
    expect(html).toContain('id="indexing-job-detail-title" tabindex="-1"')
    expect(html).not.toMatch(/must-not-render|expectedSourcePolicyVersion|leaseGeneration|embeddingModel|inputHash|provider route|vector/i)
  })

  it('keeps retry/cancel state server-derived and describes unavailable actions', () => {
    expect(indexingJobPrerequisites(job)).toEqual(expect.objectContaining({ retryReady: true, cancelReady: false }))
    const running = { ...job, status: 'running', error: null }
    const html = renderToStaticMarkup(React.createElement(IndexingJobDetails, { job: running, handlers }))
    expect(html).toContain('Yêu cầu dừng')
    expect(html).toContain('disabled=""')
    expect(html).not.toContain('cancelled')
  })

  it('confirms retry/cancel in a modal dialog with keyboard focus containment', () => {
    const html = renderToStaticMarkup(React.createElement(IndexingActionDialog, {
      intent: { action: 'retry', job },
      busy: false,
      onCancel: vi.fn(),
      onConfirm: vi.fn(),
    }))
    expect(html).toContain('role="dialog"')
    expect(html).toContain('aria-modal="true"')
    expect(html).toContain('Thử lại job này?')
    expect(html).toContain(job.id)
    const first = { id: 'first' }
    const last = { id: 'last' }
    expect(focusTrapTarget({ key: 'Tab', shiftKey: true, activeElement: first, focusables: [first, last] })).toBe(last)
    expect(focusTrapTarget({ key: 'Tab', shiftKey: false, activeElement: last, focusables: [first, last] })).toBe(first)
  })

  it('calls all mutation operations with hidden CSRF/idempotency transports and fixed reason codes', async () => {
    const api = {
      createSummaryJob: vi.fn(async () => ({ data: { ...job, task: 'summary' } })),
      createIndexingJob: vi.fn(async () => ({ data: job })),
      retryIndexingJob: vi.fn(async () => ({ data: { ...job, trigger: 'retry', attempt: 2 } })),
      cancelIndexingJob: vi.fn(async () => ({ data: { ...job, status: 'running' } })),
    }
    const mutate = vi.fn(async (action) => action())
    const actions = createIndexingJobActions({ api, csrfToken: 'csrf', mutate, createIdempotencyKey: (intent) => `step9-${intent}-key` })
    await actions.createSummary(job.articleId)
    await actions.createTask(job.articleId, 'embedding')
    await actions.retry(job)
    await actions.cancel({ ...job, status: 'running' })
    expect(api.createSummaryJob).toHaveBeenCalledWith(expect.objectContaining({ pathParams: { articleId: job.articleId }, headers: expect.objectContaining({ 'X-CSRF-Token': 'csrf', 'Idempotency-Key': `step9-summary:${job.articleId}-key` }) }))
    expect(JSON.parse(api.createIndexingJob.mock.calls[0][0].body)).toEqual({ task: 'embedding', reasonCode: 'artifact_regeneration_requested' })
    expect(JSON.parse(api.retryIndexingJob.mock.calls[0][0].body)).toEqual({ reasonCode: 'job_retry_requested' })
    expect(api.cancelIndexingJob.mock.calls[0][0].headers).not.toHaveProperty('Idempotency-Key')
  })
})
