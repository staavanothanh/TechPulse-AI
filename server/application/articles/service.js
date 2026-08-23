import { ContentError, articleIdValue, pagedContentListQuery, requireContentUser } from './query.js'

function unavailable() {
  throw new ContentError(503, 'service_unavailable', 'Article service is not configured')
}

export function createArticleService({ repository } = {}) {
  const contentRepository = repository ?? { listVisibleArticles: unavailable, getVisibleArticle: unavailable }
  return Object.freeze({
    async list({ auth, query } = {}) {
      const userId = requireContentUser(auth)
      return contentRepository.listVisibleArticles({ userId, ...pagedContentListQuery(query) })
    },
    async get({ auth, articleId } = {}) {
      const userId = requireContentUser(auth)
      const article = await contentRepository.getVisibleArticle({ userId, articleId: articleIdValue(articleId) })
      if (!article) throw new ContentError(404, 'not_found', 'Article not found')
      return article
    },
  })
}

export { ContentError }
