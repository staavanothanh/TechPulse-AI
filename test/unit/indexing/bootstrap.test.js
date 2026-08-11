import { describe, expect, it, vi } from 'vitest'
import { assertIndexingJobsReady, createConfiguredIndexingRuntime } from '../../../server/bootstrap/indexing.js'
import { INDEXING_ARTICLE_INDEXES, INDEXING_JOB_AUDIT_VALIDATOR, INDEXING_JOB_COLLECTIONS, INDEXING_JOB_INDEXES } from '../../../scripts/migrations/indexing-jobs.js'

function readyContext({ auditValidator = INDEXING_JOB_AUDIT_VALIDATOR, indexOverride } = {}) {
  const collections = Object.entries(INDEXING_JOB_COLLECTIONS).map(([name, definition]) => ({ name, options: { validator: definition.validator, validationLevel: 'strict', validationAction: 'error' } }))
  collections.push({ name: 'adminAuditLogs', options: { validator: auditValidator, validationLevel: 'strict', validationAction: 'error' } })
  return {
    client: {},
    db: {
      listCollections: () => ({ toArray: async () => collections }),
      collection: (name) => ({ indexes: async () => indexOverride?.[name] ?? (name === 'articles' ? INDEXING_ARTICLE_INDEXES : INDEXING_JOB_INDEXES[name])?.map((index) => ({ name: index.name, key: index.key, ...(index.options ?? {}) })) ?? [] }),
    },
  }
}

describe('Step 9 indexing bootstrap readiness', () => {
  it('fails closed unless exact validators, audit revision and indexes are deployed', async () => {
    await expect(assertIndexingJobsReady(readyContext())).resolves.toBeUndefined()
    await expect(assertIndexingJobsReady(readyContext({ auditValidator: {} }))).rejects.toThrow(/audit/i)
    await expect(assertIndexingJobsReady(readyContext({ indexOverride: { indexingJobs: [] } }))).rejects.toThrow(/indexes/i)
    await expect(assertIndexingJobsReady(readyContext({ indexOverride: { articles: [] } }))).rejects.toThrow(/article reconciliation index/i)
  })

  it('registers indexing queue and cleanup into the shared Step 4 runtime', async () => {
    const registered = []
    const maintenance = []
    const jobRuntime = {
      queueRegistry: { register: vi.fn((adapter) => { registered.push(adapter); return adapter }) },
      maintenanceRegistry: { register: vi.fn((name, handler) => { maintenance.push([name, handler]); return handler }) },
      coordinatorRunner: vi.fn(async () => undefined),
      leaseRepository: {},
      cronMaterializers: [],
    }
    const runtime = await createConfiguredIndexingRuntime({
      context: readyContext(), jobRuntime, rateLimitAdmission: { reserve: vi.fn(async () => ({ allowed: true })) },
      providerRegistry: { domains: [{ admissionDomainId: 'zen', provider: 'opencode-zen', credentialEnvName: 'ZEN_KEY', maxConcurrency: 1, budgetLimit: 10, budgetWindow: 'day' }, { admissionDomainId: 'router', provider: 'openrouter', credentialEnvName: 'ROUTER_KEY', maxConcurrency: 1, budgetLimit: 10, budgetWindow: 'day' }], routes: [
        { routeId: 'zen-primary', admissionDomainId: 'zen', provider: 'opencode-zen', model: 'deepseek-v4-flash-free', capability: 'nonconfidential', enabled: true },
        { routeId: 'embedding-bge-m3', admissionDomainId: 'router', provider: 'openrouter', model: 'baai/bge-m3', capability: 'nonconfidential', enabled: true },
      ] },
    })
    expect(registered.map(({ queueName }) => queueName)).toEqual(['indexing'])
    expect(maintenance.map(([name]) => name)).toEqual(['purge-indexing-jobs'])
    expect(jobRuntime.cronMaterializers).toHaveLength(1)
    expect(runtime.indexingJobService).toEqual(expect.objectContaining({ createSummaryJob: expect.any(Function), createIndexingJob: expect.any(Function) }))
  })

  it('fails startup when the approved OpenCode Zen primary is absent', async () => {
    const jobRuntime = { queueRegistry: { register: vi.fn() }, maintenanceRegistry: { register: vi.fn() }, coordinatorRunner: vi.fn(), leaseRepository: {}, cronMaterializers: [] }
    await expect(createConfiguredIndexingRuntime({ context: readyContext(), jobRuntime, rateLimitAdmission: { reserve: vi.fn() }, providerRegistry: { domains: [], routes: [] } })).rejects.toThrow(/OpenCode Zen primary/)
  })
})
