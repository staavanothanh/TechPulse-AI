import { describe, expect, it, vi } from 'vitest'
import { createCoordinatorRunner, createFlushedCoordinatorRunner } from '../../../server/bootstrap/jobs.js'
import { createQueueRegistry } from '../../../server/jobs/queue-registry.js'

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

describe('coordinator tracing instrumentation', () => {
  it('emits start, recovery, queue claims, and finish trace events with the canonical runId', async () => {
    const registry = createQueueRegistry()
    const ingestion = adapter('ingestion', 2)
    registry.register(ingestion)

    const trace = vi.fn()
    const runId = 'test-coordinator-run-42'

    const runDueWork = createCoordinatorRunner({
      queueRegistry: registry,
      maxJobs: 2,
      maxRecoveries: 1,
      budgetMs: 5000,
      runIdFactory: () => runId,
      trace,
      now: () => new Date('2026-08-10T00:00:00.000Z'),
    })
    const result = await runDueWork()

    expect(result.runId).toBe(runId)
    const traceCalls = trace.mock.calls.map(([event]) => event)
    expect(traceCalls.some((e) => e.stage === 'coordinator' && e.status === 'started' && e.runId === runId)).toBe(true)
    expect(traceCalls.some((e) => e.stage === 'coordinator.recovery' && e.runId === runId)).toBe(true)
    expect(traceCalls.some((e) => e.stage === 'coordinator.claim' && e.runId === runId && e.queueName === 'ingestion')).toBe(true)
    expect(traceCalls.some((e) => e.stage === 'coordinator' && e.status === 'succeeded' && e.runId === runId)).toBe(true)
  })
  it('emits retriesCreated instead of the ambiguous created recovery counter', async () => {
    const registry = createQueueRegistry()
    const ingestion = adapter('ingestion', 0)
    ingestion.recoverExpired = vi.fn(async () => ({ inspected: 1, recovered: 1, retriesCreated: 1, failed: 0 }))
    registry.register(ingestion)
    const trace = vi.fn()
    const runner = createCoordinatorRunner({
      queueRegistry: registry,
      maxJobs: 1,
      maxRecoveries: 1,
      budgetMs: 2_000,
      runIdFactory: () => 'recovery-counter-run',
      trace,
      now: () => new Date('2026-08-10T00:00:00.000Z'),
    })

    await runner()

    const recovery = trace.mock.calls
      .map(([event]) => event)
      .find((event) => event.stage === 'coordinator.recovery' && event.status === 'succeeded' && event.counters)
    expect(recovery.counters).toEqual({ inspected: 1, recovered: 1, retriesCreated: 1, failed: 0 })
    expect(recovery.counters.created).toBeUndefined()
  })
  it('emits aggregate coordinator.recovery completion with recovered counter even when queue has zero expired jobs', async () => {
    const registry = createQueueRegistry()
    const ingestion = adapter('ingestion', 0)
    ingestion.recoverExpired = vi.fn(async () => ({ inspected: 0, recovered: 0, retriesCreated: 0, failed: 0 }))
    registry.register(ingestion)
    const trace = vi.fn()
    const runner = createCoordinatorRunner({
      queueRegistry: registry,
      maxJobs: 1,
      maxRecoveries: 1,
      budgetMs: 2_000,
      runIdFactory: () => 'empty-recovery-run',
      trace,
      now: () => new Date('2026-08-10T00:00:00.000Z'),
    })

    await runner()

    const completion = trace.mock.calls
      .map(([event]) => event)
      .find((event) => event.stage === 'coordinator.recovery' && event.status === 'deferred' && event.counters)
    expect(completion).toBeDefined()
    expect(completion.counters).toEqual({ inspected: 0, recovered: 0, retriesCreated: 0, failed: 0 })
  })
  it('emits a failed recovery event before propagating adapter errors', async () => {
    const registry = createQueueRegistry()
    const ingestion = adapter('ingestion', 0)
    ingestion.recoverExpired = vi.fn(async () => {
      throw Object.assign(new Error('recovery unavailable'), { code: 'database_unavailable' })
    })
    registry.register(ingestion)
    const trace = vi.fn()
    const runner = createCoordinatorRunner({
      queueRegistry: registry,
      maxJobs: 1,
      maxRecoveries: 1,
      budgetMs: 2_000,
      runIdFactory: () => 'recovery-failure-run',
      trace,
      now: () => new Date('2026-08-10T00:00:00.000Z'),
    })

    await expect(runner()).rejects.toMatchObject({ code: 'database_unavailable' })

    const failure = trace.mock.calls
      .map(([event]) => event)
      .find((event) => event.stage === 'coordinator.recovery' && event.status === 'failed')
    expect(failure).toMatchObject({ runId: 'recovery-failure-run', queueName: 'ingestion', errorCode: 'database_unavailable' })
  })

  it('awaits tracer flush for direct coordinator callers', async () => {
    const trace = vi.fn()
    trace.flush = vi.fn(async () => true)
    const registry = createQueueRegistry()
    const rawRunner = createCoordinatorRunner({
      queueRegistry: registry,
      maxJobs: 0,
      maxRecoveries: 0,
      budgetMs: 1_000,
      trace,
      runIdFactory: () => 'direct-run',
      now: () => new Date('2026-08-10T00:00:00.000Z'),
    })
    const runner = createFlushedCoordinatorRunner({ coordinatorRunner: rawRunner, trace })

    await runner()

    expect(trace.flush).toHaveBeenCalledOnce()
  })
})
