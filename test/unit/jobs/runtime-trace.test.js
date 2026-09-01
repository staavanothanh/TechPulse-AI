import { describe, expect, it, vi } from 'vitest'
import { createRuntimeTracer, startRuntimePhase } from '../../../server/jobs/runtime-trace.js'

describe('runtime trace', () => {
  it('emits only bounded correlation and error fields', () => {
    const log = vi.fn()
    const trace = createRuntimeTracer({ log, now: () => new Date('2026-08-10T00:00:00.000Z') })

    trace({
      event: 'phase',
      runId: 'cron-run-1',
      jobId: 'job-1',
      sourceId: 'source-1',
      stage: 'ingestion.connector',
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
      stage: 'ingestion.connector',
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
})
