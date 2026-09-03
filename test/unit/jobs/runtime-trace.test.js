import { describe, expect, it, vi } from 'vitest'
import { createLifecycleEventDocument, createRuntimeTracer, reportRuntimeTraceDegraded, safeEvent, startRuntimePhase } from '../../../server/jobs/runtime-trace.js'

describe('runtime trace', () => {
  it('emits only bounded correlation and error fields', () => {
    const log = vi.fn()
    const trace = createRuntimeTracer({ log, now: () => new Date('2026-08-10T00:00:00.000Z') })

    trace({
      event: 'phase',
      runId: 'cron-run-1',
      jobId: 'job-1',
      sourceId: 'source-1',
      sequence: 7,
      status: 'failed',
      error: Object.assign(new Error('https://private.example/feed?token=secret'), { code: 'source_fetch_failed', retryable: true }),
      rawPayload: '<rss>secret</rss>',
      ownerToken: 'owner-secret',
    })

    const line = log.mock.calls[0][0]
    const payload = JSON.parse(line)
    expect(payload).toMatchObject({
      type: 'techpulse.runtime-trace',
      version: 1,
      at: '2026-08-10T00:00:00.000Z',
      event: 'phase',
      runId: 'cron-run-1',
      jobId: 'job-1',
      sourceId: 'source-1',
      sequence: 7,
      status: 'failed',
      errorCode: 'source_fetch_failed',
      retryable: true,
    })
    expect(line).not.toContain('private.example')
    expect(line).not.toContain('secret')
    expect(payload).not.toHaveProperty('rawPayload')
    expect(payload).not.toHaveProperty('ownerToken')
  })
  it('maps token-shaped unknown error codes to a safe sentinel', () => {
    const log = vi.fn()
    const trace = createRuntimeTracer({ log, now: () => new Date('2026-08-10T00:00:00.000Z') })
    trace({ error: Object.assign(new Error('provider detail'), { name: 'sk-proj-secret_token', code: 'sk-proj-secret_token', retryable: true }) })
    const payload = JSON.parse(log.mock.calls[0][0])
    expect(payload.errorCode).toBe('runtime_error')
    expect(payload).not.toHaveProperty('errorName')
    expect(JSON.stringify(payload)).not.toContain('sk-proj-secret_token')
    expect(JSON.stringify(payload)).not.toContain('provider detail')
  })
  it.each([
    'article_unavailable',
    'artifact_commit_stale',
    'artifact_failed',
    'cleanup_incomplete',
    'embedding_compatibility_mismatch',
    'embedding_unavailable',
    'embedding_version_mismatch',
    'indexing_cancelled',
    'provider_credential_unavailable',
    'provider_domain_unavailable',
    'provider_failed',
    'provider_http_error',
    'provider_model_unavailable',
    'provider_network_error',
    'provider_response_invalid',
    'provider_route_invalid',
    'provider_unavailable',
    'reconciliation_failed',
    'service_unavailable',
    'source_inactive',
    'source_policy_invalid',
    'source_scope_denied',
  ])('preserves reviewed indexing error code %s', (errorCode) => {
    const event = safeEvent({ stage: 'indexing.executor', status: 'failed', errorCode, at: '2026-08-10T00:00:00.000Z' })
    expect(event.errorCode).toBe(errorCode)
  })

  it('records elapsed time for successful and failed phases', () => {
    let clock = 100
    const trace = vi.fn()
    const phase = startRuntimePhase({ trace, stage: 'ingestion.commit', now: () => clock, context: { runId: 'run-1', jobId: 'job-1' } })

    clock = 145
    phase.succeed({ counters: { fetched: 2 } })
    const failed = startRuntimePhase({ trace, stage: 'ingestion.complete', now: () => clock, context: { runId: 'run-1', jobId: 'job-1' } })
    clock = 160
    failed.fail(Object.assign(new Error('db unavailable'), { code: 'database_unavailable' }))

    expect(trace.mock.calls.map(([event]) => event)).toEqual([
      { event: 'phase', runId: 'run-1', jobId: 'job-1', stage: 'ingestion.commit', status: 'started' },
      { event: 'phase', runId: 'run-1', jobId: 'job-1', stage: 'ingestion.commit', status: 'succeeded', elapsedMs: 45, counters: { fetched: 2 } },
      { event: 'phase', runId: 'run-1', jobId: 'job-1', stage: 'ingestion.complete', status: 'started' },
      { event: 'phase', runId: 'run-1', jobId: 'job-1', stage: 'ingestion.complete', status: 'failed', elapsedMs: 15, error: expect.any(Object) },
    ])
  })

  it('does not let invalid event clocks escape the logging side effect', () => {
    const log = vi.fn()
    const repository = { recordLifecycleEvent: vi.fn() }
    const trace = createRuntimeTracer({ log, repository, now: () => new Date('not-a-date') })

    expect(() => trace({ stage: 'cron', status: 'started' })).not.toThrow()
    expect(log).not.toHaveBeenCalled()
    expect(repository.recordLifecycleEvent).not.toHaveBeenCalled()
  })
  it('bounds sequence values consistently in events and persisted documents', () => {
    const at = '2026-08-10T00:00:00.000Z'
    const safe = safeEvent({ event: 'phase', stage: 'cron', status: 'started', sequence: 2_147_483_647, at })
    const unsafe = safeEvent({ event: 'phase', stage: 'cron', status: 'started', sequence: 2_147_483_648, at })
    const document = createLifecycleEventDocument({ event: 'phase', stage: 'cron', status: 'started', sequence: 2_147_483_647, at })

    expect(safe.sequence).toBe(2_147_483_647)
    expect(unsafe).not.toHaveProperty('sequence')
    expect(document.sequence).toBe(2_147_483_647)
  })

  it('waits for pending durable records when flushed before the deadline', async () => {
    let resolveRecord
    const repository = {
      recordLifecycleEvent: vi.fn(() => new Promise((resolve) => { resolveRecord = resolve })),
    }
    const trace = createRuntimeTracer({ log: vi.fn(), repository, now: () => new Date('2026-08-10T00:00:00.000Z') })

    trace({ event: 'phase', stage: 'cron', status: 'started' })
    expect(trace.pendingCount).toBe(1)
    const flushed = trace.flush({ maxWaitMs: 100 })
    resolveRecord(true)

    await expect(flushed).resolves.toBe(true)
    expect(trace.pendingCount).toBe(0)
  })

  it('reports rejected durable lifecycle writes as degraded health after pending drains', async () => {
    const repository = { recordLifecycleEvent: vi.fn(async () => false) }
    const onPersistenceDegraded = vi.fn()
    const trace = createRuntimeTracer({ log: vi.fn(), repository, onPersistenceDegraded, now: () => new Date('2026-08-10T00:00:00.000Z') })

    trace({ event: 'phase', stage: 'cron', status: 'started' })
    await expect(trace.flush({ maxWaitMs: 100 })).resolves.toBe(false)
    expect(trace.pendingCount).toBe(0)
    expect(trace.persistenceHealthy).toBe(false)
    expect(trace.failedWriteCount).toBe(1)
    expect(onPersistenceDegraded).toHaveBeenCalledWith({ failedWriteCount: 1, droppedWriteCount: 0 })
  })
  it('counts dropped durable lifecycle writes and keeps flush degraded', async () => {
    const resolvers = []
    const repository = { recordLifecycleEvent: vi.fn(() => new Promise((resolve) => { resolvers.push(resolve) })) }
    const trace = createRuntimeTracer({ log: vi.fn(), repository, now: () => new Date('2026-08-10T00:00:00.000Z') })

    for (let index = 0; index < 257; index += 1) trace({ event: 'phase', stage: 'cron', status: 'started', sequence: index })
    expect(trace.pendingCount).toBe(256)
    expect(trace.droppedWriteCount).toBe(1)
    resolvers.forEach((resolve) => resolve(true))
    await expect(trace.flush({ maxWaitMs: 100 })).resolves.toBe(false)
    expect(trace.persistenceHealthy).toBe(false)
  })
  it('emits only bounded counts in the tracer degradation health signal', () => {
    const log = vi.fn()
    expect(reportRuntimeTraceDegraded({ failedWriteCount: 2, droppedWriteCount: 1 }, log)).toBe(true)
    expect(log).toHaveBeenCalledWith(JSON.stringify({ type: 'techpulse.runtime-trace-health', version: 1, status: 'degraded', failedWriteCount: 2, droppedWriteCount: 1 }))
  })
})
