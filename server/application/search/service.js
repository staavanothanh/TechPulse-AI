import { ContentError, requireContentUser, searchQuery } from '../articles/query.js'

function unavailable() {
  throw new ContentError(503, 'service_unavailable', 'Search service is not configured')
}

export function createSearchService({ repository, embeddingAvailable = () => false } = {}) {
  const contentRepository = repository ?? { searchVisibleArticles: unavailable }
  return Object.freeze({
    async search({ auth, query } = {}) {
      const userId = requireContentUser(auth)
      const input = searchQuery(query)
      const requestedMode = input.mode
      const embeddingsReady = requestedMode === 'hybrid' && Boolean(await embeddingAvailable())
      const result = await contentRepository.searchVisibleArticles({ ...input, userId })
      const repositoryFallback = result.fallbackReason ?? null
      const effectiveMode = embeddingsReady && !repositoryFallback ? 'hybrid' : 'text'
      const fallbackUsed = requestedMode === 'hybrid' && effectiveMode === 'text'
      const fallbackReason = fallbackUsed ? repositoryFallback ?? (embeddingsReady ? 'no-compatible-vectors' : 'embedding-unavailable') : null
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
