import { describe, expect, it, vi } from 'vitest'
import { assertCronObservabilityReady, assertDurableJobsReady, createConfiguredJobRuntime, createConfiguredJobService, createCronDueWorkRunner, createProfiledIndexingDrainRunner, DAILY_MATERIALIZATION_BUDGET_MS } from '../../../server/bootstrap/jobs.js'
import { createReconciliationRunner } from '../../../server/application/indexing/reconciliation.js'
import { DURABLE_JOB_AUDIT_VALIDATOR, DURABLE_JOB_COLLECTIONS, DURABLE_JOB_INDEXES } from '../../../scripts/migrations/durable-jobs.js'
import { CRON_OBSERVABILITY_COLLECTIONS, CRON_OBSERVABILITY_INDEXES } from '../../../scripts/migrations/cron-observability.js'
import { PASSWORD_CHANGE_AUDIT_VALIDATOR } from '../../../scripts/migrations/password-change.js'
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
  it('accepts the final password-change audit validator', async () => {
    await expect(assertDurableJobsReady(readyContext({ auditValidator: PASSWORD_CHANGE_AUDIT_VALIDATOR }))).resolves.toBeUndefined()
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
    expect(runtime.cronMaterializers.map(({ name }) => name)).toEqual(['cron-lifecycle-retention', 'takedown-cleanup'])
    const result = await runtime.cronMaterializers[0].run({ deadline: new Date(cutoff.getTime() + 60_000) })

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
  it('uses the bounded ten-second daily materialization default', async () => {
    const startedAt = new Date('2026-09-03T10:00:00.000Z')
    let dailyDeadline
    const cron = createCronDueWorkRunner({
      jobRepository: {
        materializeDailyIngestion: vi.fn(async ({ deadline }) => {
          dailyDeadline = deadline
          return { hasMore: false }
        }),
      },
      coordinatorRunner: async () => ({ startedAt, finishedAt: startedAt }),
      now: () => startedAt,
    })

    await cron()

    expect(DAILY_MATERIALIZATION_BUDGET_MS).toBe(10_000)
    expect(dailyDeadline).toEqual(new Date(startedAt.getTime() + DAILY_MATERIALIZATION_BUDGET_MS))
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

  it('requires named materializer descriptors for optional cron phases', () => {
    expect(() => createCronDueWorkRunner({
      jobRepository: { materializeDailyIngestion: vi.fn() },
      coordinatorRunner: vi.fn(),
      materializers: [{ run: vi.fn() }],
    })).toThrow(/materializer/i)
  })

  it('forwards invocation controls through daily-first named materializers and drains', async () => {
    const startedAt = new Date('2026-09-03T10:00:00.000Z')
    const invocationDeadline = new Date(startedAt.getTime() + 30_000)
    const settlementDeadline = new Date(startedAt.getTime() + 31_000)
    const controller = new AbortController()
    const calls = []
    const coordinatorResult = { runId: 'cron-controls', startedAt, finishedAt: startedAt, queues: { indexing: { claimed: 0 } } }
    const materializer = vi.fn(async (options) => { calls.push({ name: 'takedown', options }); return { hasMore: false } })
    const daily = vi.fn(async (options) => { calls.push({ name: 'ingestion', options }); return { hasMore: false } })
    const coordinatorRunner = vi.fn(async (options) => { calls.push({ name: 'coordinate', options }); return coordinatorResult })
    const indexingDrainRunner = vi.fn(async (result, options) => { calls.push({ name: 'indexing', options }); return result })
    const cron = createCronDueWorkRunner({
      jobRepository: { materializeDailyIngestion: daily },
      coordinatorRunner,
      indexingDrainRunner,
      materializers: [{ name: 'takedown', run: materializer }],
      now: () => startedAt,
      materializationBudgetMs: 4_000,
    })

    await cron({ signal: controller.signal, deadline: invocationDeadline, settlementDeadline })

    expect(calls.map(({ name }) => name)).toEqual(['ingestion', 'takedown', 'coordinate', 'indexing'])
    expect(daily).toHaveBeenCalledWith(expect.objectContaining({ signal: expect.any(AbortSignal), deadline: new Date(startedAt.getTime() + 4_000), settlementDeadline }))
    expect(materializer).toHaveBeenCalledWith(expect.objectContaining({ signal: expect.any(AbortSignal), deadline: new Date(startedAt.getTime() + 4_000), settlementDeadline }))
    expect(coordinatorRunner).toHaveBeenCalledWith(expect.objectContaining({ signal: expect.any(AbortSignal), deadline: invocationDeadline }))
    expect(indexingDrainRunner).toHaveBeenCalledWith(coordinatorResult, expect.objectContaining({ signal: expect.any(AbortSignal), deadline: invocationDeadline, settlementDeadline }))
  })
  it('reads named materializers registered after runner construction', async () => {
    const materializers = []
    const calls = []
    const startedAt = new Date('2026-09-03T10:00:00.000Z')
    const cron = createCronDueWorkRunner({
      jobRepository: { materializeDailyIngestion: async () => ({ hasMore: false }) },
      coordinatorRunner: async () => ({ startedAt, finishedAt: startedAt }),
      materializers,
      now: () => startedAt,
    })
    materializers.push({ name: 'source-policy-reconciliation', run: async () => { calls.push('source-policy-reconciliation') } })

    await cron()

    expect(calls).toEqual(['source-policy-reconciliation'])
  })
  it('fails closed when a complete-materialization descriptor reports deferred work', async () => {
    const coordinatorRunner = vi.fn()
    const cron = createCronDueWorkRunner({
      jobRepository: { materializeDailyIngestion: async () => ({ hasMore: false }) },
      coordinatorRunner,
      materializers: [{ name: 'source-policy-reconciliation', requiresCompleteMaterialization: true, run: async () => ({ hasMore: true }) }],
      now: () => new Date('2026-09-03T10:00:00.000Z'),
    })

    await expect(cron()).resolves.toEqual(expect.objectContaining({ nextAvailableAt: null }))
    expect(coordinatorRunner).not.toHaveBeenCalled()
  })
  it('stops downstream phases for a real reconciliation control result', async () => {
    const startedAt = new Date('2026-09-03T10:00:00.000Z')
    const sourceId = '507f1f77bcf86cd799439021'
    const fence = { key: `reconciliation:source:${sourceId}`, jobId: sourceId, ownerTokenHash: 'a'.repeat(64), leaseGeneration: 1 }
    const reconciliationRunner = createReconciliationRunner({
      repository: {
        selectPendingReconciliationSource: async () => ({ id: sourceId }),
        materializeReconciliationPage: async () => { throw Object.assign(new Error('deadline'), { code: 'runtime_deadline_exceeded' }) },
      },
      leaseRepository: {
        clearExpiredReconciliation: async () => true,
        acquire: async () => fence,
        release: async () => true,
      },
      ownerToken: () => 'source-owner-token',
      now: () => startedAt,
    })
    const coordinatorRunner = vi.fn()
    const cron = createCronDueWorkRunner({
      jobRepository: { materializeDailyIngestion: async () => ({ hasMore: false }) },
      coordinatorRunner,
      materializers: [{ name: 'source-policy-reconciliation', requiresCompleteMaterialization: true, run: (options) => reconciliationRunner.runDueSources(options) }],
      now: () => startedAt,
    })

    await expect(cron()).resolves.toEqual(expect.objectContaining({ nextAvailableAt: null }))
    expect(coordinatorRunner).not.toHaveBeenCalled()
  })
  it('continues after ordinary named materializer hasMore results', async () => {
    const coordinatorRunner = vi.fn(async () => ({ startedAt: new Date(), finishedAt: new Date() }))
    const cron = createCronDueWorkRunner({
      jobRepository: { materializeDailyIngestion: async () => ({ hasMore: false }) },
      coordinatorRunner,
      materializers: [{ name: 'optional-maintenance', run: async () => ({ hasMore: true }) }],
      now: () => new Date('2026-09-03T10:00:00.000Z'),
    })

    await cron()

    expect(coordinatorRunner).toHaveBeenCalledOnce()
  })

  it('defers without failure when the parent aborts with a custom reason', async () => {
    const controller = new AbortController()
    controller.abort(new Error('caller canceled'))
    const coordinatorRunner = vi.fn()
    const cron = createCronDueWorkRunner({
      jobRepository: { materializeDailyIngestion: vi.fn() },
      coordinatorRunner,
      now: () => new Date('2026-09-03T10:00:00.000Z'),
    })

    await expect(cron({ signal: controller.signal })).resolves.toEqual(expect.objectContaining({ nextAvailableAt: null }))
    expect(coordinatorRunner).not.toHaveBeenCalled()
  })

  it('defers known runtime deadline failures before coordination', async () => {
    const coordinatorRunner = vi.fn()
    const cron = createCronDueWorkRunner({
      jobRepository: { materializeDailyIngestion: vi.fn(async () => { throw Object.assign(new Error('deadline'), { code: 'runtime_deadline_exceeded' }) }) },
      coordinatorRunner,
      now: () => new Date('2026-09-03T10:00:00.000Z'),
    })

    await expect(cron()).resolves.toEqual(expect.objectContaining({ nextAvailableAt: null }))
    expect(coordinatorRunner).not.toHaveBeenCalled()
  })

  it('defers coordinator cancellation without marking the cron phase failed', async () => {
    const controller = new AbortController()
    const startedAt = new Date('2026-09-03T10:00:00.000Z')
    const coordinatorRunner = vi.fn(async ({ signal }) => {
      controller.abort(new Error('caller canceled during coordination'))
      signal.throwIfAborted()
    })
    const cron = createCronDueWorkRunner({
      jobRepository: { materializeDailyIngestion: async () => ({ hasMore: false }) },
      coordinatorRunner,
      now: () => startedAt,
    })

    await expect(cron({ signal: controller.signal })).resolves.toEqual(expect.objectContaining({ nextAvailableAt: null }))
    expect(coordinatorRunner).toHaveBeenCalledOnce()
  })

  it('defers indexing runtime deadline control without coordinating failure', async () => {
    const startedAt = new Date('2026-09-03T10:00:00.000Z')
    const coordinatorResult = { startedAt, finishedAt: startedAt, queues: { indexing: { claimed: 0 } } }
    const indexingDrainRunner = vi.fn(async () => { throw Object.assign(new Error('deadline'), { code: 'runtime_deadline_exceeded' }) })
    const cron = createCronDueWorkRunner({
      jobRepository: { materializeDailyIngestion: async () => ({ hasMore: false }) },
      coordinatorRunner: async () => coordinatorResult,
      indexingDrainRunner,
      now: () => startedAt,
    })

    await expect(cron()).resolves.toEqual(expect.objectContaining({ nextAvailableAt: null }))
    expect(indexingDrainRunner).toHaveBeenCalledOnce()
  })
  it('classifies profiled indexing runtime control as deferred', async () => {
    const startedAt = new Date('2026-09-03T10:00:00.000Z')
    const trace = vi.fn()
    const queue = {
      selectDue: vi.fn(async () => { throw Object.assign(new Error('deadline'), { code: 'runtime_deadline_exceeded' }) }),
      claimAndExecute: vi.fn(),
      nextAvailableAt: vi.fn(async () => null),
    }
    const runner = createProfiledIndexingDrainRunner({
      queueRegistry: { get: () => queue, registered: () => [queue] },
      profile: { maxJobs: 3, budgetMs: 60_000 },
      now: () => startedAt,
      trace,
    })
    const empty = { claimed: 0, succeeded: 0, partial: 0, failed: 0, deferred: 0 }
    const baseResult = {
      runId: 'base-run', startedAt, finishedAt: startedAt,
      recovery: { inspected: 0, recovered: 0, retriesCreated: 0, failed: 0 },
      queues: { accountDeletion: { ...empty }, ingestion: { ...empty }, indexing: { ...empty } },
      nextAvailableAt: null,
    }

    await expect(runner(baseResult, { runId: 'base-run' })).rejects.toMatchObject({ code: 'runtime_deadline_exceeded' })
    expect(trace.mock.calls.some(([event]) => event.stage === 'indexing.drain' && event.status === 'failed')).toBe(false)
  })

  it('gives current-day ingestion its first bounded turn before optional materializers', async () => {
    const calls = []
    const startedAt = new Date('2026-09-03T10:00:00.000Z')
    const cron = createCronDueWorkRunner({
      jobRepository: { materializeDailyIngestion: async () => { calls.push('ingestion'); return { hasMore: false } } },
      coordinatorRunner: async () => { calls.push('coordinate'); return { startedAt, finishedAt: startedAt } },
      materializers: [async () => { calls.push('takedown') }],
      now: () => startedAt,
      materializationBudgetMs: 4_000,
    })

    await cron()

    expect(calls).toEqual(['ingestion', 'takedown', 'coordinate'])
  })
  it('waits for a timed-out materializer to settle before coordinating', async () => {
    vi.useFakeTimers()
    try {
      const startedAt = new Date('2026-09-03T10:00:00.000Z')
      const materializationBudgetMs = 10
      let materializerSignal
      let materializerDeadline
      const materializer = vi.fn(({ signal, deadline }) => {
        materializerSignal = signal
        materializerDeadline = deadline
        return new Promise((resolve) => {
          signal.addEventListener('abort', () => {
            globalThis.setTimeout(() => resolve({ hasMore: false }), 1)
          }, { once: true })
        })
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

      const pending = cron()
      const settlement = pending.then(
        (value) => ({ ok: true, value }),
        (error) => ({ ok: false, error }),
      )
      await vi.advanceTimersByTimeAsync(materializationBudgetMs)

      expect(materializerDeadline).toEqual(new Date(startedAt.getTime() + materializationBudgetMs))
      expect(materializerSignal?.aborted).toBe(true)
      expect(coordinatorRunner).not.toHaveBeenCalled()
      expect(indexingDrainRunner).not.toHaveBeenCalled()

      await vi.advanceTimersByTimeAsync(1)
      const outcome = await settlement
      expect(outcome.ok).toBe(true)
      expect(coordinatorRunner).not.toHaveBeenCalled()
      expect(indexingDrainRunner).not.toHaveBeenCalled()
      const events = trace.mock.calls.map(([event]) => event)
      const materializationTerminals = events.filter(
        (event) => event.stage === 'cron.materialization' && event.status !== 'started',
      )
      expect(materializationTerminals.length).toBeGreaterThan(0)
      const terminal = materializationTerminals.at(-1)
      expect(['timeout', 'deferred']).toContain(terminal.status)
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
