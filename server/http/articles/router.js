import { Router } from 'express'
import { ContentError } from '../../application/articles/service.js'
import { asyncContentRoute, noStoreContent, requireAuthenticated } from './authenticated.js'

export function createArticlesRouter({ articleService } = {}) {
  const router = Router()
  const unavailable = () => { throw new ContentError(503, 'service_unavailable', 'Article service is not configured') }
  const service = articleService ?? { list: unavailable, get: unavailable }
  router.get('/api/v1/articles', requireAuthenticated, asyncContentRoute(async (req, res) => {
    const result = await service.list({ auth: req.auth, query: req.query })
    noStoreContent(res)
    res.status(200).json({ data: result.articles ?? [], meta: { hasNext: Boolean(result.hasNext), nextCursor: result.nextCursor ?? null, totalItems: Number.isInteger(result.totalItems) && result.totalItems >= 0 ? result.totalItems : 0 } })
  }))
  router.get('/api/v1/articles/:articleId', requireAuthenticated, asyncContentRoute(async (req, res) => {
    const article = await service.get({ auth: req.auth, articleId: req.params.articleId })
    noStoreContent(res)
    res.status(200).json({ data: article })
  }))
  return router
}
