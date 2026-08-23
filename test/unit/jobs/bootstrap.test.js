import { describe, expect, it, vi } from 'vitest'
import { assertDurableJobsReady, createConfiguredJobRuntime, createConfiguredJobService, createCronDueWorkRunner } from '../../../server/bootstrap/jobs.js'
import { DURABLE_JOB_AUDIT_VALIDATOR, DURABLE_JOB_COLLECTIONS, DURABLE_JOB_INDEXES } from '../../../scripts/migrations/durable-jobs.js'
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
    const runtime = await createConfiguredJobRuntime({ context: governanceContext, rateLimitAdmission, quotaKeyring, governanceKeyring, governanceDb: governanceContext.governanceDb, maintenanceContext })
    expect(runtime.queueRegistry.registered().map(({ queueName }) => queueName)).toEqual(['account-deletion', 'ingestion'])
    expect(runtime.maintenanceRegistry.has('purge-ingestion-jobs')).toBe(true)
    expect(runtime.maintenanceRegistry.has('purge-indexing-jobs')).toBe(false)
    expect(runtime.maintenanceRegistry.has('purge-takedown-pii')).toBe(true)
    expect(runtime.maintenanceRegistry.has('purge-takedown-workflows')).toBe(true)
    expect(runtime.maintenanceRegistry.has('purge-account-deletion-workflows')).toBe(true)
    expect(runtime.maintenanceRegistry.has('purge-audit-ip-hmac')).toBe(true)
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

  it('gives each fixed materializer one bounded turn before ingestion can exhaust the budget', async () => {
    const calls = []
    let tick = 0
    const cron = createCronDueWorkRunner({
      jobRepository: { materializeDailyIngestion: async () => { calls.push('ingestion'); return { hasMore: true } } },
      coordinatorRunner: async () => { calls.push('coordinate') },
      materializers: [async () => { calls.push('takedown') }],
      now: () => new Date(Date.UTC(2026, 7, 10, 0, 0, tick++ === 0 ? 0 : 5)),
      maxMaterializationPages: 10,
      materializationBudgetMs: 4_000,
    })
    await cron()
    expect(calls[0]).toBe('takedown')
    expect(calls).toContain('coordinate')
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
