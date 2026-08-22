import { createIngestionService } from '../application/ingestion/service.js'
import { createCurrentSourcePolicy } from '../application/sources/current-policy.js'
import { createLiveConnectorRegistry } from '../connectors/live-registry.js'
import { MongoArticleRepository } from '../repositories/mongo/article-repository.js'
import { MongoSourceRepository } from '../repositories/mongo/source-repository.js'
import { configuredEmbeddingTarget } from './indexing.js'

export function createConfiguredIngestionExecutor({
  context,
  providerRegistry,
  embeddingTarget,
  sourceRepository = new MongoSourceRepository(context),
  articleRepository,
  currentSourcePolicy = createCurrentSourcePolicy({ repository: sourceRepository }),
  connectorRegistry,
  safeFetch,
  now = () => new Date(),
} = {}) {
  if (!sourceRepository || typeof sourceRepository.findSourceById !== 'function')
    throw new Error('Source repository is required')
  let resolvedEmbeddingTarget = embeddingTarget
  if (!resolvedEmbeddingTarget && providerRegistry !== undefined)
    resolvedEmbeddingTarget = configuredEmbeddingTarget(providerRegistry)
  const resolvedArticleRepository =
    articleRepository ??
    new MongoArticleRepository(context, { embeddingTarget: resolvedEmbeddingTarget })
  const resolvedConnectorRegistry =
    connectorRegistry ?? createLiveConnectorRegistry({ safeFetch, now })
  if (
    !resolvedArticleRepository ||
    typeof resolvedArticleRepository.commitIngestionBatch !== 'function'
  )
    throw new Error('Article repository is required')
  if (!resolvedConnectorRegistry || typeof resolvedConnectorRegistry.resolve !== 'function')
    throw new Error('Connector registry is required')
  const service = createIngestionService({
    connectorRegistry: resolvedConnectorRegistry,
    sourceRepository,
    articleRepository: resolvedArticleRepository,
    currentSourcePolicy,
    now,
  })
  return async (input = {}) => {
    const batchSize = Number.isInteger(input.job?.batchSize) ? input.job.batchSize : undefined
    const result = await service.execute({
      ...input,
      ...(batchSize !== undefined ? { maxResults: batchSize } : {}),
      maxPages: 1,
    })
    if (!result || typeof result !== 'object' || !result.counters || typeof result.counters !== 'object' || !result.checkpoint || typeof result.checkpoint !== 'object') {
      const error = new Error('Ingestion worker returned an invalid outcome')
      error.code = 'worker_outcome_invalid'
      error.retryable = false
      throw error
    }
    return {
      status: ['succeeded', 'partial', 'failed', 'cancelled'].includes(result.status)
        ? result.status
        : 'succeeded',
      checkpoint: result.checkpoint,
      counters: result.counters,
    }
  }
}
