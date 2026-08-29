import { describe, expect, it, vi } from 'vitest'
import { createIngestionQueueAdapter } from '../../../server/jobs/ingestion-queue.js'

describe('ingestion queue adapter', () => {
  it('wires exact selection, recovery and next-availability boundaries', async () => {
    const due = { id: '507f1f77bcf86cd799439011', sourceId: '507f1f77bcf86cd799439012' }
    const jobRepository = {
      selectDueIngestion: vi.fn(async () => due),
      recoverExpiredIngestion: vi.fn(async () => ({ inspected: 1, recovered: 1, retriesCreated: 1, failed: 0 })),
      nextAvailableAt: vi.fn(async () => new Date('2026-08-10T00:00:00.000Z')),
    }
    const leaseRepository = {}
    const adapter = createIngestionQueueAdapter({ jobRepository, leaseRepository })
    await expect(adapter.selectDue({ now: new Date() })).resolves.toBe(due)
    await expect(adapter.recoverExpired({ limit: 1, now: new Date() })).resolves.toEqual(expect.objectContaining({ recovered: 1 }))
    await expect(adapter.nextAvailableAt()).resolves.toBeInstanceOf(Date)
    expect(adapter.queueName).toBe('ingestion')
    expect(adapter.recoveryStrategy).toBe('terminal-parent-linked-retry')
  })

  it('fenced-defers work when the Step 5 executor is not registered', async () => {
    const fence = { key: 'ingestion:source:507f1f77bcf86cd799439012', jobId: '507f1f77bcf86cd799439011', ownerTokenHash: 'a'.repeat(64), leaseGeneration: 1 }
    const jobRepository = { claimQueuedWithFence: vi.fn(async () => true), deferWithFence: vi.fn(async () => ({ status: 'queued' })) }
    const leaseRepository = { acquire: vi.fn(async () => fence) }
    const adapter = createIngestionQueueAdapter({ jobRepository, leaseRepository, ownerToken: () => 'fixed-owner-token' })
    const now = new Date('2026-08-10T00:00:00.000Z')
    await expect(adapter.claimAndExecute({ candidate: { id: fence.jobId, sourceId: '507f1f77bcf86cd799439012' }, now })).resolves.toEqual({ status: 'deferred', claimed: true })
    expect(jobRepository.deferWithFence).toHaveBeenCalledWith(expect.objectContaining({ jobId: fence.jobId, fence }))
    expect(jobRepository.deferWithFence.mock.calls[0][0]).not.toHaveProperty('now')
  })

  it('treats a concurrent lease owner as deferred instead of failing the cron run', async () => {
    const conflict = Object.assign(new Error('active lease'), { status: 409, code: 'conflict' })
    const jobRepository = { selectDueIngestion: vi.fn(), recoverExpiredIngestion: vi.fn(), nextAvailableAt: vi.fn(), claimQueuedWithFence: vi.fn() }
    const leaseRepository = { acquire: vi.fn(async () => { throw conflict }) }
    const adapter = createIngestionQueueAdapter({ jobRepository, leaseRepository, executor: vi.fn() })
    await expect(adapter.claimAndExecute({ candidate: { id: '507f1f77bcf86cd799439011', sourceId: '507f1f77bcf86cd799439012' } })).resolves.toEqual({ status: 'deferred', claimed: false })
    expect(jobRepository.claimQueuedWithFence).not.toHaveBeenCalled()
  })

  it('releases an acquired lease when another runner wins the job claim', async () => {
    const fence = { key: 'ingestion:source:507f1f77bcf86cd799439012', jobId: '507f1f77bcf86cd799439011', ownerTokenHash: 'a'.repeat(64), leaseGeneration: 1, expiresAt: new Date(Date.now() + 1000) }
    const jobRepository = { claimQueuedWithFence: vi.fn(async () => false) }
    const leaseRepository = { acquire: vi.fn(async () => fence), release: vi.fn(async () => true) }
    const executor = vi.fn()
    const adapter = createIngestionQueueAdapter({ jobRepository, leaseRepository, executor, ownerToken: () => 'fixed-owner-token' })
    await expect(adapter.claimAndExecute({ candidate: { id: fence.jobId, sourceId: '507f1f77bcf86cd799439012' } })).resolves.toEqual({ status: 'deferred', claimed: false })
    expect(leaseRepository.release).toHaveBeenCalledWith(expect.objectContaining({ ownerToken: 'fixed-owner-token' }))
    expect(executor).not.toHaveBeenCalled()
  })

  it('releases an acquired lease and defers candidate when claimQueuedWithFence throws a 409 conflict', async () => {
    const fence = { key: 'ingestion:source:507f1f77bcf86cd799439012', jobId: '507f1f77bcf86cd799439011', ownerTokenHash: 'a'.repeat(64), leaseGeneration: 1 }
    const conflict = Object.assign(new Error('Job is no longer claimable'), { status: 409, code: 'conflict' })
    const jobRepository = { claimQueuedWithFence: vi.fn(async () => { throw conflict }) }
    const leaseRepository = { acquire: vi.fn(async () => fence), release: vi.fn(async () => true) }
    const adapter = createIngestionQueueAdapter({ jobRepository, leaseRepository, executor: vi.fn(), ownerToken: () => 'token' })
    await expect(adapter.claimAndExecute({ candidate: { id: fence.jobId, sourceId: '507f1f77bcf86cd799439012' } })).resolves.toEqual({ status: 'deferred', claimed: false })
    expect(leaseRepository.release).toHaveBeenCalledWith(expect.objectContaining({ key: fence.key, jobId: fence.jobId, ownerToken: 'token' }))
  })

  it('passes the claimed lease generation to the ingestion executor', async () => {
    const fence = { key: 'ingestion:source:507f1f77bcf86cd799439012', jobId: '507f1f77bcf86cd799439011', ownerTokenHash: 'a'.repeat(64), leaseGeneration: 2, expiresAt: new Date(Date.now() + 1000) }
    const jobRepository = { claimQueuedWithFence: vi.fn(async () => true), completeWithFence: vi.fn(async () => ({})) }
    const leaseRepository = { acquire: vi.fn(async () => fence) }
    const executor = vi.fn(async () => ({ status: 'succeeded' }))
    const adapter = createIngestionQueueAdapter({ jobRepository, leaseRepository, executor, ownerToken: () => 'fixed-owner-token' })

    await adapter.claimAndExecute({ candidate: { id: fence.jobId, sourceId: '507f1f77bcf86cd799439012', leaseGeneration: 0 } })

    expect(executor).toHaveBeenCalledWith(expect.objectContaining({ job: { id: fence.jobId, sourceId: '507f1f77bcf86cd799439012', leaseGeneration: 2 } }))
  })

  it.each([
    [async () => ({ status: 'succeeded', counters: { fetched: 1 } }), 'succeeded', null],
    [async () => ({ status: 'cancelled' }), 'partial', null],
    [async () => { throw Object.assign(new Error('raw worker detail'), { code: 'source_fetch_timeout', retryable: true, upstreamStatus: 504 }) }, 'failed', { code: 'source_fetch_timeout', retryable: true, upstreamStatus: 504 }],
    [async () => { throw Object.assign(new Error('stale fence'), { code: 'lease_fence_stale', retryable: false }) }, 'failed', { code: 'lease_fence_stale', retryable: true }],
    [async () => ({ status: 'unknown' }), 'failed', null],
  ])('claims and terminalizes injected executor outcomes safely', async (execute, expectedStatus, expectedError) => {
    const fence = { key: 'ingestion:source:507f1f77bcf86cd799439012', jobId: '507f1f77bcf86cd799439011', ownerTokenHash: 'a'.repeat(64), leaseGeneration: 1, expiresAt: new Date(Date.now() + 1000) }
    const jobRepository = { claimQueuedWithFence: vi.fn(async () => true), completeWithFence: vi.fn(async () => ({})) }
    const leaseRepository = { acquire: vi.fn(async () => fence) }
    const adapter = createIngestionQueueAdapter({ jobRepository, leaseRepository, executor: execute, ownerToken: () => 'fixed-owner-token' })
    await expect(adapter.claimAndExecute({ candidate: { id: fence.jobId, sourceId: '507f1f77bcf86cd799439012' }, now: new Date('2026-08-10T00:00:00.000Z') })).resolves.toEqual({ status: expectedStatus, claimed: true })
    expect(jobRepository.completeWithFence).toHaveBeenCalledWith(expect.objectContaining({ status: expectedStatus === 'partial' ? 'cancelled' : expectedStatus }))
    if (expectedError) expect(jobRepository.completeWithFence.mock.calls[0][0].error).toMatchObject(expectedError)
    expect(jobRepository.completeWithFence.mock.calls[0][0]).not.toHaveProperty('now')
    expect(JSON.stringify(jobRepository.completeWithFence.mock.calls)).not.toContain('raw worker detail')
  })

  it('renews an active lease during long ingestion work and clears the timer', async () => {
    vi.useFakeTimers()
    try {
      const fence = { key: 'ingestion:source:507f1f77bcf86cd799439012', jobId: '507f1f77bcf86cd799439011', ownerTokenHash: 'a'.repeat(64), leaseGeneration: 1 }
      const jobRepository = { claimQueuedWithFence: vi.fn(async () => true), completeWithFence: vi.fn(async () => ({})) }
      const leaseRepository = { acquire: vi.fn(async () => fence), heartbeat: vi.fn(async () => true) }
      let finish
      const executor = vi.fn(() => new Promise((resolve) => { finish = resolve }))
      const adapter = createIngestionQueueAdapter({ jobRepository, leaseRepository, executor, leaseMs: 1000, ownerToken: () => 'fixed-owner-token' })
      const run = adapter.claimAndExecute({ candidate: { id: fence.jobId, sourceId: '507f1f77bcf86cd799439012' } })
      await Promise.resolve()
      await vi.advanceTimersByTimeAsync(1000)
      expect(leaseRepository.heartbeat).toHaveBeenCalledWith({ key: fence.key, jobId: fence.jobId, leaseGeneration: fence.leaseGeneration, ownerToken: 'fixed-owner-token', leaseMs: 1000 })
      finish({ status: 'succeeded' })
      await expect(run).resolves.toEqual({ status: 'succeeded', claimed: true })
      const calls = leaseRepository.heartbeat.mock.calls.length
      await vi.advanceTimersByTimeAsync(2000)
      expect(leaseRepository.heartbeat).toHaveBeenCalledTimes(calls)
    } finally {
      vi.useRealTimers()
    }
  })
})
