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

  it.each([
    [async () => ({ status: 'succeeded', counters: { fetched: 1 } }), 'succeeded'],
    [async () => ({ status: 'cancelled' }), 'partial'],
    [async () => { throw new Error('raw worker detail') }, 'failed'],
    [async () => ({ status: 'unknown' }), 'failed'],
  ])('claims and terminalizes injected executor outcomes safely', async (execute, expectedStatus) => {
    const fence = { key: 'ingestion:source:507f1f77bcf86cd799439012', jobId: '507f1f77bcf86cd799439011', ownerTokenHash: 'a'.repeat(64), leaseGeneration: 1, expiresAt: new Date(Date.now() + 1000) }
    const jobRepository = { claimQueuedWithFence: vi.fn(async () => true), completeWithFence: vi.fn(async () => ({})) }
    const leaseRepository = { acquire: vi.fn(async () => fence) }
    const adapter = createIngestionQueueAdapter({ jobRepository, leaseRepository, executor: execute, ownerToken: () => 'fixed-owner-token' })
    await expect(adapter.claimAndExecute({ candidate: { id: fence.jobId, sourceId: '507f1f77bcf86cd799439012' }, now: new Date('2026-08-10T00:00:00.000Z') })).resolves.toEqual({ status: expectedStatus, claimed: true })
    expect(jobRepository.completeWithFence).toHaveBeenCalledWith(expect.objectContaining({ status: expectedStatus === 'partial' ? 'cancelled' : expectedStatus }))
    expect(jobRepository.completeWithFence.mock.calls[0][0]).not.toHaveProperty('now')
    expect(JSON.stringify(jobRepository.completeWithFence.mock.calls)).not.toContain('raw worker detail')
  })
})
