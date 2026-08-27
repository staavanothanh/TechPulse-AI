import { ContentError, requireContentUser, searchQuery } from '../articles/query.js'
import { containsSensitiveProviderInput } from '../../ai/policy-input.js'

function unavailable() {
  throw new ContentError(503, 'service_unavailable', 'Search service is not configured')
}

function validateQueryEmbedding(candidate) {
  if (!candidate || typeof candidate.model !== 'string' || !candidate.model || !Number.isInteger(candidate.dimensions) || candidate.dimensions < 1 || !Number.isInteger(candidate.version) || candidate.version < 1 || !Array.isArray(candidate.embedding) || candidate.embedding.length !== candidate.dimensions || candidate.embedding.some((item) => typeof item !== 'number' || !Number.isFinite(item))) throw new Error('Query embedding metadata is incompatible')
  if (candidate.artifactCompatibilityId !== undefined && (typeof candidate.artifactCompatibilityId !== 'string' || !/^[a-z0-9][a-z0-9._-]{0,63}$/.test(candidate.artifactCompatibilityId))) throw new Error('Query embedding compatibility is invalid')
  return Object.freeze({
    model: candidate.model,
    dimensions: candidate.dimensions,
    version: candidate.version,
    ...(candidate.artifactCompatibilityId !== undefined ? { artifactCompatibilityId: candidate.artifactCompatibilityId } : {}),
    embedding: Object.freeze([...candidate.embedding]),
  })
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
      if (requestedMode === 'hybrid' && typeof queryEmbedding === 'function' && !containsSensitiveProviderInput(input.q)) {
        try {
          const candidate = await queryEmbedding(input.q)
          embedding = validateQueryEmbedding(candidate)
        } catch (error) { embeddingFailure = error; embedding = null }
      } else if (requestedMode === 'hybrid' && containsSensitiveProviderInput(input.q)) {
        embeddingFailure = Object.assign(new Error('Sensitive search input is not eligible for external embedding'), { code: 'sensitive-input' })
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
