import { describe, expect, it, vi } from 'vitest'
import { MongoCronEventRepository } from '../../../server/repositories/mongo/cron-event-repository.js'

describe('full-lifecycle tracing reconstruction test', () => {
  it('records events from Vercel cron invocation through materialization, coordinator, claim, execution, and completion', async () => {
    const events = []
    const updateOne = vi.fn(async ({ eventId }, { $setOnInsert: doc }) => {
      const existing = events.find((e) => e.eventId === eventId)
      if (!existing) events.push(doc)
      return { upsertedCount: existing ? 0 : 1 }
    })
    const find = vi.fn(() => ({
      sort: () => ({
        project: () => ({
          limit: () => ({
            toArray: async () => [...events].sort((a, b) => a.occurredAt - b.occurredAt),
          }),
        }),
      }),
    }))

    const repo = new MongoCronEventRepository({
      db: { collection: () => ({ updateOne, find }) },
    })

    const runId = 'cron-trace-full-001'
    const baseTime = new Date('2026-09-03T06:00:00.000Z')

    // 1. Cron started
    await repo.recordLifecycleEvent({
      runId,
      stage: 'cron',
      status: 'started',
      at: new Date(baseTime.getTime()),
    })

    // 2. Materialization phase
    await repo.recordLifecycleEvent({
      runId,
      stage: 'cron.materialization',
      status: 'succeeded',
      counters: { updated: 1 },
      at: new Date(baseTime.getTime() + 500),
    })

    // 3. Coordinator started & queue claims
    await repo.recordLifecycleEvent({
      runId,
      stage: 'coordinator',
      status: 'started',
      at: new Date(baseTime.getTime() + 1000),
    })

    // 4. Ingestion job claim, execute, completion
    const ingestionJobId = '507f1f77bcf86cd799439001'
    const sourceId = '507f1f77bcf86cd799439002'
    await repo.recordLifecycleEvent({
      runId,
      queueName: 'ingestion',
      jobId: ingestionJobId,
      sourceId,
      stage: 'ingestion.claim',
      status: 'succeeded',
      at: new Date(baseTime.getTime() + 1200),
    })
    await repo.recordLifecycleEvent({
      runId,
      queueName: 'ingestion',
      jobId: ingestionJobId,
      sourceId,
      stage: 'ingestion.executor',
      status: 'succeeded',
      counters: { fetched: 10, created: 5 },
      at: new Date(baseTime.getTime() + 1800),
    })
    await repo.recordLifecycleEvent({
      runId,
      queueName: 'ingestion',
      jobId: ingestionJobId,
      sourceId,
      stage: 'ingestion.completion',
      status: 'succeeded',
      at: new Date(baseTime.getTime() + 2000),
    })

    // 5. Summary job claim, execute, completion
    const summaryJobId = '507f1f77bcf86cd799439011'
    const articleId = '507f1f77bcf86cd799439012'
    await repo.recordLifecycleEvent({
      runId,
      queueName: 'indexing',
      task: 'summary',
      jobId: summaryJobId,
      articleId,
      stage: 'indexing.claim',
      status: 'succeeded',
      at: new Date(baseTime.getTime() + 2500),
    })
    await repo.recordLifecycleEvent({
      runId,
      queueName: 'indexing',
      task: 'summary',
      jobId: summaryJobId,
      articleId,
      stage: 'indexing.executor',
      status: 'succeeded',
      elapsedMs: 300,
      at: new Date(baseTime.getTime() + 2800),
    })
    await repo.recordLifecycleEvent({
      runId,
      queueName: 'indexing',
      task: 'summary',
      jobId: summaryJobId,
      articleId,
      stage: 'indexing.completion',
      status: 'succeeded',
      at: new Date(baseTime.getTime() + 2900),
    })

    // 6. Embedding job claim, execute, completion
    const embeddingJobId = '507f1f77bcf86cd799439021'
    await repo.recordLifecycleEvent({
      runId,
      queueName: 'indexing',
      task: 'embedding',
      jobId: embeddingJobId,
      articleId,
      stage: 'indexing.claim',
      status: 'succeeded',
      at: new Date(baseTime.getTime() + 3000),
    })
    await repo.recordLifecycleEvent({
      runId,
      queueName: 'indexing',
      task: 'embedding',
      jobId: embeddingJobId,
      articleId,
      stage: 'indexing.executor',
      status: 'succeeded',
      elapsedMs: 150,
      at: new Date(baseTime.getTime() + 3150),
    })
    await repo.recordLifecycleEvent({
      runId,
      queueName: 'indexing',
      task: 'embedding',
      jobId: embeddingJobId,
      articleId,
      stage: 'indexing.completion',
      status: 'succeeded',
      at: new Date(baseTime.getTime() + 3200),
    })

    // 7. Coordinator & cron completion
    await repo.recordLifecycleEvent({
      runId,
      stage: 'coordinator',
      status: 'succeeded',
      at: new Date(baseTime.getTime() + 3500),
    })
    await repo.recordLifecycleEvent({
      runId,
      stage: 'cron',
      status: 'succeeded',
      at: new Date(baseTime.getTime() + 3600),
    })

    const listing = await repo.listLifecycleEvents({ runId, limit: 50 })
    expect(listing.events).toHaveLength(14)

    // Verify ordering and stages
    const stages = listing.events.map((e) => e.stage)
    expect(stages).toContain('cron')
    expect(stages).toContain('cron.materialization')
    expect(stages).toContain('coordinator')
    expect(stages).toContain('ingestion.claim')
    expect(stages).toContain('ingestion.executor')
    expect(stages).toContain('ingestion.completion')
    expect(stages).toContain('indexing.claim')
    expect(stages).toContain('indexing.executor')
    expect(stages).toContain('indexing.completion')

    // Test idempotency: re-recording the exact same event does not create a duplicate
    const firstEvent = {
      runId,
      stage: 'cron',
      status: 'started',
      at: new Date(baseTime.getTime()),
    }
    await repo.recordLifecycleEvent(firstEvent)
    expect(events).toHaveLength(14)
  })
})
