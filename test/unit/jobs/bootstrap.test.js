import { describe, expect, it, vi } from 'vitest'
import { assertDurableJobsReady, createConfiguredJobRuntime, createConfiguredJobService, createCronDueWorkRunner } from '../../../server/bootstrap/jobs.js'
import { DURABLE_JOB_AUDIT_VALIDATOR, DURABLE_JOB_COLLECTIONS, DURABLE_JOB_INDEXES } from '../../../scripts/migrations/durable-jobs.js'

function readyContext({ auditValidator = DURABLE_JOB_AUDIT_VALIDATOR, indexOverride } = {}) {
  const collections = Object.entries(DURABLE_JOB_COLLECTIONS).map(([name, definition]) => ({
    name,
    options: { validator: definition.validator, validationLevel: 'strict', validationAction: 'error' },
  }))
  collections.push({ name: 'adminAuditLogs', options: { validator: auditValidator, validationLevel: 'strict', validationAction: 'error' } })
  return {
    client: {},
    db: {
      listCollections: () => ({ toArray: async () => collections }),
      collection: (name) => ({
        indexes: async () => indexOverride?.[name] ?? DURABLE_JOB_INDEXES[name]?.map((index) => ({ name: index.name, key: index.key, ...(index.options ?? {}) })) ?? [],
      }),
    },
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
    const runtime = await createConfiguredJobRuntime({ context, rateLimitAdmission })
    expect(runtime.queueRegistry.registered().map(({ queueName }) => queueName)).toEqual(['ingestion'])
    expect(runtime.maintenanceRegistry.has('purge-ingestion-jobs')).toBe(true)
    expect(runtime.maintenanceRegistry.has('purge-indexing-jobs')).toBe(false)
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
