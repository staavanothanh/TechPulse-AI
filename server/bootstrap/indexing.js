import { createProviderAdmission } from '../ai/provider-admission.js'
import { ObjectId } from 'mongodb'
import { BGE_M3, validateBgeM3Embedding } from '../ai/embedding.js'
import { sanitizeText } from '../domain/article/normalization.js'
import { createArtifactProcessor } from '../application/indexing/artifact-processor.js'
import { createIndexingJobService } from '../application/indexing/service.js'
import { createReconciliationRunner } from '../application/indexing/reconciliation.js'
import { createIndexingQueueAdapter } from '../jobs/indexing-queue.js'
import { MongoArticleRepository } from '../repositories/mongo/article-repository.js'
import { MongoIndexingJobRepository } from '../repositories/mongo/indexing-job-repository.js'
import { MongoProviderAdmissionRepository } from '../repositories/mongo/provider-admission-repository.js'
import { MongoSourceRepository } from '../repositories/mongo/source-repository.js'
import { exactMongoIndex } from '../repositories/mongo/index-contract.js'
import { INDEXING_ARTICLE_INDEXES, INDEXING_JOB_AUDIT_VALIDATOR, INDEXING_JOB_COLLECTIONS, INDEXING_JOB_INDEXES } from '../../scripts/migrations/indexing-jobs.js'

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
    if (!collection || collection.options?.validationLevel !== 'strict' || collection.options?.validationAction !== 'error' || stableJson(collection.options?.validator) !== stableJson(definition.validator)) throw new Error('indexing-jobs validator is not ready')
    const actualByName = new Map((await context.db.collection(name).indexes()).map((index) => [index.name, index]))
    if (INDEXING_JOB_INDEXES[name].some((expected) => !exactMongoIndex(actualByName.get(expected.name), expected))) throw new Error('indexing-jobs indexes are not ready')
  }
  const audit = collectionMap.get('adminAuditLogs')
  if (!audit || audit.options?.validationLevel !== 'strict' || audit.options?.validationAction !== 'error' || stableJson(audit.options?.validator) !== stableJson(INDEXING_JOB_AUDIT_VALIDATOR)) throw new Error('indexing-jobs audit validator is not ready')
  const articleIndexes = new Map((await context.db.collection('articles').indexes()).map((index) => [index.name, index]))
  if (INDEXING_ARTICLE_INDEXES.some((expected) => !exactMongoIndex(articleIndexes.get(expected.name), expected))) throw new Error('article reconciliation index is not ready')
}

function configuredRoutes(registry) {
  const enabled = (registry?.routes ?? []).filter((route) => route.enabled === true)
  const primary = enabled.find((route) => route.provider === 'opencode-zen' && route.model === 'deepseek-v4-flash-free')
  if (!primary) throw new Error('OpenCode Zen primary summary route is not configured')
  const fallback = enabled.find((route) => route.routeId !== primary.routeId && route.model === 'deepseek-v4-flash')
  return {
    summary: [primary, fallback].filter(Boolean).map((route) => route.routeId),
    embedding: enabled.find((route) => route.model === 'baai/bge-m3')?.routeId,
  }
}

export async function createConfiguredIndexingRuntime({
  context, jobRuntime, rateLimitAdmission, providerRegistry = { domains: [], routes: [] }, llmProvider, embeddingProvider, now = () => new Date(),
} = {}) {
  if (!jobRuntime?.queueRegistry || !jobRuntime?.maintenanceRegistry || !jobRuntime?.leaseRepository || typeof jobRuntime.coordinatorRunner !== 'function') throw new Error('Shared durable job runtime is required')
  if (typeof rateLimitAdmission?.reserve !== 'function') throw new Error('Rate-limit admission is required')
  await assertIndexingJobsReady(context)
  const indexingJobRepository = new MongoIndexingJobRepository(context)
  const articleRepository = new MongoArticleRepository(context)
  const sourceRepository = new MongoSourceRepository(context)
  const providerAdmissionRepository = new MongoProviderAdmissionRepository(context)
  const providerAdmission = createProviderAdmission({ repository: providerAdmissionRepository, registry: providerRegistry, now })
  const artifactProcessor = createArtifactProcessor({ articleRepository, sourceRepository, indexingJobRepository, providerAdmission, llmProvider, embeddingProvider, routes: configuredRoutes(providerRegistry), now })
  jobRuntime.queueRegistry.register(createIndexingQueueAdapter({ indexingJobRepository, jobRepository: indexingJobRepository, leaseRepository: jobRuntime.leaseRepository, executor: (input) => artifactProcessor.execute(input) }))
  jobRuntime.maintenanceRegistry.register('purge-indexing-jobs', ({ cutoff, limit }) => indexingJobRepository.purgeDueIndexingJobs({ cutoff, limit }))
  const reconciliationRunner = createReconciliationRunner({ repository: indexingJobRepository, leaseRepository: jobRuntime.leaseRepository, now })
  if (Array.isArray(jobRuntime.cronMaterializers)) jobRuntime.cronMaterializers.push(() => reconciliationRunner.runDueSources())
  const indexingJobService = createIndexingJobService({ indexingJobRepository, articleRepository, sourceRepository, rateLimitAdmission, runDueWork: jobRuntime.coordinatorRunner, now })
  const embeddingRoute = configuredRoutes(providerRegistry).embedding
  const queryEmbedding = async (query) => {
    if (!embeddingRoute || !embeddingProvider) throw new Error('Query embedding is unavailable')
    const input = sanitizeText(query, 300)
    const result = await providerAdmission.run({
      routeId: embeddingRoute, capability: 'nonconfidential', attemptId: new ObjectId().toHexString(), kind: 'embedding',
      invoke: (route) => embeddingProvider.embed({ route, input, model: BGE_M3.model, dimensions: BGE_M3.dimensions }),
    })
    const vector = validateBgeM3Embedding(result)
    return { model: BGE_M3.model, dimensions: BGE_M3.dimensions, version: BGE_M3.version, embedding: vector }
  }
  return { indexingJobService, indexingJobRepository, providerAdmissionRepository, providerAdmission, artifactProcessor, reconciliationRunner, queryEmbedding }
}
