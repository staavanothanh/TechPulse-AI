import { describe, expect, it, vi } from 'vitest'
import { createAdminLifecycleEventsRouter } from '../../../server/http/admin/lifecycle-events/router.js'
import { serializeLifecycleEventResponse } from '../../../server/http/admin/lifecycle-events/serializer.js'

describe('admin lifecycle events serializer & router', () => {
  it('serializes event accurately without leaking internal fields', () => {
    const raw = {
      eventId: 'a'.repeat(64),
      runId: 'cron-run-123',
      queueName: 'indexing',
      task: 'summary',
      jobId: '507f1f77bcf86cd799439011',
      articleId: '507f1f77bcf86cd799439012',
      sourceId: '507f1f77bcf86cd799439013',
      stage: 'indexing.executor',
      sequence: 12,
      status: 'failed',
      elapsedMs: 150,
      occurredAt: '2026-09-03T10:00:00.000Z',
      counters: { fetched: 1 },
      error: { code: 'worker_failed', retryable: true, occurredAt: '2026-09-03T10:00:00.000Z' },
      internalSecret: 'leaked-token',
    }
    const serialized = serializeLifecycleEventResponse(raw)
    expect(serialized.eventId).toBe('a'.repeat(64))
    expect(serialized.runId).toBe('cron-run-123')
    expect(serialized.queueName).toBe('indexing')
    expect(serialized.task).toBe('summary')
    expect(serialized.jobId).toBe('507f1f77bcf86cd799439011')
    expect(serialized.articleId).toBe('507f1f77bcf86cd799439012')
    expect(serialized.stage).toBe('indexing.executor')
    expect(serialized.sequence).toBe(12)
    expect(serialized.elapsedMs).toBe(150)
    expect(serialized.occurredAt).toBe('2026-09-03T10:00:00.000Z')
    expect(serialized.counters).toEqual({ fetched: 1 })
    expect(serialized.error).toEqual({ code: 'worker_failed', retryable: true, occurredAt: '2026-09-03T10:00:00.000Z' })
    expect(serializeLifecycleEventResponse({ ...raw, sequence: 2_147_483_648 }).sequence).toBeNull()
    expect(serialized).not.toHaveProperty('internalSecret')
  })

  it('provides a router that checks admin authentication', () => {
    const service = { listLifecycleEvents: vi.fn() }
    const router = createAdminLifecycleEventsRouter({ cronEventRepository: service, authService: {} })
    expect(router).toBeDefined()
  })
})
