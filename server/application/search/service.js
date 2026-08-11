import { BGE_M3, validateBgeM3Embedding } from '../../ai/embedding.js'
import { ContentError, requireContentUser, searchQuery } from '../articles/query.js'

function unavailable() {
  throw new ContentError(503, 'service_unavailable', 'Search service is not configured')
}

export function createSearchService({ repository, embeddingAvailable = () => false, queryEmbedding } = {}) {
  const contentRepository = repository ?? { searchVisibleArticles: unavailable }
  return Object.freeze({
    async search({ auth, query } = {}) {
      const userId = requireContentUser(auth)
      const input = searchQuery(query)
      const requestedMode = input.mode
      let embedding = null
      let embeddingFailure = null
      if (requestedMode === 'hybrid' && typeof queryEmbedding === 'function') {
        try {
          const candidate = await queryEmbedding(input.q)
          const vector = validateBgeM3Embedding({ model: candidate?.model, embedding: candidate?.embedding })
          if (candidate?.dimensions !== BGE_M3.dimensions || candidate?.version !== BGE_M3.version) throw new Error('Query embedding metadata is incompatible')
          embedding = { model: BGE_M3.model, dimensions: BGE_M3.dimensions, version: BGE_M3.version, embedding: vector }
        } catch (error) { embeddingFailure = error; embedding = null }
      }
      const legacyReady = requestedMode === 'hybrid' && typeof queryEmbedding !== 'function' && Boolean(await embeddingAvailable())
      const embeddingsReady = Boolean(embedding) || legacyReady
      const effectiveRequestMode = embedding ? 'hybrid' : 'text'
      const result = await contentRepository.searchVisibleArticles({ ...input, mode: effectiveRequestMode, ...(embedding ? { queryEmbedding: embedding } : {}), userId })
      const repositoryFallback = result.fallbackReason ?? null
      const effectiveMode = embeddingsReady && !repositoryFallback ? 'hybrid' : 'text'
      const fallbackUsed = requestedMode === 'hybrid' && effectiveMode === 'text'
      const fallbackReason = fallbackUsed ? repositoryFallback ?? (embeddingsReady ? 'no-compatible-vectors' : embeddingFailure?.retryable === true ? 'provider-timeout' : 'embedding-unavailable') : null
      return {
        results: result.results ?? [],
        meta: {
          hasNext: Boolean(result.hasNext),
          nextCursor: result.nextCursor ?? null,
          requestedMode,
          effectiveMode,
          fallbackUsed,
          fallbackReason,
        },
      }
    },
  })
}
