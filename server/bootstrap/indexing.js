import { createProviderAdmission } from '../ai/provider-admission.js'
import { createProviderRouter } from '../ai/provider-router.js'
import { ObjectId } from 'mongodb'
import { validateEmbeddingVector } from '../ai/embedding.js'
import { ProviderAdapterError } from '../ai/provider-error-taxonomy.js'
import { sanitizeText } from '../domain/article/normalization.js'
import { createArtifactProcessor } from '../application/indexing/artifact-processor.js'
import { createIndexingJobService } from '../application/indexing/service.js'
import { createReconciliationRunner } from '../application/indexing/reconciliation.js'
import { createSourcePolicyReconciliationService } from '../application/indexing/source-policy-reconciliation-service.js'
import { createSourcePolicyReconciliationWorker } from '../application/indexing/source-policy-reconciliation.js'
import { createIndexingQueueAdapter } from '../jobs/indexing-queue.js'
import { MongoArticleRepository } from '../repositories/mongo/article-repository.js'
import { MongoIndexingJobRepository } from '../repositories/mongo/indexing-job-repository.js'
import { MongoProviderAdmissionRepository } from '../repositories/mongo/provider-admission-repository.js'
import { MongoProviderFailureDomainRepository } from '../repositories/mongo/provider-failure-domain-repository.js'
import { MongoSourceRepository } from '../repositories/mongo/source-repository.js'
import { exactMongoIndex } from '../repositories/mongo/index-contract.js'
import { INDEXING_ARTICLE_INDEXES, INDEXING_JOB_AUDIT_VALIDATOR, INDEXING_JOB_COLLECTIONS, INDEXING_JOB_INDEXES } from '../../scripts/migrations/indexing-jobs.js'
import { INDEXING_DRAIN_PERFORMANCE_INDEXES } from '../../scripts/migrations/indexing-drain-performance.js'
import { GOVERNANCE_AUDIT_VALIDATOR } from '../../scripts/migrations/governance-audit.js'
import { GOOGLE_OAUTH_AUDIT_VALIDATOR } from '../../scripts/migrations/google-oauth.js'
import { PROVIDER_ADMISSION_STATE_VALIDATOR_V2, PROVIDER_ROUTING_INDEXING_JOB_VALIDATOR } from '../../scripts/migrations/provider-routing-v2.js'
import { SOURCE_POLICY_RECONCILIATION_AUDIT_VALIDATOR, SOURCE_POLICY_RECONCILIATION_INDEXES } from '../../scripts/migrations/source-policy-reconciliation.js'
import { assertProviderRoutingReady } from './provider-routing.js'
import { assertSourcesReady } from './sources.js'
import { TOPIC_TAXONOMY_ARTICLE_INDEXES, TOPIC_TAXONOMY_ARTICLE_VALIDATOR } from '../../scripts/migrations/topic-taxonomy-v1.js'
function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`
  return JSON.stringify(value)
}

export async function assertIndexingJobsReady(context) {
  if (!context?.db) throw new Error('Mongo context is required')
  const collections = await context.db.listCollections({}, { nameOnly: false }).toArray()
  const collectionMap = new Map(collections.map((collection) => [collection.name, collection]))
  for (const [name, definition] of Object.entries(INDEXING_JOB_COLLECTIONS)) {
    const collection = collectionMap.get(name)
    const acceptedValidators = name === 'providerAdmissionStates' ? [definition.validator, PROVIDER_ADMISSION_STATE_VALIDATOR_V2] : name === 'indexingJobs' ? [definition.validator, PROVIDER_ROUTING_INDEXING_JOB_VALIDATOR] : [definition.validator]
    if (!collection || collection.options?.validationLevel !== 'strict' || collection.options?.validationAction !== 'error' || !acceptedValidators.some((validator) => stableJson(collection.options?.validator) === stableJson(validator))) throw new Error('indexing-jobs validator is not ready')
    const actualByName = new Map((await context.db.collection(name).indexes()).map((index) => [index.name, index]))
    const expectedIndexes = [...INDEXING_JOB_INDEXES[name], ...(INDEXING_DRAIN_PERFORMANCE_INDEXES[name] ?? [])]
    if (expectedIndexes.some((expected) => !exactMongoIndex(actualByName.get(expected.name), expected))) throw new Error('indexing-jobs indexes are not ready')
  }
  const audit = collectionMap.get('adminAuditLogs')
  if (!audit || audit.options?.validationLevel !== 'strict' || audit.options?.validationAction !== 'error' || ![INDEXING_JOB_AUDIT_VALIDATOR, GOVERNANCE_AUDIT_VALIDATOR, GOOGLE_OAUTH_AUDIT_VALIDATOR, SOURCE_POLICY_RECONCILIATION_AUDIT_VALIDATOR].some((validator) => stableJson(audit.options?.validator) === stableJson(validator))) throw new Error('indexing-jobs audit validator is not ready')
  const articleCollection = collectionMap.get('articles')
  const articleIndexes = new Map((await context.db.collection('articles').indexes()).map((index) => [index.name, index]))
  const expectedArticleIndexes = [
    ...INDEXING_ARTICLE_INDEXES,
    ...(stableJson(articleCollection?.options?.validator) === stableJson(TOPIC_TAXONOMY_ARTICLE_VALIDATOR) ? TOPIC_TAXONOMY_ARTICLE_INDEXES : []),
  ]
  if (expectedArticleIndexes.some((expected) => !exactMongoIndex(articleIndexes.get(expected.name), expected))) throw new Error('article reconciliation index is not ready')
}
export async function assertSourcePolicyReconciliationReady(context) {
  if (!context?.db) throw new Error('Mongo context is required')
  const collections = await context.db.listCollections({}, { nameOnly: false }).toArray()
  const audit = collections.find((collection) => collection.name === 'adminAuditLogs')
  if (!audit || audit.options?.validationLevel !== 'strict' || audit.options?.validationAction !== 'error' || stableJson(audit.options?.validator) !== stableJson(SOURCE_POLICY_RECONCILIATION_AUDIT_VALIDATOR)) throw new Error('source-policy-reconciliation audit validator is not ready')
  const indexes = new Map((await context.db.collection('adminAuditLogs').indexes()).map((index) => [index.name, index]))
  if (SOURCE_POLICY_RECONCILIATION_INDEXES.some((expected) => !exactMongoIndex(indexes.get(expected.name), expected))) throw new Error('source-policy-reconciliation indexes are not ready')
}

function workloadPolicy(registry, workloadId) {
  const policy = (registry?.workloadPolicies ?? []).find((item) => item.workloadId === workloadId)
  if (!policy) throw new Error(`Provider workload ${workloadId} is not configured`)
  return policy
}

export function configuredEmbeddingTarget(registry) {
  const policy = workloadPolicy(registry, 'embedding')
  const route = (registry?.routes ?? []).find((item) => item.routeId === policy.primaryRouteId)
  if (!route || typeof route.model !== 'string' || !route.artifactCompatibilityId || !Number.isInteger(route.embeddingDimensions) || route.embeddingDimensions < 1 || !Number.isInteger(route.embeddingVersion) || route.embeddingVersion < 1) throw new Error('Embedding workload route is not configured')
  return Object.freeze({ model: route.model, dimensions: route.embeddingDimensions, version: route.embeddingVersion, artifactCompatibilityId: route.artifactCompatibilityId })
}

function configuredEmbeddingRoute(registry) {
  const policy = workloadPolicy(registry, 'embedding')
  const route = (registry?.routes ?? []).find((item) => item.routeId === policy.primaryRouteId)
  if (!route) throw new Error('Embedding workload route is not configured')
  return route
}

export async function createConfiguredIndexingRuntime({
  context, jobRuntime, rateLimitAdmission, providerRegistry = { admissionDomains: [], providerFailureDomains: [], routes: [], workloadPolicies: [] }, llmProvider, embeddingProvider, now = () => new Date(), verifySchema = assertIndexingJobsReady, verifyProviderSchema = assertProviderRoutingReady, verifyReconciliationSchema = assertSourcePolicyReconciliationReady,
} = {}) {
  if (!jobRuntime?.queueRegistry || !jobRuntime?.maintenanceRegistry || !jobRuntime?.leaseRepository || typeof jobRuntime.coordinatorRunner !== 'function') throw new Error('Shared durable job runtime is required')
  if (typeof rateLimitAdmission?.reserve !== 'function') throw new Error('Rate-limit admission is required')
  await verifySchema(context)
  await verifyProviderSchema(context)
  await assertSourcesReady(context)
  await verifyReconciliationSchema(context)
  const embeddingTarget = configuredEmbeddingTarget(providerRegistry)
  const indexingJobRepository = new MongoIndexingJobRepository(context, { embeddingTarget })
  const articleRepository = new MongoArticleRepository(context, { embeddingTarget })
  const sourceRepository = new MongoSourceRepository(context)
  const providerAdmissionRepository = new MongoProviderAdmissionRepository(context)
  const providerFailureDomainRepository = new MongoProviderFailureDomainRepository(context)
  const providerAdmission = createProviderAdmission({ repository: providerAdmissionRepository, failureDomainRepository: providerFailureDomainRepository, registry: providerRegistry, now })
  const providerRouter = createProviderRouter({ workloadPolicies: providerRegistry.workloadPolicies ?? [], admission: providerAdmission, now })
  const artifactProcessor = createArtifactProcessor({ articleRepository, sourceRepository, indexingJobRepository, providerRouter, llmProvider, embeddingProvider, embeddingTarget, now })
  jobRuntime.queueRegistry.register(createIndexingQueueAdapter({ indexingJobRepository, jobRepository: indexingJobRepository, leaseRepository: jobRuntime.leaseRepository, executor: (input) => artifactProcessor.execute(input) }))
  jobRuntime.maintenanceRegistry.register('purge-indexing-jobs', ({ cutoff, limit }) => indexingJobRepository.purgeDueIndexingJobs({ cutoff, limit }))
  const reconciliationRunner = createReconciliationRunner({ repository: indexingJobRepository, leaseRepository: jobRuntime.leaseRepository, now })
  const sourcePolicyReconciliationWorker = createSourcePolicyReconciliationWorker({ sourceRepository, indexingJobRepository, leaseRepository: jobRuntime.leaseRepository, now })
  const sourcePolicyReconciliationService = createSourcePolicyReconciliationService({ worker: sourcePolicyReconciliationWorker, sourceRepository, rateLimitAdmission, now })
  if (Array.isArray(jobRuntime.cronMaterializers)) jobRuntime.cronMaterializers.push(() => reconciliationRunner.runDueSources())
  const indexingJobService = createIndexingJobService({ indexingJobRepository, articleRepository, sourceRepository, rateLimitAdmission, runDueWork: jobRuntime.coordinatorRunner, embeddingTarget, now })
  workloadPolicy(providerRegistry, 'summary')
  const embeddingRoute = configuredEmbeddingRoute(providerRegistry)
  const queryEmbedding = async (query) => {
    if (!embeddingProvider || typeof embeddingProvider.embed !== 'function') throw new Error('Query embedding is unavailable')
    const input = sanitizeText(query, 300)
    const result = await providerRouter.execute({
      workloadId: 'embedding', admittedInput: { purpose: 'retrieval', text: input }, attemptId: new ObjectId().toHexString(),
      invoke: ({ route, admittedInput }) => embeddingProvider.embed({ route, input: admittedInput.text, model: route.model, dimensions: embeddingTarget.dimensions }),
      validateOutput: ({ route, output }) => {
        if (typeof route?.model !== 'string' || !route.model || typeof route.artifactCompatibilityId !== 'string' || !route.artifactCompatibilityId || route.artifactCompatibilityId !== embeddingTarget.artifactCompatibilityId) throw new ProviderAdapterError('config')
        if (output?.model !== undefined && output.model !== route.model) throw new ProviderAdapterError('schema')
        return { model: route.model, dimensions: embeddingTarget.dimensions, version: embeddingTarget.version, artifactCompatibilityId: route.artifactCompatibilityId, embedding: validateEmbeddingVector(output?.embedding, { dimensions: embeddingTarget.dimensions }) }
      },
    })
    return result.output
  }
  Object.defineProperty(queryEmbedding, 'capability', { value: embeddingRoute.capability, enumerable: true, writable: false, configurable: false })
  Object.freeze(queryEmbedding)
  return { indexingJobService, indexingJobRepository, providerAdmissionRepository, providerFailureDomainRepository, providerAdmission, providerRouter, artifactProcessor, reconciliationRunner, sourcePolicyReconciliationWorker, sourcePolicyReconciliationService, queryEmbedding }
}
