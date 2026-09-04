import { describe, expect, it, vi } from 'vitest'
import { assertCronObservabilityReady, assertDurableJobsReady, createConfiguredJobRuntime, createConfiguredJobService, createCronDueWorkRunner, createProfiledIndexingDrainRunner } from '../../../server/bootstrap/jobs.js'
import { DURABLE_JOB_AUDIT_VALIDATOR, DURABLE_JOB_COLLECTIONS, DURABLE_JOB_INDEXES } from '../../../scripts/migrations/durable-jobs.js'
import { CRON_OBSERVABILITY_COLLECTIONS, CRON_OBSERVABILITY_INDEXES } from '../../../scripts/migrations/cron-observability.js'
import { GOVERNANCE_COLLECTIONS, GOVERNANCE_DATABASE_COLLECTIONS, GOVERNANCE_DATABASE_INDEXES, GOVERNANCE_INDEXES } from '../../../scripts/migrations/governance.js'
import { GOVERNANCE_AUDIT_INDEXES, GOVERNANCE_AUDIT_VALIDATOR } from '../../../scripts/migrations/governance-audit.js'
import { GOVERNANCE_HARDENING_INDEXES } from '../../../scripts/migrations/governance-hardening.js'
import { GOVERNANCE_RETENTION_TAKEDOWN_VALIDATOR } from '../../../scripts/migrations/governance-retention-hardening.js'
import { ARTICLE_GOVERNANCE_HARDENING_VALIDATOR } from '../../../scripts/migrations/article-governance-hardening.js'

function readyContext({ auditValidator = DURABLE_JOB_AUDIT_VALIDATOR, indexOverride } = {}) {
  const collections = Object.entries(DURABLE_JOB_COLLECTIONS).map(([name, definition]) => ({
    name,
    options: { validator: definition.validator, validationLevel: 'strict', validationAction: 'error' },
  }))
  collections.push({ name: 'adminAuditLogs', options: { validator: auditValidator, validationLevel: 'strict', validationAction: 'error' } })
  for (const [name, definition] of Object.entries(GOVERNANCE_COLLECTIONS)) collections.push({ name, options: { validator: name === 'takedownRequests' ? GOVERNANCE_RETENTION_TAKEDOWN_VALIDATOR : definition.validator, validationLevel: 'strict', validationAction: 'error' } })
  collections.push({ name: 'articles', options: { validator: ARTICLE_GOVERNANCE_HARDENING_VALIDATOR, validationLevel: 'strict', validationAction: 'error' } })
  const governanceCollections = Object.entries(GOVERNANCE_DATABASE_COLLECTIONS).map(([name, definition]) => ({ name, options: { validator: definition.validator, validationLevel: 'strict', validationAction: 'error' } }))
  const governanceDb = {
    listCollections: () => ({ toArray: async () => governanceCollections }),
    collection: (name) => ({ indexes: async () => GOVERNANCE_DATABASE_INDEXES[name]?.map((index) => ({ name: index.name, key: index.key, ...(index.options ?? {}) })) ?? [] }),
  }
  const appIndexes = Object.fromEntries(Object.keys({ ...GOVERNANCE_INDEXES, ...GOVERNANCE_HARDENING_INDEXES }).map((name) => [name, [...(GOVERNANCE_INDEXES[name] ?? []), ...(GOVERNANCE_HARDENING_INDEXES[name] ?? [])].map((index) => ({ name: index.name, key: index.key, ...(index.options ?? {}) }))]))
  const auditIndexes = GOVERNANCE_AUDIT_INDEXES.map((index) => ({ name: index.name, key: index.key, ...(index.options ?? {}) }))
  return {
    client: { db: () => governanceDb },
    db: {
      listCollections: () => ({ toArray: async () => collections }),
      collection: (name) => ({
        indexes: async () => indexOverride?.[name] ?? (name === 'adminAuditLogs' ? auditIndexes : appIndexes[name] ?? DURABLE_JOB_INDEXES[name]?.map((index) => ({ name: index.name, key: index.key, ...(index.options ?? {}) })) ?? []),
      }),
    },
    governanceDb,
  }
}


