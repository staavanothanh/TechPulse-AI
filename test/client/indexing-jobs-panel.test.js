import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { IndexingActionDialog, IndexingJobDetails, IndexingJobsPanelView } from '../../client/features/admin/jobs/indexing/IndexingJobsPanel.jsx'
import { createIndexingJobActions, indexingJobPrerequisites, indexingJobsErrorState } from '../../client/features/admin/jobs/indexing/indexing-job-actions.js'
import { createIndexingApi, createIndexingRequestGate } from '../../client/features/admin/jobs/indexing/indexing-api.js'
import { nextIndexingPollDelay } from '../../client/features/admin/jobs/indexing/polling.js'
import { focusTrapTarget } from '../../client/features/saved/dialog-focus.js'

const job = {
  id: '507f1f77bcf86cd799439041', idempotencyKey: 'must-not-render', articleId: '507f1f77bcf86cd799439011', sourceId: '507f1f77bcf86cd799439021',
  expectedSourcePolicyVersion: 4, task: 'embedding', trigger: 'admin', status: 'failed', attempt: 1, availableAt: '2026-08-10T00:00:00.000Z', leaseGeneration: 2,
  parentJobId: null, error: { code: 'provider_unavailable', message: 'Provider unavailable safely', retryable: true, occurredAt: '2026-08-10T00:01:00.000Z' },
  createdAt: '2026-08-10T00:00:00.000Z', startedAt: '2026-08-10T00:00:10.000Z', finishedAt: '2026-08-10T00:01:00.000Z',
}
const handlers = { onReload: vi.fn(), onSelect: vi.fn(), onRetry: vi.fn(), onCancel: vi.fn(), onCreate: vi.fn(), onFilterChange: vi.fn(), onApplyFilters: vi.fn() }

describe('Step 9 minimalist indexing jobs UI', () => {
  it('does not expose unknown transport diagnostics', () => {
    expect(indexingJobsErrorState(new Error('https://private.example/?token=secret')).message).toBe('Không thể hoàn tất thao tác indexing.')
  })
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

  it('does not impose a client retry-attempt ceiling over public server state', () => {
    const longLivedRetryable = { ...job, attempt: 99 }
    expect(indexingJobPrerequisites(longLivedRetryable)).toEqual(expect.objectContaining({ retryReady: true }))
    expect(indexingJobPrerequisites({ ...longLivedRetryable, error: { ...job.error, retryable: false } })).toEqual(expect.objectContaining({ retryReady: false }))
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

  it('confirms a create action with its safe article context before mutation', () => {
    const html = renderToStaticMarkup(React.createElement(IndexingActionDialog, {
      intent: { action: 'create', task: 'summary', articleId: job.articleId },
      busy: false,
      onCancel: vi.fn(),
      onConfirm: vi.fn(),
    }))
    expect(html).toContain('Tạo job tóm tắt?')
    expect(html).toContain(job.articleId)
    expect(html).toContain('Xác nhận tạo job')
  })

  it('renders filter errors and opaque indexing load-more without exposing the cursor', () => {
    const html = renderToStaticMarkup(React.createElement(IndexingJobsPanelView, {
      state: 'ready',
      jobs: [job],
      selected: job,
      filters: { status: '', task: '', articleId: 'bad', sourceId: '' },
      filterErrors: { articleId: 'Article ID chưa hợp lệ.' },
      meta: { hasNext: true, nextCursor: 'opaque-indexing-cursor' },
      handlers,
    }))
    expect(html).toContain('Article ID chưa hợp lệ.')
    expect(html).toContain('aria-invalid="true"')
    expect(html).toContain('Tải thêm indexing jobs')
    expect(html).not.toContain('opaque-indexing-cursor')
  })

  it('renders retryable append, poll, and selection failures in the ready surface', () => {
    for (const scope of ['append', 'poll', 'selection']) {
      const html = renderToStaticMarkup(React.createElement(IndexingJobsPanelView, {
        state: 'ready', jobs: [job], selected: job, handlers,
        operationError: { scope, message: `Lỗi ${scope}` },
      }))
      expect(html).toContain(`Lỗi ${scope}`)
      expect(html).toContain('role="alert"')
      expect(html).toContain('Thử lại')
    }
  })

  it('keeps a rate-limited initiating action disabled with safe retry timing', () => {
    const html = renderToStaticMarkup(React.createElement(IndexingActionDialog, {
      intent: { action: 'retry', job },
      busy: false,
      cooldown: 12,
      onCancel: vi.fn(),
      onConfirm: vi.fn(),
    }))
    expect(html).toContain('Thử lại sau 12 giây')
    expect(html).toContain('disabled=""')
  })

  it('captures only safe 422 field errors and numeric Retry-After through the indexing boundary', async () => {
    const generatedApi = {
      listIndexingJobs: vi.fn(async ({ fetchImpl }) => {
        await fetchImpl('https://techpulse.test/api/v1/admin/indexing-jobs', {})
        throw Object.assign(new Error('validation failed'), { status: 422, code: 'validation_error' })
      }),
      getIndexingJob: vi.fn(async ({ fetchImpl }) => {
        await fetchImpl('https://techpulse.test/api/v1/admin/indexing-jobs/job-1', {})
        throw Object.assign(new Error('limited'), { status: 429, code: 'rate_limit_exceeded' })
      }),
    }
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce({
        status: 422,
        headers: { get: () => null },
        clone: () => ({ json: async () => ({ error: { details: [{ field: 'articleId', code: 'invalid', message: 'raw-value-must-not-render' }] } }) }),
      })
      .mockResolvedValueOnce({ status: 429, headers: { get: (name) => name === 'Retry-After' ? '12' : null }, clone: () => ({ json: async () => ({}) }) })
    const api = createIndexingApi(generatedApi, fetchImpl)

    await expect(api.listIndexingJobs({ query: { articleId: 'x' } })).rejects.toMatchObject({
      status: 422,
      fieldErrors: { articleId: 'Article ID chưa hợp lệ.' },
    })
    await expect(api.getIndexingJob({ pathParams: { jobId: 'job-1' } })).rejects.toMatchObject({ status: 429, retryAfter: 12 })
    expect(nextIndexingPollDelay({ elapsedMs: 0, errorCount: 1, retryAfterSeconds: 12 })).toBe(12_000)
  })

  it('serializes duplicate filter requests before they can race a newer result', async () => {
    const gate = createIndexingRequestGate()
    let resolveFirst
    const first = gate.run(() => new Promise((resolve) => { resolveFirst = resolve }))
    await Promise.resolve()
    expect(gate.run(async () => 'second')).toEqual({ started: false })
    resolveFirst('first')
    await expect(first).resolves.toEqual({ started: true, value: 'first' })
    await expect(gate.run(async () => 'after-settle')).resolves.toEqual({ started: true, value: 'after-settle' })
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
