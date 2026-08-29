import { describe, expect, it, vi } from 'vitest'
import { createQueueRegistry } from '../../../server/jobs/queue-registry.js'
import { runDueWork } from '../../../server/jobs/due-work-coordinator.js'

function adapter(queueName, due = 1) {
  let remaining = due
  return {
    queueName,
    recoveryStrategy: queueName === 'account-deletion' ? 'same-request-requeue' : 'terminal-parent-linked-retry',
    recoverExpired: vi.fn(async () => ({ inspected: 0, recovered: 0, retriesCreated: 0, failed: 0 })),
    selectDue: vi.fn(async () => remaining > 0 ? { id: `${queueName}-${remaining}`, availableAt: new Date('2026-08-10T00:00:00.000Z') } : null),
    claimAndExecute: vi.fn(async () => { remaining -= 1; return { status: 'succeeded' } }),
    nextAvailableAt: vi.fn(async () => remaining > 0 ? new Date('2026-08-10T00:00:00.000Z') : null),
  }
}

describe('bounded cross-queue fairness', () => {
  it('gives each of three due queues exactly one reserved attempt with maxJobs=3', async () => {
    const registry = createQueueRegistry()
    const queues = [adapter('account-deletion', 3), adapter('indexing', 3), adapter('ingestion', 3)]
    queues.forEach((queue) => registry.register(queue))
    const result = await runDueWork({ registry, maxJobs: 3, maxRecoveries: 0, budgetMs: 5000, now: () => new Date('2026-08-10T00:00:00.000Z') })
    queues.forEach((queue) => expect(queue.claimAndExecute).toHaveBeenCalledTimes(1))
    expect(result.queues.ingestion.claimed).toBe(1)
    expect(result.queues.indexing.claimed).toBe(1)
    expect(result.queues.accountDeletion.claimed).toBe(1)
  })

  it('fails safe before querying queues when maxJobs or budget cannot cover reserved attempts', async () => {
    const registry = createQueueRegistry()
    const queues = [adapter('account-deletion'), adapter('indexing'), adapter('ingestion')]
    queues.forEach((queue) => registry.register(queue))
    await expect(runDueWork({ registry, maxJobs: 2, maxRecoveries: 0, budgetMs: 5000 })).rejects.toThrow(/maxJobs/i)
    await expect(runDueWork({ registry, maxJobs: 3, maxRecoveries: 0, budgetMs: 100 })).rejects.toThrow(/budget/i)
    queues.forEach((queue) => expect(queue.selectDue).not.toHaveBeenCalled())
  })

  it('keeps unregistered queues at zero without querying a collection and spills unused capacity', async () => {
    const registry = createQueueRegistry()
    const ingestion = adapter('ingestion', 3)
    registry.register(ingestion)
    const result = await runDueWork({ registry, maxJobs: 3, maxRecoveries: 0, budgetMs: 5000, now: () => new Date('2026-08-10T00:00:00.000Z') })
    expect(ingestion.claimAndExecute).toHaveBeenCalledTimes(3)
    expect(result.queues.indexing).toEqual({ claimed: 0, succeeded: 0, partial: 0, failed: 0, deferred: 0 })
    expect(result.queues.accountDeletion).toEqual({ claimed: 0, succeeded: 0, partial: 0, failed: 0, deferred: 0 })
  })

  it('does not repeatedly select a queue that deferred in the same invocation', async () => {
    const registry = createQueueRegistry()
    const ingestion = adapter('ingestion', 3)
    ingestion.claimAndExecute = vi.fn(async () => ({ status: 'deferred', claimed: false }))
    registry.register(ingestion)
    const result = await runDueWork({ registry, maxJobs: 3, maxRecoveries: 0, budgetMs: 5000, now: () => new Date('2026-08-10T00:00:00.000Z') })
    expect(ingestion.claimAndExecute).toHaveBeenCalledTimes(1)
    expect(result.queues.ingestion).toEqual({ claimed: 0, succeeded: 0, partial: 0, failed: 0, deferred: 1 })
  })

  it('stops before the safety margin instead of starting spill work late', async () => {
    const registry = createQueueRegistry()
    const ingestion = adapter('ingestion', 3)
    registry.register(ingestion)
    const moments = [new Date(0), new Date(900), new Date(900), new Date(900)]
    const result = await runDueWork({ registry, maxJobs: 3, maxRecoveries: 0, budgetMs: 1000, now: () => moments.shift() ?? new Date(900) })
    expect(ingestion.claimAndExecute).not.toHaveBeenCalled()
    expect(result.queues.ingestion.claimed).toBe(0)
  })

  it('maps unknown adapter outcomes to failed and exposes registry lookup without reordering', async () => {
    const registry = createQueueRegistry()
    const ingestion = adapter('ingestion', 1)
    ingestion.selectDue = vi.fn(async () => ({ id: 'bad-time', availableAt: 'invalid' }))
    ingestion.claimAndExecute = vi.fn(async () => ({ status: 'unknown' }))
    ingestion.nextAvailableAt = vi.fn(async () => 'invalid')
    registry.register(ingestion)
    expect(registry.size).toBe(1)
    expect(registry.get('ingestion')).toBe(ingestion)
    const result = await runDueWork({ registry, maxJobs: 1, maxRecoveries: 0, budgetMs: 1000, now: () => new Date('2026-08-10T00:00:00.000Z') })
    expect(result.queues.ingestion).toEqual({ claimed: 1, succeeded: 0, partial: 0, failed: 1, deferred: 0 })
    expect(result.nextAvailableAt).toBeNull()
  })

  it('rejects unknown or incomplete queue adapters before registration', () => {
    const registry = createQueueRegistry()
    expect(() => registry.register({ queueName: 'unknown' })).toThrow(/name/i)
    expect(() => registry.register({ queueName: 'ingestion', recoveryStrategy: 'same-request-requeue' })).toThrow(/recovery strategy/i)
    expect(() => registry.register({ queueName: 'ingestion', recoveryStrategy: 'terminal-parent-linked-retry' })).toThrow(/selectDue/i)
  })

  it('uses the bounded recovery allowance across repeated items in one queue', async () => {
    const registry = createQueueRegistry()
    const ingestion = adapter('ingestion', 0)
    let expired = 3
    ingestion.recoverExpired = vi.fn(async () => {
      if (expired === 0) return { inspected: 0, recovered: 0, retriesCreated: 0, failed: 0 }
      expired -= 1
      return { inspected: 1, recovered: 1, retriesCreated: 1, failed: 0 }
    })
    registry.register(ingestion)
    const result = await runDueWork({ registry, maxJobs: 1, maxRecoveries: 3, budgetMs: 2000, now: () => new Date('2026-08-10T00:00:00.000Z') })
    expect(ingestion.recoverExpired).toHaveBeenCalledTimes(3)
    expect(result.recovery).toEqual({ inspected: 3, recovered: 3, retriesCreated: 3, failed: 0 })
  })

  it('processes independent sources when one source encounters a lease conflict', async () => {
    const registry = createQueueRegistry()
    const candidates = [
      { id: 'job-source-a', sourceId: 'source-A', availableAt: new Date('2026-08-10T00:00:00.000Z') },
      { id: 'job-source-b', sourceId: 'source-B', availableAt: new Date('2026-08-10T00:00:00.000Z') },
    ]
    const ingestion = {
      queueName: 'ingestion',
      recoveryStrategy: 'terminal-parent-linked-retry',
      recoverExpired: vi.fn(async () => ({ inspected: 0, recovered: 0, retriesCreated: 0, failed: 0 })),
      selectDue: vi.fn(async ({ excludeSourceIds = [] } = {}) => {
        return candidates.find((c) => !excludeSourceIds.includes(c.sourceId)) ?? null
      }),
      claimAndExecute: vi.fn(async ({ candidate }) => {
        if (candidate.sourceId === 'source-A') {
          return { status: 'deferred', claimed: false, sourceId: 'source-A' }
        }
        return { status: 'succeeded', claimed: true, sourceId: 'source-B' }
      }),
      nextAvailableAt: vi.fn(async () => null),
    }
    registry.register(ingestion)

    const result = await runDueWork({
      registry,
      maxJobs: 2,
      maxRecoveries: 0,
      budgetMs: 5000,
      now: () => new Date('2026-08-10T00:00:00.000Z'),
    })

    expect(ingestion.claimAndExecute).toHaveBeenCalledTimes(2)
    expect(result.queues.ingestion).toEqual({
      claimed: 1,
      succeeded: 1,
      partial: 0,
      failed: 0,
      deferred: 1,
    })
  })

  it('ensures each due queue receives a fair turn before older backlog items spill', async () => {
    const registry = createQueueRegistry()
    // Indexing backlog is older (2026-08-01)
    const indexingCandidate = { id: 'old-indexing-1', availableAt: new Date('2026-08-01T00:00:00.000Z') }
    // Ingestion candidate is newer (2026-08-10)
    const ingestionCandidate = { id: 'new-ingestion-1', sourceId: 'source-1', availableAt: new Date('2026-08-10T00:00:00.000Z') }

    const indexing = {
      queueName: 'indexing',
      recoveryStrategy: 'terminal-parent-linked-retry',
      recoverExpired: vi.fn(async () => ({ inspected: 0, recovered: 0, retriesCreated: 0, failed: 0 })),
      selectDue: vi.fn(async () => indexingCandidate),
      claimAndExecute: vi.fn(async () => ({ status: 'succeeded', claimed: true })),
      nextAvailableAt: vi.fn(async () => null),
    }
    const ingestion = {
      queueName: 'ingestion',
      recoveryStrategy: 'terminal-parent-linked-retry',
      recoverExpired: vi.fn(async () => ({ inspected: 0, recovered: 0, retriesCreated: 0, failed: 0 })),
      selectDue: vi.fn(async () => ingestionCandidate),
      claimAndExecute: vi.fn(async () => ({ status: 'succeeded', claimed: true, sourceId: 'source-1' })),
      nextAvailableAt: vi.fn(async () => null),
    }

    registry.register(indexing)
    registry.register(ingestion)

    const result = await runDueWork({
      registry,
      maxJobs: 2,
      maxRecoveries: 0,
      budgetMs: 5000,
      now: () => new Date('2026-08-10T00:00:00.000Z'),
    })

    // Both indexing and ingestion must have claimed 1 job in the initial fair turn
    expect(indexing.claimAndExecute).toHaveBeenCalledTimes(1)
    expect(ingestion.claimAndExecute).toHaveBeenCalledTimes(1)
    expect(result.queues.indexing.claimed).toBe(1)
    expect(result.queues.ingestion.claimed).toBe(1)
  })

  it('re-checks indexing queue in spill loop after ingestion creates downstream work', async () => {
    const registry = createQueueRegistry()
    let indexingCreated = false
    let indexingRemaining = 1
    const indexing = {
      queueName: 'indexing',
      recoveryStrategy: 'terminal-parent-linked-retry',
      recoverExpired: vi.fn(async () => ({ inspected: 0, recovered: 0, retriesCreated: 0, failed: 0 })),
      selectDue: vi.fn(async () => {
        if (indexingCreated && indexingRemaining > 0) {
          indexingRemaining -= 1
          return { id: 'new-indexing-1', availableAt: new Date('2026-08-10T00:00:00.000Z') }
        }
        return null
      }),
      claimAndExecute: vi.fn(async () => ({ status: 'succeeded', claimed: true })),
      nextAvailableAt: vi.fn(async () => null),
    }
    let ingestionRemaining = 1
    const ingestion = {
      queueName: 'ingestion',
      recoveryStrategy: 'terminal-parent-linked-retry',
      recoverExpired: vi.fn(async () => ({ inspected: 0, recovered: 0, retriesCreated: 0, failed: 0 })),
      selectDue: vi.fn(async () => {
        if (ingestionRemaining > 0) {
          ingestionRemaining -= 1
          return { id: 'ingestion-1', sourceId: 'src-1', availableAt: new Date('2026-08-10T00:00:00.000Z') }
        }
        return null
      }),
      claimAndExecute: vi.fn(async () => {
        indexingCreated = true
        return { status: 'succeeded', claimed: true, sourceId: 'src-1' }
      }),
      nextAvailableAt: vi.fn(async () => null),
    }

    registry.register(indexing)
    registry.register(ingestion)

    const result = await runDueWork({
      registry,
      maxJobs: 3,
      maxRecoveries: 0,
      budgetMs: 5000,
      now: () => new Date('2026-08-10T00:00:00.000Z'),
    })

    expect(ingestion.claimAndExecute).toHaveBeenCalledTimes(1)
    expect(indexing.claimAndExecute).toHaveBeenCalledTimes(1)
    expect(result.queues.ingestion.claimed).toBe(1)
    expect(result.queues.indexing.claimed).toBe(1)
  })
})