describe('cron observability bootstrap readiness', () => {
  it('requires the strict event validator and every event index', async () => {
    const context = readyContext()
    const originalListCollections = context.db.listCollections
    const originalCollection = context.db.collection
    const definition = CRON_OBSERVABILITY_COLLECTIONS.cronLifecycleEvents
    const eventCollection = {
      indexes: async () => CRON_OBSERVABILITY_INDEXES.cronLifecycleEvents.map((index) => ({ name: index.name, key: index.key, ...(index.options ?? {}) })),
    }
    const collections = await originalListCollections({}, { nameOnly: false }).toArray()
    context.db.listCollections = () => ({ toArray: async () => [...collections, { name: 'cronLifecycleEvents', options: { validator: definition.validator, validationLevel: 'strict', validationAction: 'error' } }] })
    context.db.collection = (name) => name === 'cronLifecycleEvents' ? eventCollection : originalCollection(name)

    await expect(assertCronObservabilityReady(context)).resolves.toBeUndefined()
    context.db.collection = (name) => name === 'cronLifecycleEvents' ? { indexes: async () => [] } : originalCollection(name)
    await expect(assertCronObservabilityReady(context)).rejects.toThrow(/cron-observability indexes/i)
  })
})
describe('durable-jobs bootstrap readiness', () => {
  it('constructs repositories and service only for exact validators and indexes', async () => {
    const context = readyContext()
    const rateLimitAdmission = { reserve: async () => ({ allowed: true }) }
    await expect(assertDurableJobsReady(context)).resolves.toBeUndefined()
    const configured = await createConfiguredJobService({ context, rateLimitAdmission })
    expect(configured).toEqual(expect.objectContaining({
      jobService: expect.objectContaining({ createIngestionJob: expect.any(Function) }),
      jobRepository: expect.any(Object),
      leaseRepository: expect.any(Object),
    }))
    const quotaKeyring = { currentVersion: 1, versions: [1], digest: vi.fn(() => 'a'.repeat(64)) }
    const governanceKeyring = { currentVersion: 1, versions: [1], digest: vi.fn(() => 'b'.repeat(64)) }
    const governanceContext = readyContext({ auditValidator: GOVERNANCE_AUDIT_VALIDATOR })
    const maintenanceContext = { ...governanceContext, client: { db: () => governanceContext.governanceDb } }
    const cronEventRepository = { purgeExpiredEvents: vi.fn() }
    const runtime = await createConfiguredJobRuntime({ context: governanceContext, cronEventRepository, rateLimitAdmission, quotaKeyring, governanceKeyring, governanceDb: governanceContext.governanceDb, maintenanceContext })
    expect(runtime.queueRegistry.registered().map(({ queueName }) => queueName)).toEqual(['account-deletion', 'ingestion'])
    expect(runtime.maintenanceRegistry.has('purge-ingestion-jobs')).toBe(true)
    expect(runtime.maintenanceRegistry.has('purge-indexing-jobs')).toBe(false)
    expect(runtime.maintenanceRegistry.has('purge-takedown-pii')).toBe(true)
    expect(runtime.maintenanceRegistry.has('purge-takedown-workflows')).toBe(true)
    expect(runtime.maintenanceRegistry.has('purge-account-deletion-workflows')).toBe(true)
    expect(runtime.maintenanceRegistry.has('purge-audit-ip-hmac')).toBe(true)
    expect(runtime.maintenanceRegistry.has('purge-cron-lifecycle-events')).toBe(true)
  })
  it('registers lifecycle retention in the bounded cron materialization phase', async () => {
    const context = readyContext({ auditValidator: GOVERNANCE_AUDIT_VALIDATOR })
    const governanceContext = readyContext({ auditValidator: GOVERNANCE_AUDIT_VALIDATOR })
    const maintenanceContext = { ...governanceContext, client: { db: () => governanceContext.governanceDb } }
    const cutoff = new Date('2026-09-03T10:00:00.000Z')
    const purgeExpiredEvents = vi.fn(async () => ({ inspected: 4, affected: 2, hasMore: false }))
    const runtime = await createConfiguredJobRuntime({
      context,
      maintenanceContext,
      maintenanceCronEventRepository: { purgeExpiredEvents },
      rateLimitAdmission: { reserve: async () => ({ allowed: true }) },
      quotaKeyring: { currentVersion: 1, versions: [1], digest: vi.fn(() => 'a'.repeat(64)) },
      governanceKeyring: { currentVersion: 1, versions: [1], digest: vi.fn(() => 'b'.repeat(64)) },
      governanceDb: context.governanceDb,
      now: () => cutoff,
    })

    expect(runtime.cronMaterializers).toHaveLength(2)
    const result = await runtime.cronMaterializers[0]({ deadline: new Date(cutoff.getTime() + 60_000) })

    expect(result).toEqual({ inspected: 4, affected: 2, hasMore: false })
    expect(purgeExpiredEvents).toHaveBeenCalledWith({ cutoff, limit: 100, deadline: new Date(cutoff.getTime() + 60_000) })
  })

  it('runs takedown PII cleanup through the runtime takedown repository', async () => {
    const context = readyContext({ auditValidator: GOVERNANCE_AUDIT_VALIDATOR })
    const baseCollection = context.db.collection.bind(context.db)
    const takedownCollection = {
      indexes: async () => [...GOVERNANCE_INDEXES.takedownRequests, ...GOVERNANCE_HARDENING_INDEXES.takedownRequests].map((index) => ({ name: index.name, key: index.key, ...(index.options ?? {}) })),
      find: vi.fn(() => ({
        hint() { return this },
        sort() { return this },
        limit() { return this },
        toArray: async () => [],
      })),
    }
    context.db.collection = (name) => name === 'takedownRequests' ? takedownCollection : baseCollection(name)
    const maintenanceContext = {
      ...context,
      client: { id: 'maintenance' },
      db: { collection(name) { if (name === 'takedownRequests') throw new Error('maintenance takedown access is forbidden'); return baseCollection(name) } },
    }
    const runtime = await createConfiguredJobRuntime({
      context,
      rateLimitAdmission: { reserve: async () => ({ allowed: true }) },
      quotaKeyring: { currentVersion: 1, versions: [1], digest: vi.fn(() => 'a'.repeat(64)) },
      governanceKeyring: { currentVersion: 1, versions: [1], digest: vi.fn(() => 'b'.repeat(64)) },
      governanceDb: context.governanceDb,
      maintenanceContext,
    })

    await expect(runtime.maintenanceRegistry.get('purge-takedown-pii')({ cutoff: new Date('2026-08-14T00:00:00.000Z'), limit: 100 })).resolves.toEqual({ inspected: 0, affected: 0, hasMore: false })
    expect(takedownCollection.find).toHaveBeenCalledOnce()
  })

  it('fails closed for audit IP-HMAC cleanup when only the append-only runtime client exists', async () => {
    const governanceContext = readyContext({ auditValidator: GOVERNANCE_AUDIT_VALIDATOR })
    const runtime = await createConfiguredJobRuntime({
      context: governanceContext,
      rateLimitAdmission: { reserve: async () => ({ allowed: true }) },
      quotaKeyring: { currentVersion: 1, versions: [1], digest: vi.fn(() => 'a'.repeat(64)) },
      governanceKeyring: { currentVersion: 1, versions: [1], digest: vi.fn(() => 'b'.repeat(64)) },
      governanceDb: governanceContext.governanceDb,
    })
    expect(runtime.maintenanceRegistry.has('purge-audit-ip-hmac')).toBe(false)
    expect(runtime.maintenanceContext).toBeNull()
  })

  it('executes audit IP-HMAC cleanup through the separate maintenance context', async () => {
    const governanceContext = readyContext({ auditValidator: GOVERNANCE_AUDIT_VALIDATOR })
    const baseDb = governanceContext.db
    const auditCollection = {
      indexes: async () => GOVERNANCE_AUDIT_INDEXES.map((index) => ({ name: index.name, key: index.key, ...(index.options ?? {}) })),
      find: vi.fn(() => ({
        sort: () => ({
          limit: () => ({
            project: () => ({ toArray: async () => [{ _id: 'audit-1' }] }),
          }),
        }),
      })),
      updateMany: vi.fn(async () => ({ modifiedCount: 1 })),
    }
    const maintenanceContext = {
      ...governanceContext,
      client: { db: () => governanceContext.governanceDb },
      db: { ...baseDb, collection: (name) => name === 'adminAuditLogs' ? auditCollection : baseDb.collection(name) },
    }
    const runtime = await createConfiguredJobRuntime({
      context: governanceContext,
      rateLimitAdmission: { reserve: async () => ({ allowed: true }) },
      quotaKeyring: { currentVersion: 1, versions: [1], digest: vi.fn(() => 'a'.repeat(64)) },
      governanceKeyring: { currentVersion: 1, versions: [1], digest: vi.fn(() => 'b'.repeat(64)) },
      governanceDb: governanceContext.governanceDb,
      maintenanceContext,
    })
    const result = await runtime.maintenanceRegistry.get('purge-audit-ip-hmac')({ cutoff: new Date('2026-08-14T00:00:00.000Z'), limit: 100 })
    expect(result).toEqual({ inspected: 1, affected: 1, hasMore: false })
    expect(auditCollection.updateMany).toHaveBeenCalledOnce()
  })

  it('fails closed instead of registering deletion cleanup without quota and governance keys', async () => {
    await expect(createConfiguredJobRuntime({ context: readyContext(), rateLimitAdmission: { reserve: async () => ({ allowed: true }) } })).rejects.toThrow(/quota.*governance/i)
  })

  it('fails closed for stale audit validators or index drift', async () => {
    await expect(assertDurableJobsReady(readyContext({ auditValidator: {} }))).rejects.toThrow(/audit validator/i)
    await expect(assertDurableJobsReady(readyContext({ indexOverride: { ingestionJobs: [] } }))).rejects.toThrow(/indexes/i)
  })

  it('runs materialization only from the cron adapter before the shared coordinator', async () => {
    const calls = []
    const cron = createCronDueWorkRunner({
      jobRepository: { materializeDailyIngestion: async () => { calls.push('materialize') } },
      coordinatorRunner: async () => { calls.push('coordinate'); return { startedAt: new Date(), finishedAt: new Date() } },
      now: () => new Date('2026-08-10T00:00:00.000Z'),
    })
    await cron()
    expect(calls).toEqual(['materialize', 'coordinate'])
    await expect(createConfiguredJobService({ context: readyContext() })).rejects.toThrow(/rate-limit/i)
  })

  it('materializes ingestion before the indexing drain and keeps the drain on the cron path', async () => {
    const calls = []
    const cron = createCronDueWorkRunner({
      jobRepository: { materializeDailyIngestion: async () => { calls.push('materialize'); return { hasMore: false } } },
      indexingDrainRunner: async () => { calls.push('indexing-drain') },
      coordinatorRunner: async () => { calls.push('coordinate'); return { startedAt: new Date(), finishedAt: new Date() } },
      now: () => new Date('2026-08-10T00:00:00.000Z'),
    })

    await cron()

    expect(calls).toEqual(['materialize', 'coordinate', 'indexing-drain'])
  })

  it('awaits the tracer flush before the cron runner resolves', async () => {
    let flushed = false
    const trace = vi.fn()
    trace.flush = vi.fn(async () => { flushed = true; return true })
    const coordinatorRunner = vi.fn(async () => {
      expect(flushed).toBe(false)
      return { runId: 'run-1', startedAt: new Date(), finishedAt: new Date() }
    })
    const cron = createCronDueWorkRunner({
      jobRepository: { materializeDailyIngestion: async () => ({ hasMore: false }) },
      coordinatorRunner,
      trace,
      now: () => new Date('2026-08-10T00:00:00.000Z'),
    })

    await cron()

    expect(trace.flush).toHaveBeenCalledOnce()
    expect(flushed).toBe(true)
  })

  it('counts the fair turn against the profile cap and merges drain counters into indexing', async () => {
    const candidate = { id: 'job-1', articleId: 'article-1', task: 'summary' }
    const queue = {
      selectDue: vi.fn(async () => candidate),
      claimAndExecute: vi.fn(async () => ({ status: 'succeeded', claimed: true })),
      nextAvailableAt: vi.fn(async () => null),
    }
    const queueRegistry = { get: vi.fn(() => queue), registered: vi.fn(() => [queue]) }
    const runner = createProfiledIndexingDrainRunner({
      queueRegistry,
      profile: { maxJobs: 4, budgetMs: 45_000 },
      now: () => new Date('2026-08-10T00:00:00.000Z'),
    })
    const empty = { claimed: 0, succeeded: 0, partial: 0, failed: 0, deferred: 0 }
    const result = await runner({
      runId: 'base-run',
      startedAt: new Date('2026-08-10T00:00:00.000Z'),
      finishedAt: new Date('2026-08-10T00:00:01.000Z'),
      recovery: { inspected: 0, recovered: 0, retriesCreated: 0, failed: 0 },
      queues: {
        accountDeletion: { ...empty, deferred: 1 },
        ingestion: { ...empty, deferred: 1 },
        indexing: { ...empty, claimed: 1, succeeded: 1 },
      },
      nextAvailableAt: null,
    })

    expect(queue.claimAndExecute).toHaveBeenCalledTimes(1)
    expect(result.queues.indexing).toEqual({ claimed: 2, succeeded: 2, partial: 0, failed: 0, deferred: 0 })
  })

  it('consumes a bounded daily continuation when the first materialization page has more work', async () => {
    const materializeDailyIngestion = vi.fn()
      .mockResolvedValueOnce({ inspected: 100, created: 100, hasMore: true, period: '2026-08-10' })
      .mockResolvedValueOnce({ inspected: 1, created: 1, hasMore: false, period: '2026-08-10' })
    const coordinatorRunner = vi.fn(async () => ({ runId: 'cron-run', startedAt: new Date(), finishedAt: new Date() }))
    const cron = createCronDueWorkRunner({ jobRepository: { materializeDailyIngestion }, coordinatorRunner })
    await cron()
    expect(materializeDailyIngestion).toHaveBeenCalledTimes(2)
    expect(coordinatorRunner).toHaveBeenCalledTimes(1)
  })

  it('stops a never-ending continuation at the configured page cap before coordinating', async () => {
    const materializeDailyIngestion = vi.fn(async () => ({ hasMore: true }))
    const coordinatorRunner = vi.fn(async () => ({ startedAt: new Date(), finishedAt: new Date() }))
    const cron = createCronDueWorkRunner({
      jobRepository: { materializeDailyIngestion }, coordinatorRunner,
      now: () => new Date('2026-08-10T00:00:00.000Z'), maxMaterializationPages: 2,
    })
    await cron()
    expect(materializeDailyIngestion).toHaveBeenCalledTimes(2)
    expect(coordinatorRunner).toHaveBeenCalledTimes(1)
  })
  it('forwards the bounded materialization deadline to fixed callbacks', async () => {
    const startedAt = new Date('2026-09-03T10:00:00.000Z')
    const deadlines = []
    const cron = createCronDueWorkRunner({
      jobRepository: { materializeDailyIngestion: async () => ({ hasMore: false }) },
      coordinatorRunner: async () => ({ startedAt, finishedAt: startedAt }),
      materializers: [async ({ deadline }) => { deadlines.push(deadline) }],
      now: () => startedAt,
      materializationBudgetMs: 4_000,
    })

    await cron()

    expect(deadlines).toHaveLength(1)
    expect(deadlines[0]).toEqual(new Date(startedAt.getTime() + 4_000))
  })

  it('gives each fixed materializer one bounded turn before ingestion can exhaust the budget', async () => {
    const calls = []
    let tick = 0
    const cron = createCronDueWorkRunner({
      jobRepository: { materializeDailyIngestion: async () => { calls.push('ingestion'); return { hasMore: true } } },
      coordinatorRunner: async () => { calls.push('coordinate') },
      materializers: [async () => { calls.push('takedown') }],
      now: () => new Date(Date.UTC(2026, 7, 10, 0, 0, tick++ === 0 ? 0 : 3)),
      maxMaterializationPages: 10,
      materializationBudgetMs: 4_000,
    })
    await cron()
    expect(calls[0]).toBe('takedown')
    expect(calls).toContain('coordinate')
  })
  it('degrades a stalled fixed materializer to a deferred outcome without rejecting the cron invocation', async () => {
    vi.useFakeTimers()
    try {
      // Arrange
      const startedAt = new Date('2026-09-03T10:00:00.000Z')
      const materializationBudgetMs = 10
      let materializerSignal
      let materializerDeadline
      const materializer = vi.fn(({ signal, deadline }) => {
        materializerSignal = signal
        materializerDeadline = deadline
        return new Promise(() => {})
      })
      const coordinatorResult = {
        runId: 'cron-red-run',
        startedAt,
        finishedAt: startedAt,
        recovery: { inspected: 0, recovered: 0, retriesCreated: 0, failed: 0 },
        queues: {
          accountDeletion: { claimed: 0, succeeded: 0, partial: 0, failed: 0, deferred: 0 },
          ingestion: { claimed: 0, succeeded: 0, partial: 0, failed: 0, deferred: 0 },
          indexing: { claimed: 0, succeeded: 0, partial: 0, failed: 0, deferred: 0 },
        },
        nextAvailableAt: null,
      }
      const coordinatorRunner = vi.fn(async () => coordinatorResult)
      const indexingDrainRunner = vi.fn(async (coordinated) => coordinated ?? coordinatorResult)
      const trace = vi.fn()
      const cron = createCronDueWorkRunner({
        jobRepository: { materializeDailyIngestion: vi.fn(async () => ({ hasMore: false })) },
        coordinatorRunner,
        indexingDrainRunner,
        materializers: [materializer],
        trace,
        runIdFactory: () => 'cron-red-run',
        now: () => startedAt,
        materializationBudgetMs,
      })

      // Act
      const pending = cron()
      const settlement = pending.then(
        (value) => ({ ok: true, value }),
        (error) => ({ ok: false, error }),
      )
      await vi.advanceTimersByTimeAsync(materializationBudgetMs)
      const outcome = await settlement

      // Assert: resolves rather than rejects
      expect(outcome.ok).toBe(true)
      expect(materializerDeadline).toEqual(new Date(startedAt.getTime() + materializationBudgetMs))
      expect(materializerSignal?.aborted).toBe(true)
      expect(coordinatorRunner).toHaveBeenCalledTimes(1)
      expect(indexingDrainRunner).toHaveBeenCalledTimes(1)
      const events = trace.mock.calls.map(([event]) => event)
      const materializationTerminals = events.filter(
        (event) => event.stage === 'cron.materialization' && event.status !== 'started',
      )
      expect(materializationTerminals.length).toBeGreaterThan(0)
      const terminal = materializationTerminals.at(-1)
      expect(['timeout', 'deferred']).toContain(terminal.status)
      expect(terminal.counters?.deferred ?? 0).toBeGreaterThanOrEqual(1)
      if (terminal.errorCode !== undefined) {
        expect(terminal.errorCode).toBe('runtime_error')
      }
      const cronTerminals = events.filter((event) => event.stage === 'cron' && event.status !== 'started')
      expect(cronTerminals.length).toBeGreaterThan(0)
      for (const event of cronTerminals) {
        expect(event.status).not.toBe('failed')
      }
    } finally {
      vi.useRealTimers()
    }
  })

  it('fails the cron invocation and phase when materializer encounters a non-deadline error', async () => {
    const startedAt = new Date('2026-09-03T10:00:00.000Z')
    const nonDeadlineError = new Error('Database connection lost during materialization')
    const coordinatorRunner = vi.fn()
    const trace = vi.fn()
    const cron = createCronDueWorkRunner({
      jobRepository: { materializeDailyIngestion: vi.fn() },
      coordinatorRunner,
      materializers: [vi.fn().mockRejectedValue(nonDeadlineError)],
      trace,
      now: () => startedAt,
      materializationBudgetMs: 4_000,
    })

    await expect(cron()).rejects.toThrow('Database connection lost during materialization')
    expect(coordinatorRunner).not.toHaveBeenCalled()
    const events = trace.mock.calls.map(([event]) => event)
    const materializationTerminals = events.filter(
      (event) => event.stage === 'cron.materialization' && event.status === 'failed',
    )
    expect(materializationTerminals.length).toBeGreaterThan(0)
    const cronTerminals = events.filter((event) => event.stage === 'cron' && event.status === 'failed')
    expect(cronTerminals.length).toBeGreaterThan(0)
  })

  it('rejects an unexpected partial filter on the actor-idempotency unique index', async () => {
    const actorIndex = DURABLE_JOB_INDEXES.ingestionJobs.find((index) => index.name === 'ingestion_actor_idempotency_unique')
    const indexOverride = {
      ingestionJobs: DURABLE_JOB_INDEXES.ingestionJobs.map((index) => index.name === actorIndex.name
        ? { name: index.name, key: index.key, unique: true, partialFilterExpression: { actorScope: { $exists: true } } }
        : { name: index.name, key: index.key, ...(index.options ?? {}) }),
    }
    await expect(assertDurableJobsReady(readyContext({ indexOverride }))).rejects.toThrow(/indexes/i)
  })
})
