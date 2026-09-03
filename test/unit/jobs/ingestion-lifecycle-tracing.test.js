import { describe, expect, it, vi } from 'vitest'
import { createIngestionQueueAdapter } from '../../../server/jobs/ingestion-queue.js'

describe('ingestion lifecycle event emission', () => {
  it('emits trace events across claim, executor, and completion', async () => {
    const trace = vi.fn()
    const jobRepository = {
      selectDueIngestion: vi.fn(),
      recoverExpiredIngestion: vi.fn(),
      nextAvailableAt: vi.fn(),
      claimQueuedWithFence: vi.fn().mockResolvedValue(true),
      completeWithFence: vi.fn().mockResolvedValue({ status: 'succeeded' }),
    }
    const leaseRepository = {
      acquire: vi.fn().mockResolvedValue({
        key: 'ingestion:source:src-1',
        jobId: 'job-1',
        ownerTokenHash: 'h'.repeat(64),
        leaseGeneration: 1,
      }),
      release: vi.fn().mockResolvedValue(true),
      heartbeat: vi.fn().mockResolvedValue(true),
    }
    const executor = vi.fn().mockResolvedValue({
      status: 'succeeded',
      counters: { fetched: 5, created: 5, failed: 0 },
      checkpoint: { processedCount: 5 },
    })

    const adapter = createIngestionQueueAdapter({
      jobRepository,
      leaseRepository,
      executor,
      trace,
    })

    const candidate = {
      id: 'job-1',
      sourceId: 'src-1',
      connectorType: 'rss',
      batchSize: 10,
    }

    const result = await adapter.claimAndExecute({
      candidate,
      runId: 'cron-run-ingest',
      now: new Date('2026-09-03T10:00:00.000Z'),
    })

    expect(result.claimed).toBe(true)
    expect(result.status).toBe('succeeded')

    const traceEvents = trace.mock.calls.map(([e]) => e)
    expect(traceEvents.some((e) => e.stage === 'ingestion.claim' && e.status === 'succeeded' && e.runId === 'cron-run-ingest')).toBe(true)
    expect(traceEvents.some((e) => e.stage === 'ingestion.executor' && e.runId === 'cron-run-ingest')).toBe(true)
    expect(traceEvents.some((e) => e.stage === 'ingestion.completion' && e.runId === 'cron-run-ingest')).toBe(true)
  })
})
