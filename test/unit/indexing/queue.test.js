import { describe, expect, it, vi } from 'vitest'
import { createIndexingQueueAdapter } from '../../../server/jobs/indexing-queue.js'

const candidate = { id: '507f1f77bcf86cd799439041', articleId: '507f1f77bcf86cd799439011', task: 'summary' }

describe('Step 9 indexing queue adapter', () => {
  it('claims the canonical article lease and completes one task independently', async () => {
    const jobRepository = {
      selectDueIndexing: vi.fn(async () => candidate), recoverExpiredIndexing: vi.fn(), nextAvailableAt: vi.fn(),
      claimQueuedWithFence: vi.fn(async () => true), completeWithFence: vi.fn(async () => true), deferWithFence: vi.fn(),
    }
    const leaseRepository = { acquire: vi.fn(async ({ key }) => ({ key, ownerTokenHash: 'a'.repeat(64), leaseGeneration: 2 })), release: vi.fn() }
    const executor = vi.fn(async () => ({ status: 'succeeded', inputHash: 'b'.repeat(64) }))
    const adapter = createIndexingQueueAdapter({ jobRepository, leaseRepository, executor, ownerToken: () => 'owner-token-value' })
    const result = await adapter.claimAndExecute({ candidate, now: new Date('2026-08-10T00:00:00.000Z') })
    expect(leaseRepository.acquire).toHaveBeenCalledWith(expect.objectContaining({ key: `indexing:article:${candidate.articleId}`, jobId: candidate.id }))
    expect(executor).toHaveBeenCalledWith(expect.objectContaining({ job: { ...candidate, leaseGeneration: 2 }, fence: expect.objectContaining({ leaseGeneration: 2 }) }))
    expect(jobRepository.completeWithFence).toHaveBeenCalledWith(expect.objectContaining({ status: 'succeeded', inputHash: 'b'.repeat(64) }))
    expect(result).toEqual({ status: 'succeeded', claimed: true })
  })
  it('defers when lease admission outlives the indexing deadline', async () => {
    const now = new Date('2026-08-10T00:00:00.000Z')
    vi.useFakeTimers({ now })
    try {
      let receivedSignal
      const leaseRepository = {
        acquire: vi.fn(({ signal }) => {
          receivedSignal = signal
          return new Promise(() => {})
        }),
        release: vi.fn(async () => true),
      }
      const adapter = createIndexingQueueAdapter({
        jobRepository: { claimQueuedWithFence: vi.fn(), deferWithFence: vi.fn() },
        leaseRepository,
        ownerToken: () => 'owner-token-value',
      })

      const run = adapter.claimAndExecute({ candidate, now, deadline: new Date(now.getTime() + 100) })
      await vi.advanceTimersByTimeAsync(100)
      await expect(run).resolves.toEqual({ status: 'deferred', claimed: false })
      expect(receivedSignal.aborted).toBe(true)
    } finally {
      vi.useRealTimers()
    }
  })

  it('does not wait forever when terminal indexing completion stalls', async () => {
    vi.useFakeTimers()
    try {
      const fence = { key: `indexing:article:${candidate.articleId}`, ownerTokenHash: 'a'.repeat(64), leaseGeneration: 1 }
      const adapter = createIndexingQueueAdapter({
        jobRepository: {
          claimQueuedWithFence: vi.fn(async () => true),
          completeWithFence: vi.fn(() => new Promise(() => {})),
        },
        leaseRepository: { acquire: vi.fn(async () => fence) },
        executor: vi.fn(async () => ({ status: 'succeeded' })),
        ownerToken: () => 'owner-token-value',
      })

      const run = adapter.claimAndExecute({ candidate })
      await vi.advanceTimersByTimeAsync(0)
      const rejection = expect(run).rejects.toMatchObject({ code: 'indexing_finalization_unresolved', retryable: false })
      await vi.advanceTimersByTimeAsync(5_000)
      await rejection
    } finally {
      vi.useRealTimers()
    }
  })

  it('defers safely when no executor exists and never completes another task array', async () => {
    const jobRepository = { selectDueIndexing: vi.fn(), recoverExpiredIndexing: vi.fn(), nextAvailableAt: vi.fn(), claimQueuedWithFence: vi.fn(async () => true), deferWithFence: vi.fn(async () => ({ status: 'queued' })), completeWithFence: vi.fn() }
    const leaseRepository = { acquire: vi.fn(async () => ({ key: `indexing:article:${candidate.articleId}`, ownerTokenHash: 'a'.repeat(64), leaseGeneration: 1 })), release: vi.fn() }
    const adapter = createIndexingQueueAdapter({ jobRepository, leaseRepository, ownerToken: () => 'owner-token-value' })
    await expect(adapter.claimAndExecute({ candidate })).resolves.toEqual({ status: 'deferred', claimed: true })
    expect(jobRepository.completeWithFence).not.toHaveBeenCalled()
  })

  it('marks a stale lease outcome retryable for safe recovery', async () => {
    const fence = { key: `indexing:article:${candidate.articleId}`, jobId: candidate.id, ownerTokenHash: 'a'.repeat(64), leaseGeneration: 2 }
    const jobRepository = { claimQueuedWithFence: vi.fn(async () => true), completeWithFence: vi.fn(async () => ({})) }
    const leaseRepository = { acquire: vi.fn(async () => fence) }
    const executor = vi.fn(async () => { throw Object.assign(new Error('stale fence'), { code: 'lease_fence_stale', retryable: false }) })
    const adapter = createIndexingQueueAdapter({ jobRepository, leaseRepository, executor, ownerToken: () => 'owner-token-value' })

    await expect(adapter.claimAndExecute({ candidate })).resolves.toEqual({ status: 'failed', claimed: true })
    expect(jobRepository.completeWithFence.mock.calls[0][0].error).toMatchObject({ code: 'lease_fence_stale', retryable: true })
  })

  it('releases the lease and skips a job when the claim loses a completion race', async () => {
    const fence = { key: `indexing:article:${candidate.articleId}`, jobId: candidate.id, ownerTokenHash: 'a'.repeat(64), leaseGeneration: 2 }
    const conflict = Object.assign(new Error('Indexing job is no longer claimable'), { status: 409, code: 'conflict' })
    const jobRepository = { claimQueuedWithFence: vi.fn(async () => { throw conflict }) }
    const leaseRepository = { acquire: vi.fn(async () => fence), release: vi.fn(async () => true) }
    const executor = vi.fn()
    const adapter = createIndexingQueueAdapter({ jobRepository, leaseRepository, executor, ownerToken: () => 'owner-token-value' })

    await expect(adapter.claimAndExecute({ candidate })).resolves.toEqual({ status: 'deferred', claimed: false })
    expect(leaseRepository.release).toHaveBeenCalledWith(expect.objectContaining({ ...fence, ownerToken: 'owner-token-value' }))
    expect(executor).not.toHaveBeenCalled()
  })

  it('does not swallow non-conflict errors from the job claim', async () => {
    const fence = { key: `indexing:article:${candidate.articleId}`, jobId: candidate.id, ownerTokenHash: 'a'.repeat(64), leaseGeneration: 2 }
    const failure = Object.assign(new Error('database unavailable'), { status: 503, code: 'database_unavailable' })
    const jobRepository = { claimQueuedWithFence: vi.fn(async () => { throw failure }) }
    const leaseRepository = { acquire: vi.fn(async () => fence), release: vi.fn() }
    const adapter = createIndexingQueueAdapter({ jobRepository, leaseRepository, ownerToken: () => 'owner-token-value' })

    await expect(adapter.claimAndExecute({ candidate })).rejects.toBe(failure)
    expect(leaseRepository.release).toHaveBeenCalledWith(expect.objectContaining({ ...fence, ownerToken: 'owner-token-value' }))
  })

  it('defers provider admission denial before an external attempt and preserves Retry-After', async () => {
    const retryAfterSeconds = 17
    const admissionDenied = Object.assign(new Error('provider admission denied'), {
      code: 'provider_unavailable', retryable: true, retryAfterSeconds, externalAttempts: 0,
    })
    const fence = { key: `indexing:article:${candidate.articleId}`, jobId: candidate.id, ownerTokenHash: 'a'.repeat(64), leaseGeneration: 3 }
    const jobRepository = {
      claimQueuedWithFence: vi.fn(async () => true),
      deferWithFence: vi.fn(async () => ({ status: 'queued' })),
      completeWithFence: vi.fn(),
      cancellationRequestedWithFence: vi.fn(async () => false),
    }
    const leaseRepository = { acquire: vi.fn(async () => fence) }
    const executor = vi.fn(async () => { throw admissionDenied })
    const adapter = createIndexingQueueAdapter({ jobRepository, leaseRepository, executor, ownerToken: () => 'owner-token-value' })

    await expect(adapter.claimAndExecute({ candidate, now: new Date('2026-08-10T00:00:00.000Z') })).resolves.toEqual(expect.objectContaining({
      status: 'deferred', claimed: true, retryAfterSeconds,
    }))
    expect(jobRepository.deferWithFence).toHaveBeenCalledWith(expect.objectContaining({ jobId: candidate.id, fence, delayMs: expect.any(Number) }))
    expect(jobRepository.deferWithFence.mock.calls[0][0].delayMs).toBeGreaterThanOrEqual(retryAfterSeconds * 1000)
    expect(jobRepository.completeWithFence).not.toHaveBeenCalled()
  })

  it('renews an active lease during long indexing work and clears the timer', async () => {
    vi.useFakeTimers()
    try {
      const fence = { key: `indexing:article:${candidate.articleId}`, jobId: candidate.id, ownerTokenHash: 'a'.repeat(64), leaseGeneration: 2 }
      const jobRepository = { claimQueuedWithFence: vi.fn(async () => true), completeWithFence: vi.fn(async () => ({})) }
      const leaseRepository = { acquire: vi.fn(async () => fence), heartbeat: vi.fn(async () => true) }
      let finish
      const executor = vi.fn(() => new Promise((resolve) => { finish = resolve }))
      const adapter = createIndexingQueueAdapter({ jobRepository, leaseRepository, executor, leaseMs: 1000, ownerToken: () => 'owner-token-value' })
      const run = adapter.claimAndExecute({ candidate })
      await Promise.resolve()
      await vi.advanceTimersByTimeAsync(1000)
      expect(leaseRepository.heartbeat).toHaveBeenCalledWith(expect.objectContaining({ key: fence.key, jobId: fence.jobId, leaseGeneration: fence.leaseGeneration, ownerToken: 'owner-token-value', leaseMs: 1000 }))
      finish({ status: 'succeeded', inputHash: 'b'.repeat(64) })
      await expect(run).resolves.toEqual({ status: 'succeeded', claimed: true })
      const calls = leaseRepository.heartbeat.mock.calls.length
      await vi.advanceTimersByTimeAsync(2000)
      expect(leaseRepository.heartbeat).toHaveBeenCalledTimes(calls)
    } finally {
      vi.useRealTimers()
    }
  })

  it('aborts indexing and avoids terminal writes when lease heartbeat ownership is lost', async () => {
    vi.useFakeTimers()
    try {
      const fence = { key: `indexing:article:${candidate.articleId}`, jobId: candidate.id, ownerTokenHash: 'a'.repeat(64), leaseGeneration: 2 }
      const jobRepository = {
        claimQueuedWithFence: vi.fn(async () => true),
        completeWithFence: vi.fn(),
        deferWithFence: vi.fn(),
      }
      const leaseRepository = {
        acquire: vi.fn(async () => fence),
        heartbeat: vi.fn(async () => false),
      }
      let receivedSignal
      const executor = vi.fn(({ signal }) => new Promise((resolve, reject) => {
        receivedSignal = signal
        signal.addEventListener('abort', () => reject(signal.reason), { once: true })
      }))
      const adapter = createIndexingQueueAdapter({ jobRepository, leaseRepository, executor, leaseMs: 300, ownerToken: () => 'owner-token-value' })
      const run = adapter.claimAndExecute({ candidate })
      const rejection = expect(run).rejects.toMatchObject({ code: 'lease_heartbeat_lost', retryable: true })
      await Promise.resolve()
      await vi.advanceTimersByTimeAsync(100)

      await rejection
      expect(receivedSignal.aborted).toBe(true)
      expect(jobRepository.completeWithFence).not.toHaveBeenCalled()
      expect(jobRepository.deferWithFence).not.toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })
  it('fenced-completes as failed when the executor crosses its deadline', async () => {
    vi.useFakeTimers()
    try {
      const fence = { key: `indexing:article:${candidate.articleId}`, jobId: candidate.id, ownerTokenHash: 'a'.repeat(64), leaseGeneration: 2 }
      const jobRepository = {
        claimQueuedWithFence: vi.fn(async () => true),
        completeWithFence: vi.fn(async () => true),
        deferWithFence: vi.fn(),
      }
      const leaseRepository = {
        acquire: vi.fn(async () => fence),
        heartbeat: vi.fn(async () => true),
        release: vi.fn(),
      }
      const executor = vi.fn(() => new Promise(() => {}))
      const adapter = createIndexingQueueAdapter({ jobRepository, leaseRepository, executor, ownerToken: () => 'owner-token-value' })
      const now = new Date('2026-08-10T00:00:00.000Z')
      const deadline = new Date(now.getTime() + 100)
      const run = adapter.claimAndExecute({ candidate, now, deadline })

      await vi.advanceTimersByTimeAsync(100)
      await expect(run).resolves.toEqual({ status: 'failed', claimed: true })
      expect(jobRepository.completeWithFence).toHaveBeenCalledWith(expect.objectContaining({
        jobId: candidate.id,
        fence,
        status: 'failed',
        error: expect.objectContaining({ code: 'indexing_deadline_exceeded' }),
      }))
    } finally {
      vi.useRealTimers()
    }
  })
})
