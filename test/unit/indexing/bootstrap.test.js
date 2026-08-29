import { describe, expect, it, vi } from 'vitest'
import { assertIndexingJobsReady, assertSourcePolicyReconciliationReady, checkSourcePolicyReconciliationReady, createConfiguredIndexingRuntime } from '../../../server/bootstrap/indexing.js'
import { INDEXING_ARTICLE_INDEXES, INDEXING_JOB_AUDIT_VALIDATOR, INDEXING_JOB_COLLECTIONS, INDEXING_JOB_INDEXES } from '../../../scripts/migrations/indexing-jobs.js'
import { SOURCE_POLICY_RECONCILIATION_AUDIT_VALIDATOR, SOURCE_POLICY_RECONCILIATION_INDEXES } from '../../../scripts/migrations/source-policy-reconciliation.js'
import { SOURCE_COLLECTIONS, SOURCE_INDEXES } from '../../../scripts/migrations/sources.js'
import { INDEXING_DRAIN_PERFORMANCE_INDEXES } from '../../../scripts/migrations/indexing-drain-performance.js'
import { PROVIDER_ROUTING_V2_COLLECTIONS, PROVIDER_ROUTING_V2_INDEXES } from '../../../scripts/migrations/provider-routing-v2.js'

function indexesFor(name) {
  if (name === 'adminAuditLogs') return SOURCE_POLICY_RECONCILIATION_INDEXES.map(({ options, ...index }) => ({ ...index, ...(options ?? {}) }))
  if (name === 'sources') return SOURCE_INDEXES.sources.map(({ options, ...index }) => ({ ...index, ...(options ?? {}) }))
  const base = name === 'articles' ? INDEXING_ARTICLE_INDEXES : INDEXING_JOB_INDEXES[name] ?? []
  const merged = new Map([...base, ...(INDEXING_DRAIN_PERFORMANCE_INDEXES[name] ?? []), ...(PROVIDER_ROUTING_V2_INDEXES[name] ?? [])].map((index) => [index.name, index]))
  return [...merged.values()].map((index) => index.name === 'articles_search_text'
    ? { name: index.name, key: { _fts: 'text', _ftsx: 1 }, weights: Object.fromEntries(Object.keys(index.key).map((field) => [field, 1])), ...(index.options ?? {}) }
    : { name: index.name, key: index.key, ...(index.options ?? {}) })
}

function readyContext({ auditValidator = SOURCE_POLICY_RECONCILIATION_AUDIT_VALIDATOR, indexOverride } = {}) {
  const definitions = new Map(Object.entries(INDEXING_JOB_COLLECTIONS))
  for (const entry of Object.entries(PROVIDER_ROUTING_V2_COLLECTIONS)) definitions.set(entry[0], entry[1])
  definitions.set('sources', SOURCE_COLLECTIONS.sources)
  const collections = [...definitions].map(([name, definition]) => ({ name, options: { validator: definition.validator, validationLevel: 'strict', validationAction: 'error' } }))
  collections.push({ name: 'adminAuditLogs', options: { validator: auditValidator, validationLevel: 'strict', validationAction: 'error' } })
  return {
    client: {},
    db: {
      listCollections: () => ({ toArray: async () => collections }),
      collection: (name) => ({ indexes: async () => indexOverride?.[name] ?? indexesFor(name) }),
    },
  }
}

function providerGraph() {
  const evidenceExpiresAt = '2026-09-01T00:00:00.000Z'
  return {
    domains: [
      { admissionDomainId: 'summary-admission', providerId: 'summary-provider', credentialEnvName: 'SUMMARY_KEY_ENV', maxConcurrency: 1, budgetLimit: 10, budgetWindow: 'day' },
      { admissionDomainId: 'embedding-admission', providerId: 'embedding-provider', credentialEnvName: 'EMBEDDING_KEY_ENV', maxConcurrency: 1, budgetLimit: 10, budgetWindow: 'day' },
    ],
    providerFailureDomains: [],
    routes: [
      { routeId: 'summary-primary', admissionDomainId: 'summary-admission', providerId: 'summary-provider', model: 'summary-model-v1', operations: ['summary'], capability: 'nonconfidential', enabled: true, evidenceExpiresAt },
      { routeId: 'embedding-primary', admissionDomainId: 'embedding-admission', providerId: 'embedding-provider', model: 'embedding-model-v1', operations: ['embedding'], capability: 'nonconfidential', artifactCompatibilityId: 'embedding-compat-v1', embeddingDimensions: 3, embeddingVersion: 7, enabled: true, evidenceExpiresAt },
    ],
    workloadPolicies: [
      { workloadId: 'summary', operation: 'summary', requiredCapability: 'nonconfidential', maxExternalAttempts: 2, primaryRouteId: 'summary-primary', modelFallbackRouteIds: [], providerFallbackRouteIds: [] },
      { workloadId: 'embedding', operation: 'embedding', requiredCapability: 'nonconfidential', maxExternalAttempts: 1, primaryRouteId: 'embedding-primary', modelFallbackRouteIds: [], providerFallbackRouteIds: [] },
    ],
  }
}

