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
  it('defers without claiming when lease admission crosses the deadline', async () => {
    vi.useFakeTimers()
    try {
      const now = new Date('2026-08-10T00:00:00.000Z')
      const candidate = { id: 'job-1', sourceId: 'source-1' }
      const acquire = vi.fn(() => new Promise(() => {}))
      const claimQueuedWithFence = vi.fn()
      const executor = vi.fn()
      const adapter = createIngestionQueueAdapter({
        jobRepository: { claimQueuedWithFence },
        leaseRepository: { acquire },
        executor,
        ownerToken: () => 'fixed-owner-token',
      })

      const run = adapter.claimAndExecute({ candidate, now, deadline: new Date(now.getTime() + 100) })
      await vi.advanceTimersByTimeAsync(100)
      await expect(run).resolves.toEqual({ status: 'deferred', claimed: false })
      expect(acquire).toHaveBeenCalledWith(expect.objectContaining({ signal: expect.any(globalThis.AbortSignal), deadline: new Date(now.getTime() + 100) }))
      expect(claimQueuedWithFence).not.toHaveBeenCalled()
      expect(executor).not.toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })

  it('keeps an acquired lease for late claim cleanup after the deadline', async () => {
    vi.useFakeTimers()
    try {
      const now = new Date('2026-08-10T00:00:00.000Z')
      const candidate = { id: 'job-1', sourceId: 'source-1' }
      const fence = { key: 'ingestion:source:source-1', jobId: 'job-1', ownerTokenHash: 'a'.repeat(64), leaseGeneration: 1 }
      const claimQueuedWithFence = vi.fn(() => new Promise(() => {}))
      const release = vi.fn(async () => true)
      const executor = vi.fn()
      const adapter = createIngestionQueueAdapter({
        jobRepository: { claimQueuedWithFence },
        leaseRepository: { acquire: vi.fn(async () => fence), release },
        executor,
        finalizationGraceMs: 0,
        ownerToken: () => 'fixed-owner-token',
      })

      const run = adapter.claimAndExecute({ candidate, now, deadline: new Date(now.getTime() + 100) })
      await vi.advanceTimersByTimeAsync(0)
      await vi.advanceTimersByTimeAsync(100)
      await expect(run).resolves.toEqual({ status: 'deferred', claimed: false })
      expect(claimQueuedWithFence).toHaveBeenCalledWith(expect.objectContaining({ signal: expect.any(globalThis.AbortSignal), deadline: new Date(now.getTime() + 100) }))
      expect(release).not.toHaveBeenCalled()
      expect(executor).not.toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
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
    [async () => { throw Object.assign(new Error('token-shaped detail'), { code: 'sk-proj-secret_token', retryable: true }) }, 'failed', { code: 'worker_failed', retryable: true }],
    [async () => { throw Object.assign(new Error('stale fence'), { code: 'lease_fence_stale', retryable: false }) }, 'failed', { code: 'lease_fence_stale', retryable: true }],
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
      expect(leaseRepository.heartbeat).toHaveBeenCalledWith(expect.objectContaining({ key: fence.key, jobId: fence.jobId, leaseGeneration: fence.leaseGeneration, ownerToken: 'fixed-owner-token', leaseMs: 1000 }))
      finish({ status: 'succeeded' })
      await expect(run).resolves.toEqual({ status: 'succeeded', claimed: true })
      const calls = leaseRepository.heartbeat.mock.calls.length
      await vi.advanceTimersByTimeAsync(2000)
      expect(leaseRepository.heartbeat).toHaveBeenCalledTimes(calls)
    } finally {
      vi.useRealTimers()
    }
  })
  it('does not orphan-finalize when heartbeat verification fails transiently', async () => {
    vi.useFakeTimers()
    try {
      const fence = { key: 'ingestion:source:507f1f77bcf86cd799439012', jobId: '507f1f77bcf86cd799439011', ownerTokenHash: 'a'.repeat(64), leaseGeneration: 1 }
      const finalizeOrphanedAttempt = vi.fn()
      const completeWithFence = vi.fn()
      const jobRepository = { claimQueuedWithFence: vi.fn(async () => true), completeWithFence, finalizeOrphanedAttempt }
      const leaseRepository = { acquire: vi.fn(async () => fence), heartbeat: vi.fn(async () => { throw new Error('temporary database outage') }) }
      const executor = vi.fn(({ signal }) => new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true })))
      const adapter = createIngestionQueueAdapter({ jobRepository, leaseRepository, executor, leaseMs: 300, finalizationGraceMs: 0, ownerToken: () => 'fixed-owner-token' })

      const run = adapter.claimAndExecute({ candidate: { id: fence.jobId, sourceId: '507f1f77bcf86cd799439012' } })
      const rejection = expect(run).rejects.toMatchObject({ code: 'ingestion_finalization_unresolved', retryable: false })
      await vi.advanceTimersByTimeAsync(100)
      await rejection
      expect(finalizeOrphanedAttempt).not.toHaveBeenCalled()
      expect(completeWithFence).not.toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })
  it('terminates a never-resolving executor at the deadline and preserves safe diagnostics', async () => {
    vi.useFakeTimers()
    try {
      const fence = { key: 'ingestion:source:507f1f77bcf86cd799439012', jobId: '507f1f77bcf86cd799439011', ownerTokenHash: 'a'.repeat(64), leaseGeneration: 1 }
      const completeWithFence = vi.fn(async () => ({}))
      const trace = vi.fn()
      const jobRepository = { claimQueuedWithFence: vi.fn(async () => true), completeWithFence }
      const leaseRepository = { acquire: vi.fn(async () => fence), heartbeat: vi.fn(async () => true) }
      const executor = vi.fn(({ signal }) => new Promise((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(signal.reason), { once: true })
      }))
      const adapter = createIngestionQueueAdapter({
        jobRepository,
        leaseRepository,
        executor,
        leaseMs: 1_000,
        executionTimeoutMs: 100,
        finalizationGraceMs: 0,
        trace,
        ownerToken: () => 'fixed-owner-token',
      })

      const run = adapter.claimAndExecute({
        candidate: { id: fence.jobId, sourceId: '507f1f77bcf86cd799439012' },
        runId: 'cron-run-1',
        deadline: new Date('2026-08-10T00:00:00.100Z'),
        now: new Date('2026-08-10T00:00:00.000Z'),
      })
      await vi.advanceTimersByTimeAsync(101)

      await expect(run).resolves.toEqual({ status: 'failed', claimed: true })
      expect(executor).toHaveBeenCalledWith(expect.objectContaining({ runId: 'cron-run-1', signal: expect.any(globalThis.AbortSignal) }))
      expect(completeWithFence).toHaveBeenCalledWith(expect.objectContaining({
        status: 'failed',
        error: expect.objectContaining({ code: 'ingestion_deadline_exceeded', retryable: false }),
      }))
      expect(trace.mock.calls.some(([event]) => event.stage === 'ingestion.executor' && event.status === 'timeout')).toBe(true)
    } finally {
      vi.useRealTimers()
    }
  })
  it('terminalizes a deadline even when the executor resolves during grace', async () => {
    vi.useFakeTimers()
    try {
      const fence = { key: 'ingestion:source:507f1f77bcf86cd799439012', jobId: '507f1f77bcf86cd799439011', ownerTokenHash: 'a'.repeat(64), leaseGeneration: 1 }
      const completeWithFence = vi.fn(async () => ({ status: 'failed' }))
      const executor = vi.fn(() => new Promise((resolve) => { globalThis.setTimeout(() => resolve({ status: 'succeeded' }), 120) }))
      const leaseRepository = { acquire: vi.fn(async () => fence) }
      const adapter = createIngestionQueueAdapter({
        jobRepository: { claimQueuedWithFence: vi.fn(async () => true), completeWithFence },
        leaseRepository,
        executor,
        executionTimeoutMs: 100,
        finalizationGraceMs: 50,
        ownerToken: () => 'fixed-owner-token',
      })

      const run = adapter.claimAndExecute({ candidate: { id: fence.jobId, sourceId: '507f1f77bcf86cd799439012' } })
      await vi.advanceTimersByTimeAsync(150)
      await expect(run).resolves.toEqual({ status: 'failed', claimed: true })
      expect(completeWithFence).toHaveBeenCalledWith(expect.objectContaining({ status: 'failed', error: expect.objectContaining({ code: 'ingestion_deadline_exceeded' }) }))
      await vi.advanceTimersByTimeAsync(100)
      expect(completeWithFence).toHaveBeenCalledTimes(1)
    } finally {
      vi.useRealTimers()
    }
  })

  it('aborts cooperative work when heartbeat ownership is lost without terminalizing through a stale fence', async () => {
    vi.useFakeTimers()
    try {
      const fence = { key: 'ingestion:source:507f1f77bcf86cd799439012', jobId: '507f1f77bcf86cd799439011', ownerTokenHash: 'a'.repeat(64), leaseGeneration: 1 }
      const jobRepository = { claimQueuedWithFence: vi.fn(async () => true), completeWithFence: vi.fn() }
      const leaseRepository = { acquire: vi.fn(async () => fence), heartbeat: vi.fn(async () => false) }
      const executor = vi.fn(({ signal }) => new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true })))
      const adapter = createIngestionQueueAdapter({ jobRepository, leaseRepository, executor, leaseMs: 300, ownerToken: () => 'fixed-owner-token' })
      const run = adapter.claimAndExecute({ candidate: { id: fence.jobId, sourceId: '507f1f77bcf86cd799439012' } })

      const rejection = expect(run).rejects.toMatchObject({ code: 'ingestion_finalization_unresolved', retryable: false })
      await vi.advanceTimersByTimeAsync(100)
      await rejection

      expect(jobRepository.completeWithFence).not.toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })

  it('leaves a generic completion failure unresolved for recovery', async () => {
    const fence = { key: 'ingestion:source:507f1f77bcf86cd799439012', jobId: '507f1f77bcf86cd799439011', ownerTokenHash: 'a'.repeat(64), leaseGeneration: 1 }
    const completionFailure = Object.assign(new Error('lease expired'), { code: 'conflict', status: 409 })
    const finalizeOrphanedAttempt = vi.fn(async () => true)
    const jobRepository = {
      claimQueuedWithFence: vi.fn(async () => true),
      completeWithFence: vi.fn(async () => { throw completionFailure }),
      finalizeOrphanedAttempt,
    }
    const leaseRepository = { acquire: vi.fn(async () => fence) }
    const adapter = createIngestionQueueAdapter({ jobRepository, leaseRepository, executor: vi.fn(async () => ({ status: 'succeeded' })), ownerToken: () => 'fixed-owner-token' })

    await expect(adapter.claimAndExecute({ candidate: { id: fence.jobId, sourceId: '507f1f77bcf86cd799439012' } })).rejects.toMatchObject({ code: 'ingestion_finalization_unresolved', retryable: false })
    expect(finalizeOrphanedAttempt).not.toHaveBeenCalled()
  })
  it('sanitizes raw worker diagnostics before trace emission', async () => {
    const fence = { key: 'ingestion:source:507f1f77bcf86cd799439012', jobId: '507f1f77bcf86cd799439011', ownerTokenHash: 'a'.repeat(64), leaseGeneration: 1 }
    const trace = vi.fn()
    const jobRepository = { claimQueuedWithFence: vi.fn(async () => true), completeWithFence: vi.fn(async () => ({})) }
    const leaseRepository = { acquire: vi.fn(async () => fence) }
    const adapter = createIngestionQueueAdapter({
      jobRepository,
      leaseRepository,
      executor: vi.fn(async () => { throw Object.assign(new Error('https://secret.example/token raw body'), { code: 'source_fetch_failed', retryable: true }) }),
      trace,
      ownerToken: () => 'fixed-owner-token',
    })

    await adapter.claimAndExecute({ candidate: { id: fence.jobId, sourceId: '507f1f77bcf86cd799439012' } })

    const serialized = JSON.stringify(trace.mock.calls)
    expect(serialized).not.toContain('https://secret.example/token')
    expect(serialized).not.toContain('raw body')
    expect(trace.mock.calls.some(([event]) => event.errorCode === 'source_fetch_failed')).toBe(true)
  })
  it('returns unresolved finalization when terminal completion exceeds grace', async () => {
    vi.useFakeTimers()
    try {
      const fence = { key: 'ingestion:source:507f1f77bcf86cd799439012', jobId: '507f1f77bcf86cd799439011', ownerTokenHash: 'a'.repeat(64), leaseGeneration: 1 }
      const completeWithFence = vi.fn(() => new Promise(() => {}))
      const finalizeOrphanedAttempt = vi.fn(() => new Promise(() => {}))
      const leaseRepository = { acquire: vi.fn(async () => fence) }
      const adapter = createIngestionQueueAdapter({
        jobRepository: { claimQueuedWithFence: vi.fn(async () => true), completeWithFence, finalizeOrphanedAttempt },
        leaseRepository,
        executor: vi.fn(async () => ({ status: 'succeeded' })),
        finalizationGraceMs: 25,
        ownerToken: () => 'fixed-owner-token',
      })

      const run = adapter.claimAndExecute({ candidate: { id: fence.jobId, sourceId: '507f1f77bcf86cd799439012' } })
      await vi.advanceTimersByTimeAsync(0)
      expect(completeWithFence).toHaveBeenCalled()
      const rejection = expect(run).rejects.toMatchObject({ code: 'ingestion_finalization_unresolved', retryable: false })
      await vi.advanceTimersByTimeAsync(25)
      await rejection
      expect(finalizeOrphanedAttempt).not.toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })
  it('uses bounded orphan finalization after active lease heartbeat loss', async () => {
    vi.useFakeTimers()
    try {
      const fence = { key: 'ingestion:source:507f1f77bcf86cd799439012', jobId: '507f1f77bcf86cd799439011', ownerTokenHash: 'a'.repeat(64), leaseGeneration: 1 }
      const finalizeOrphanedAttempt = vi.fn(async () => true)
      const jobRepository = { claimQueuedWithFence: vi.fn(async () => true), completeWithFence: vi.fn(), finalizeOrphanedAttempt }
      const leaseRepository = { acquire: vi.fn(async () => fence), heartbeat: vi.fn(async () => false) }
      const executor = vi.fn(({ signal }) => new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true })))
      const adapter = createIngestionQueueAdapter({ jobRepository, leaseRepository, executor, leaseMs: 300, finalizationGraceMs: 25, ownerToken: () => 'fixed-owner-token' })

      const run = adapter.claimAndExecute({ candidate: { id: fence.jobId, sourceId: '507f1f77bcf86cd799439012' } })
      await vi.advanceTimersByTimeAsync(100)
      await expect(run).resolves.toEqual({ status: 'failed', claimed: true })
      const finalization = finalizeOrphanedAttempt.mock.calls[0][0]
      expect(finalization.jobId).toBe(fence.jobId)
      expect(finalization.fence).toEqual(fence)
      expect(finalization.error).toMatchObject({ code: 'lease_heartbeat_lost' })
      expect(jobRepository.completeWithFence).not.toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })
  it('returns unresolved finalization when orphan cleanup exceeds grace', async () => {
    vi.useFakeTimers()
    try {
      const fence = { key: 'ingestion:source:507f1f77bcf86cd799439012', jobId: '507f1f77bcf86cd799439011', ownerTokenHash: 'a'.repeat(64), leaseGeneration: 1 }
      const completionError = Object.assign(new Error('lease heartbeat lost'), { code: 'lease_heartbeat_lost', retryable: true })
      const finalizeOrphanedAttempt = vi.fn(() => new Promise(() => {}))
      const adapter = createIngestionQueueAdapter({
        jobRepository: {
          claimQueuedWithFence: vi.fn(async () => true),
          completeWithFence: vi.fn(async () => { throw completionError }),
          finalizeOrphanedAttempt,
        },
        leaseRepository: { acquire: vi.fn(async () => fence) },
        executor: vi.fn(async () => ({ status: 'succeeded' })),
        finalizationGraceMs: 25,
        ownerToken: () => 'fixed-owner-token',
      })

      const run = adapter.claimAndExecute({ candidate: { id: fence.jobId, sourceId: '507f1f77bcf86cd799439012' } })
      const rejection = expect(run).rejects.toMatchObject({ code: 'ingestion_finalization_unresolved', retryable: false })
      await vi.advanceTimersByTimeAsync(0)
      expect(finalizeOrphanedAttempt).toHaveBeenCalled()
      await vi.advanceTimersByTimeAsync(25)
      await rejection
    } finally {
      vi.useRealTimers()
    }
  })

  it('surfaces unresolved terminalization instead of returning success', async () => {
    const fence = { key: 'ingestion:source:507f1f77bcf86cd799439012', jobId: '507f1f77bcf86cd799439011', ownerTokenHash: 'a'.repeat(64), leaseGeneration: 1 }
    const completionError = Object.assign(new Error('lease expired'), { code: 'conflict', status: 409 })
    const jobRepository = {
      claimQueuedWithFence: vi.fn(async () => true),
      completeWithFence: vi.fn(async () => { throw completionError }),
      finalizeOrphanedAttempt: vi.fn(async () => false),
    }
    const leaseRepository = { acquire: vi.fn(async () => fence) }
    const adapter = createIngestionQueueAdapter({ jobRepository, leaseRepository, executor: vi.fn(async () => ({ status: 'succeeded' })), ownerToken: () => 'fixed-owner-token' })

    await expect(adapter.claimAndExecute({ candidate: { id: fence.jobId, sourceId: '507f1f77bcf86cd799439012' } })).rejects.toMatchObject({ code: 'ingestion_finalization_unresolved', retryable: false })
  })
})
