import { ContentError, articleIdValue, contentActorFence, requireContentUser, savedListQuery } from '../articles/query.js'

function unavailable() {
  throw new ContentError(503, 'service_unavailable', 'Saved-article service is not configured')
}

export function createSavedService({ repository } = {}) {
  const contentRepository = repository ?? {
    listSavedVisibleArticles: unavailable,
    saveVisibleArticle: unavailable,
    unsaveArticle: unavailable,
    clearSavedArticles: unavailable,
  }
  return Object.freeze({
    async list({ auth, query } = {}) {
      const userId = requireContentUser(auth)
      return contentRepository.listSavedVisibleArticles({ userId, ...savedListQuery(query) })
    },
    async save({ auth, articleId } = {}) {
      const { userId, actorFence } = contentActorFence(auth)
      const saved = await contentRepository.saveVisibleArticle({ userId, actorFence, articleId: articleIdValue(articleId) })
      if (!saved) throw new ContentError(404, 'not_found', 'Article not found')
    },
    async unsave({ auth, articleId } = {}) {
      const userId = requireContentUser(auth)
      await contentRepository.unsaveArticle({ userId, articleId: articleIdValue(articleId) })
    },
    async clear({ auth } = {}) {
      const userId = requireContentUser(auth)
      await contentRepository.clearSavedArticles({ userId })
    },
  })
}