describe('Step 9 indexing bootstrap readiness', () => {
  it('fails closed unless exact validators, audit revision and indexes are deployed', async () => {
    await expect(assertIndexingJobsReady(readyContext())).resolves.toBeUndefined()
    await expect(assertIndexingJobsReady(readyContext({ auditValidator: {} }))).rejects.toThrow(/audit/i)
    await expect(assertIndexingJobsReady(readyContext({ indexOverride: { indexingJobs: [] } }))).rejects.toThrow(/indexes/i)
    await expect(assertIndexingJobsReady(readyContext({ indexOverride: { articles: [] } }))).rejects.toThrow(/article reconciliation index/i)
  })
  it('requires the reconciliation audit validator and idempotency index', async () => {
    await expect(assertSourcePolicyReconciliationReady(readyContext())).resolves.toBeUndefined()
    await expect(assertSourcePolicyReconciliationReady(readyContext({ auditValidator: INDEXING_JOB_AUDIT_VALIDATOR }))).rejects.toThrow(/audit validator/i)
    const ready = readyContext()
    await expect(assertSourcePolicyReconciliationReady({ ...ready, db: { ...ready.db, collection: (name) => ({ indexes: async () => name === 'adminAuditLogs' ? [] : indexesFor(name) }) } })).rejects.toThrow(/indexes/i)
  })
  it('reports reconciliation migration absence without blocking core indexing', async () => {
    await expect(checkSourcePolicyReconciliationReady(readyContext({ auditValidator: INDEXING_JOB_AUDIT_VALIDATOR }))).resolves.toBe(false)
    await expect(checkSourcePolicyReconciliationReady(readyContext())).resolves.toBe(true)
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
      providerRegistry: providerGraph(),
    })
    expect(registered.map(({ queueName }) => queueName)).toEqual(['indexing'])
    expect(maintenance.map(([name]) => name)).toEqual(['purge-indexing-jobs'])
    expect(jobRuntime.cronMaterializers).toHaveLength(1)
    expect(runtime.indexingJobService).toEqual(expect.objectContaining({ createSummaryJob: expect.any(Function), createIndexingJob: expect.any(Function) }))
    expect(runtime.sourcePolicyReconciliationService).toEqual(expect.objectContaining({ preview: expect.any(Function), execute: expect.any(Function) }))
    expect(runtime.queryEmbedding.capability).toBe('nonconfidential')
    expect(Object.isFrozen(runtime.queryEmbedding)).toBe(true)
  })
  it('keeps core indexing available when reconciliation migration is absent', async () => {
    const jobRuntime = { queueRegistry: { register: vi.fn() }, maintenanceRegistry: { register: vi.fn() }, coordinatorRunner: vi.fn(), leaseRepository: {}, cronMaterializers: [] }
    const runtime = await createConfiguredIndexingRuntime({
      context: readyContext(), jobRuntime, rateLimitAdmission: { reserve: vi.fn(async () => ({ allowed: true })) },
      providerRegistry: providerGraph(), verifyReconciliationSchema: vi.fn(async () => false),
    })
    expect(runtime.indexingJobService).toEqual(expect.objectContaining({ createSummaryJob: expect.any(Function), createIndexingJob: expect.any(Function) }))
    expect(runtime.sourcePolicyReconciliationService).toBeUndefined()
  })

  it('fails startup when the configured embedding workload is absent', async () => {
    const jobRuntime = { queueRegistry: { register: vi.fn() }, maintenanceRegistry: { register: vi.fn() }, coordinatorRunner: vi.fn(), leaseRepository: {}, cronMaterializers: [] }
    await expect(createConfiguredIndexingRuntime({ context: readyContext(), jobRuntime, rateLimitAdmission: { reserve: vi.fn() }, providerRegistry: { domains: [], routes: [], workloadPolicies: [] } })).rejects.toThrow(/workload embedding/)
  })

  it('fails closed when task-aware drain indexes are missing', async () => {
    const drainNames = new Set(INDEXING_DRAIN_PERFORMANCE_INDEXES.indexingJobs.map(({ name }) => name))
    const indexOverride = {
      indexingJobs: indexesFor('indexingJobs').filter(({ name }) => !drainNames.has(name)),
    }
    await expect(assertIndexingJobsReady(readyContext({ indexOverride }))).rejects.toThrow(/indexes/i)
  })
})
