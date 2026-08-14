import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import JobsPanel, { JobDetails, JobsPanelView } from '../../client/features/admin/jobs/JobsPanel.jsx'
import { createJobActions, jobActionPrerequisites, jobsErrorState } from '../../client/features/admin/jobs/job-actions.js'

const job = {
  id: '507f1f77bcf86cd799439021', idempotencyKey: 'job-key', sourceId: '507f1f77bcf86cd799439011', connectorType: 'rss', expectedSourcePolicyVersion: 2,
  trigger: 'admin', status: 'failed', attempt: 1, availableAt: '2026-08-10T00:00:00.000Z', leaseGeneration: 1, batchSize: 20, parentJobId: null,
  counters: { fetched: 2, created: 0, updated: 0, duplicate: 1, skipped: 0, failed: 1 },
  error: { code: 'lease_expired', message: 'Job lease expired before completion', retryable: true, occurredAt: '2026-08-10T00:01:00.000Z' },
  createdAt: '2026-08-10T00:00:00.000Z', startedAt: '2026-08-10T00:00:10.000Z', finishedAt: '2026-08-10T00:01:00.000Z',
}
const handlers = { onReload: vi.fn(), onSelect: vi.fn(), onCreate: vi.fn(), onRetry: vi.fn(), onCancel: vi.fn() }

describe('minimal durable jobs UI', () => {
  it('renders labelled create controls, status/detail and live announcements', () => {
    const html = renderToStaticMarkup(React.createElement(JobsPanelView, { state: 'ready', jobs: [job], sources: [{ id: job.sourceId, name: 'Eligible source', sourceKey: 'rss:eligible' }], selected: job, handlers }))
    for (const id of ['job-source-id', 'job-batch-size']) {
      expect(html).toContain(`for="${id}"`)
      expect(html).toContain(`id="${id}"`)
    }
    expect(html).toContain('aria-live="polite"')
    expect(html).toContain('id="job-detail-title" tabindex="-1"')
    expect(html).toContain('Thử lại ingestion')
    expect(html).toContain('lease_expired')
    expect(html).toContain('Eligible source · rss:eligible')
    expect(html).not.toMatch(/actorScope|requestHash/)
    expect(html).not.toContain('lease 1')
    expect(html).not.toContain('<dt>Policy</dt>')
    expect(html).not.toContain('>v2<')
  })

  it('connects disabled action prerequisites and native buttons', () => {
    const running = { ...job, status: 'running', error: null }
    const tree = JobDetails({ job: running, handlers, busy: false, headingRef: null })
    const buttons = []
    const visit = (node) => {
      if (!node || typeof node !== 'object') return
      if (node.type === 'button') buttons.push(node)
      const children = Array.isArray(node.props?.children) ? node.props.children : [node.props?.children]
      children.forEach(visit)
    }
    visit(tree)
    const retry = buttons.find((button) => button.props.children === 'Thử lại ingestion')
    const cancel = buttons.find((button) => button.props.children === 'Yêu cầu dừng')
    expect(retry.props.disabled).toBe(true)
    expect(retry.props['aria-describedby']).toBe('job-retry-prerequisite')
    expect(cancel.props.disabled).toBe(false)
    cancel.props.onClick()
    expect(handlers.onCancel).toHaveBeenCalledWith(running)
  })

  it('calls generated-client operations with CSRF and scoped idempotency keys', async () => {
    const api = {
      createIngestionJob: vi.fn(async () => ({ data: job })),
      retryIngestionJob: vi.fn(async () => ({ data: job })),
      cancelIngestionJob: vi.fn(async () => ({ data: job })),
    }
    const mutate = vi.fn(async (action) => action())
    const actions = createJobActions({ api, csrfToken: 'csrf', mutate, createIdempotencyKey: (intent) => `step4-${intent}-key` })
    await actions.onCreate({ sourceId: job.sourceId, batchSize: 20 })
    await actions.onRetry(job)
    await actions.onCancel(job)
    expect(api.createIngestionJob).toHaveBeenCalledWith(expect.objectContaining({ headers: expect.objectContaining({ 'X-CSRF-Token': 'csrf', 'Idempotency-Key': `step4-create:${job.sourceId}:20-key` }) }))
    expect(api.retryIngestionJob).toHaveBeenCalledWith(expect.objectContaining({ pathParams: { jobId: job.id }, headers: expect.objectContaining({ 'Idempotency-Key': `step4-retry:${job.id}-key` }) }))
    expect(api.cancelIngestionJob).toHaveBeenCalledWith(expect.objectContaining({ pathParams: { jobId: job.id } }))
  })

  it('classifies session expiry and covers retry/cancel prerequisites', () => {
    expect(jobsErrorState({ status: 401 }).sessionExpiredNotice).toMatch(/hết hạn/i)
    expect(jobsErrorState({ status: 503 }).sessionExpiredNotice).toBeNull()
    expect(jobActionPrerequisites(job)).toEqual(expect.objectContaining({ retryReady: true, cancelReady: false }))
    expect(jobActionPrerequisites({ ...job, status: 'succeeded', error: null }).retryReady).toBe(false)
    expect(jobActionPrerequisites({ ...job, status: 'partial', attempt: 3 }).retryReady).toBe(false)
    expect(jobsErrorState({ status: 403 }).message).toMatch(/quyền/i)
    expect(jobsErrorState({ status: 409 }).message).toMatch(/thay đổi|Idempotency/i)
    expect(jobsErrorState({ status: 422 }).message).toMatch(/hợp lệ/i)
    expect(jobsErrorState({ status: 429, retryAfter: 30 }).message).toMatch(/giới hạn|30/i)
    expect(jobsErrorState({ status: 403, code: 'csrf_invalid' }).message).toMatch(/CSRF/i)
    expect(jobsErrorState(new Error('mongodb://private/?token=secret')).message).toBe('Không thể hoàn tất thao tác durable job.')
    expect(jobsErrorState({}).message).toMatch(/Không thể/i)
  })

  it('renders the stateful loading shell without firing persistent browser storage', () => {
    const api = { listIngestionJobs: vi.fn() }
    const html = renderToStaticMarkup(React.createElement(JobsPanel, { api, csrfToken: 'csrf' }))
    expect(html).toContain('Đang tải durable jobs')
    expect(html).not.toMatch(/localStorage|sessionStorage/)
  })

  it('announces loading, empty, error and terminal prerequisites', () => {
    expect(renderToStaticMarkup(React.createElement(JobsPanelView, { state: 'loading', handlers }))).toContain('aria-busy="true"')
    expect(renderToStaticMarkup(React.createElement(JobsPanelView, { state: 'ready', jobs: [], handlers }))).toContain('Chưa có ingestion job')
    const error = renderToStaticMarkup(React.createElement(JobsPanelView, { state: 'error', error: 'Không tải được.', handlers }))
    expect(error).toContain('role="alert"')
    expect(error).toContain('Thử lại')
    const terminal = renderToStaticMarkup(React.createElement(JobDetails, { job: { ...job, status: 'succeeded', error: null }, handlers }))
    expect(terminal).toContain('id="job-retry-prerequisite"')
    expect(terminal).toContain('id="job-cancel-prerequisite"')
  })
})
