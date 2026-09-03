import { describe, expect, it, vi } from 'vitest'
import { createIndexingQueueAdapter } from '../../../server/jobs/indexing-queue.js'

describe('indexing lifecycle event emission for summary and embedding', () => {
  for (const task of ['summary', 'embedding']) {
    it(`emits trace events across claim, executor, and completion for ${task} job`, async () => {
      const trace = vi.fn()
      const jobRepository = {
        selectDueIndexing: vi.fn(),
        recoverExpiredIndexing: vi.fn(),
        nextAvailableAt: vi.fn(),
        claimQueuedWithFence: vi.fn().mockResolvedValue(true),
        completeWithFence: vi.fn().mockResolvedValue({ status: 'succeeded' }),
      }
      const leaseRepository = {
        acquire: vi.fn().mockResolvedValue({
          key: `indexing:article:art-1`,
          jobId: `job-${task}`,
          ownerTokenHash: 'h'.repeat(64),
          leaseGeneration: 1,
        }),
        release: vi.fn().mockResolvedValue(true),
        heartbeat: vi.fn().mockResolvedValue(true),
      }
      const executor = vi.fn().mockResolvedValue({
        status: 'succeeded',
        inputHash: 'f'.repeat(64),
      })

      const adapter = createIndexingQueueAdapter({
        jobRepository,
        leaseRepository,
        executor,
        trace,
      })

      const candidate = {
        id: `job-${task}`,
        articleId: 'art-1',
        sourceId: 'src-1',
        task,
      }

      const result = await adapter.claimAndExecute({
        candidate,
        runId: `cron-run-${task}`,
        now: new Date('2026-09-03T10:00:00.000Z'),
      })

      expect(result.claimed).toBe(true)
      expect(result.status).toBe('succeeded')

      const traceEvents = trace.mock.calls.map(([e]) => e)
      expect(traceEvents.some((e) => e.stage === 'indexing.claim' && e.task === task && e.runId === `cron-run-${task}`)).toBe(true)
      expect(traceEvents.some((e) => e.stage === 'indexing.executor' && e.task === task && e.runId === `cron-run-${task}`)).toBe(true)
      expect(traceEvents.some((e) => e.stage === 'indexing.completion' && e.task === task && e.runId === `cron-run-${task}`)).toBe(true)
    })
  }

  it('emits executor and completion events when a retryable execution is deferred', async () => {
    const trace = vi.fn()
    const fence = { key: 'indexing:article:art-defer', jobId: 'job-defer', ownerTokenHash: 'h'.repeat(64), leaseGeneration: 1 }
    const jobRepository = {
      claimQueuedWithFence: vi.fn().mockResolvedValue(true),
      deferWithFence: vi.fn().mockResolvedValue({ status: 'queued' }),
    }
    const leaseRepository = {
      acquire: vi.fn().mockResolvedValue(fence),
      release: vi.fn().mockResolvedValue(true),
      heartbeat: vi.fn().mockResolvedValue(true),
    }
    const executor = vi.fn().mockRejectedValue(Object.assign(new Error('provider unavailable'), {
      code: 'provider_error',
      retryable: true,
    }))
    const adapter = createIndexingQueueAdapter({ jobRepository, leaseRepository, executor, trace, ownerToken: () => 'owner-token' })

    await expect(adapter.claimAndExecute({
      candidate: { id: fence.jobId, articleId: 'art-defer', task: 'summary', attempt: 1 },
      runId: 'cron-run-defer',
      now: new Date('2026-09-03T10:00:00.000Z'),
    })).resolves.toMatchObject({ status: 'deferred', claimed: true })

    const events = trace.mock.calls.map(([event]) => event)
    expect(events.some((event) => event.stage === 'indexing.executor' && event.status === 'deferred')).toBe(true)
    expect(events.some((event) => event.stage === 'indexing.completion' && event.status === 'deferred')).toBe(true)
    expect(jobRepository.deferWithFence).toHaveBeenCalledOnce()
  })
  it.each([
    ['database_unavailable', 'failed'],
    ['indexing_finalization_unresolved', 'timeout'],
  ])('emits a %s completion trace before finalization rethrow', async (errorCode, expectedStatus) => {
    const trace = vi.fn()
    const fence = { key: 'indexing:article:art-finalize', jobId: 'job-finalize', ownerTokenHash: 'h'.repeat(64), leaseGeneration: 1 }
    const jobRepository = {
      claimQueuedWithFence: vi.fn().mockResolvedValue(true),
      completeWithFence: vi.fn().mockRejectedValue(Object.assign(new Error('finalization failed'), { code: errorCode })),
    }
    const leaseRepository = {
      acquire: vi.fn().mockResolvedValue(fence),
      release: vi.fn().mockResolvedValue(true),
      heartbeat: vi.fn().mockResolvedValue(true),
    }
    const executor = vi.fn().mockResolvedValue({ status: 'succeeded' })
    const adapter = createIndexingQueueAdapter({ jobRepository, leaseRepository, executor, trace, ownerToken: () => 'owner-token' })

    await expect(adapter.claimAndExecute({
      candidate: { id: fence.jobId, articleId: 'art-finalize', task: 'embedding', attempt: 1 },
      runId: 'cron-run-finalize',
      now: new Date('2026-09-03T10:00:00.000Z'),
    })).rejects.toMatchObject({ code: errorCode })

    const completion = trace.mock.calls
      .map(([event]) => event)
      .filter((event) => event.stage === 'indexing.completion')
      .at(-1)
    expect(completion).toMatchObject({ status: expectedStatus, errorCode })
  })
  it('emits completion failure when cancellation finalization rejects', async () => {
    const trace = vi.fn()
    const fence = { key: 'indexing:article:art-cancel', jobId: 'job-cancel', ownerTokenHash: 'h'.repeat(64), leaseGeneration: 1 }
    const error = Object.assign(new Error('cancellation finalization failed'), { code: 'database_unavailable' })
    const jobRepository = {
      claimQueuedWithFence: vi.fn().mockResolvedValue(true),
      cancellationRequestedWithFence: vi.fn().mockResolvedValue(true),
      completeWithFence: vi.fn().mockRejectedValue(error),
    }
    const leaseRepository = {
      acquire: vi.fn().mockResolvedValue(fence),
      release: vi.fn().mockResolvedValue(true),
    }
    const adapter = createIndexingQueueAdapter({ jobRepository, leaseRepository, executor: vi.fn(), trace, ownerToken: () => 'owner-token' })

    await expect(adapter.claimAndExecute({
      candidate: { id: fence.jobId, articleId: 'art-cancel', task: 'summary', attempt: 1 },
      runId: 'cron-run-cancel',
      now: new Date('2026-09-03T10:00:00.000Z'),
    })).rejects.toMatchObject({ code: 'database_unavailable' })

    const events = trace.mock.calls.map(([event]) => event)
    expect(events.some((event) => event.stage === 'indexing.executor' && event.status === 'cancelled')).toBe(true)
    expect(events.some((event) => event.stage === 'indexing.completion' && event.status === 'failed' && event.errorCode === 'database_unavailable')).toBe(true)
  })
  it('emits post-claim deadline timeout when executor deadline is exceeded', async () => {
    const trace = vi.fn()
    const fence = { key: 'indexing:article:art-deadline', jobId: 'job-deadline', ownerTokenHash: 'h'.repeat(64), leaseGeneration: 1 }
    const jobRepository = {
      claimQueuedWithFence: vi.fn().mockResolvedValue(true),
      completeWithFence: vi.fn().mockResolvedValue({ status: 'failed' }),
    }
    const leaseRepository = {
      acquire: vi.fn().mockResolvedValue(fence),
      release: vi.fn().mockResolvedValue(true),
      heartbeat: vi.fn().mockResolvedValue(true),
    }
    const executor = vi.fn(async () => {
      await new Promise((resolve) => setTimeout(resolve, 50))
      return { status: 'succeeded' }
    })
    const adapter = createIndexingQueueAdapter({ jobRepository, leaseRepository, executor, trace, ownerToken: () => 'owner-token' })
    const started = new Date('2026-09-03T10:00:00.000Z')

    const result = await adapter.claimAndExecute({
      candidate: { id: fence.jobId, articleId: 'art-deadline', task: 'summary', attempt: 1 },
      runId: 'cron-run-deadline',
      now: started,
      deadline: new Date(started.getTime() + 10),
    })

    expect(result).toMatchObject({ status: 'failed', claimed: true })
    const events = trace.mock.calls.map(([event]) => event)
    expect(events.some((event) => event.stage === 'indexing.claim' && event.status === 'succeeded')).toBe(true)
    expect(events.some((event) => event.stage === 'indexing.deadline' && event.status === 'timeout' && event.errorCode === 'indexing_deadline_exceeded')).toBe(true)
    expect(events.some((event) => event.stage === 'indexing.executor' && event.status === 'timeout' && event.errorCode === 'indexing_deadline_exceeded')).toBe(true)
    expect(events.some((event) => event.stage === 'indexing.completion' && event.status === 'failed')).toBe(true)
  })

  it('emits claim success, deadline timeout, and completion deferral when admission expires after claim', async () => {
    const trace = vi.fn()
    const fence = { key: 'indexing:article:art-post-claim', jobId: 'job-post-claim', ownerTokenHash: 'h'.repeat(64), leaseGeneration: 1 }
    const jobRepository = {
      claimQueuedWithFence: vi.fn(async () => true),
      deferWithFence: vi.fn(async () => ({ status: 'queued' })),
    }
    const leaseRepository = {
      acquire: vi.fn(async () => fence),
      release: vi.fn(async () => true),
    }
    const adapter = createIndexingQueueAdapter({ jobRepository, leaseRepository, executor: vi.fn(), trace, ownerToken: () => 'owner-token' })
    const started = new Date('2026-09-03T10:00:00.000Z')
    const deadline = new Date(started.getTime() + 10_000)

    let perfTime = 1_000
    const perfSpy = vi.spyOn(globalThis.performance, 'now').mockImplementation(() => perfTime)
    try {
      jobRepository.claimQueuedWithFence.mockImplementation(async () => {
        perfTime = 50_000
        return true
      })

      const result = await adapter.claimAndExecute({
        candidate: { id: fence.jobId, articleId: 'art-post-claim', task: 'embedding', attempt: 1 },
        runId: 'cron-run-post-claim',
        now: started,
        deadline,
      })

      expect(result).toEqual({ status: 'deferred', claimed: true })
      const events = trace.mock.calls.map(([event]) => event)
      expect(events.some((event) => event.stage === 'indexing.claim' && event.status === 'succeeded')).toBe(true)
      expect(events.some((event) => event.stage === 'indexing.deadline' && event.status === 'timeout')).toBe(true)
      expect(events.some((event) => event.stage === 'indexing.completion' && event.status === 'deferred')).toBe(true)
    } finally {
      perfSpy.mockRestore()
    }
  })
})
