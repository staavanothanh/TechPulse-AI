import { describe, expect, it } from 'vitest'
import {
  SAFE_ERROR_CODES,
  canonicalObservabilityEventId,
  createLifecycleEventDocument,
  safeEvent,
  startRuntimePhase,
} from '../../../server/jobs/runtime-trace.js'

describe('canonical observability event contract and persistence', () => {
  it('generates a deterministic 64-character sha256 eventId when missing', () => {
    const event1 = safeEvent({
      runId: 'cron-run-001',
      stage: 'cron.materialization',
      status: 'started',
      at: '2026-09-03T10:00:00.000Z',
    })
    const event2 = safeEvent({
      runId: 'cron-run-001',
      stage: 'cron.materialization',
      status: 'started',
      at: '2026-09-03T10:00:00.000Z',
    })

    expect(event1.eventId).toBeDefined()
    expect(event1.eventId).toMatch(/^[a-f0-9]{64}$/)
    expect(event1.eventId).toBe(event2.eventId)
  })

  it('redacts unknown error codes to worker_failed or runtime_error without leaking message or URL', () => {
    const rawError = Object.assign(
      new Error('https://api.openai.com/v1/embeddings?api_key=sk-secret-12345'),
      { code: 'unregistered_custom_provider_code', retryable: true, upstreamStatus: 502 },
    )
    const event = safeEvent({
      runId: 'run-redaction-1',
      jobId: 'job-1',
      task: 'embedding',
      stage: 'indexing.executor',
      status: 'failed',
      error: rawError,
    })

    expect(event.errorCode).toBe('runtime_error')
    expect(event.retryable).toBe(true)
    expect(event.upstreamStatus).toBe(502)
    const serialized = JSON.stringify(event)
    expect(serialized).not.toContain('sk-secret')
    expect(serialized).not.toContain('api_key')
    expect(serialized).not.toContain('https://api.openai.com')
  })

  it('preserves known safe error codes verbatim', () => {
    for (const code of ['lease_expired', 'lease_fence_stale', 'source_fetch_timeout', 'policy_version_mismatch']) {
      const event = safeEvent({
        stage: 'ingestion.claim',
        status: 'failed',
        error: { code, retryable: true },
      })
      expect(event.errorCode).toBe(code)
    }
  })

  it('creates a validated MongoDB document matching cronLifecycleEvents schema', () => {
    const at = new Date('2026-09-03T12:00:00.000Z')
    const doc = createLifecycleEventDocument({
      runId: 'cron-run-999',
      queueName: 'indexing',
      task: 'embedding',
      jobId: '507f1f77bcf86cd799439011',
      articleId: '507f1f77bcf86cd799439012',
      stage: 'indexing.executor',
      status: 'succeeded',
      elapsedMs: 245,
      at,
    })

    expect(doc._id).toBeDefined()
    expect(doc.eventId).toMatch(/^[a-f0-9]{64}$/)
    expect(doc.runId).toBe('cron-run-999')
    expect(doc.queueName).toBe('indexing')
    expect(doc.task).toBe('embedding')
    expect(doc.jobId).toBe('507f1f77bcf86cd799439011')
    expect(doc.articleId).toBe('507f1f77bcf86cd799439012')
    expect(doc.occurredAt).toEqual(at)
    expect(doc.status).toBe('succeeded')
    expect(doc.elapsedMs).toBe(245)
    expect(doc.purgeAfter).toEqual(new Date(at.getTime() + 30 * 24 * 60 * 60 * 1000))
  })
  it('preserves non-null recovery counters and sequence for coordinator reconstruction', () => {
    const at = new Date('2026-09-03T12:00:00.000Z')
    const doc = createLifecycleEventDocument({
      runId: 'cron-run-recovery',
      queueName: 'ingestion',
      stage: 'coordinator.recovery',
      status: 'succeeded',
      sequence: 1,
      counters: { inspected: 1, recovered: 1, retriesCreated: 1 },
      at,
    })

    expect(doc.sequence).toBe(1)
    expect(doc.counters).toEqual({ inspected: 1, recovered: 1, retriesCreated: 1 })
    expect(doc.counters.inspected).not.toBeNull()
    expect(doc.counters.recovered).not.toBeNull()
    expect(doc.counters.retriesCreated).not.toBeNull()
  })
})
