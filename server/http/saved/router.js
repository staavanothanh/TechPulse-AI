import { Router } from 'express'
import { ContentError } from '../../application/articles/service.js'
import { requireCsrf } from '../middleware/csrf.js'
import { asyncContentRoute, noStoreContent, requireAuthenticated } from '../articles/authenticated.js'

export function createSavedRouter({ savedService, authService } = {}) {
  const router = Router()
  const unavailable = () => { throw new ContentError(503, 'service_unavailable', 'Saved-article service is not configured') }
  const service = savedService ?? { list: unavailable, save: unavailable, unsave: unavailable, clear: unavailable }
  const csrf = requireCsrf(authService)
  router.get('/api/v1/me/saved-articles', requireAuthenticated, asyncContentRoute(async (req, res) => {
    const result = await service.list({ auth: req.auth, query: req.query })
    noStoreContent(res)
    res.status(200).json({ data: result.articles ?? [], meta: { hasNext: Boolean(result.hasNext), nextCursor: result.nextCursor ?? null } })
  }))
  router.delete('/api/v1/me/saved-articles', requireAuthenticated, csrf, asyncContentRoute(async (req, res) => {
    await service.clear({ auth: req.auth })
    noStoreContent(res)
    res.status(204).end()
  }))
  router.put('/api/v1/me/saved-articles/:articleId', requireAuthenticated, csrf, asyncContentRoute(async (req, res) => {
    await service.save({ auth: req.auth, articleId: req.params.articleId })
    noStoreContent(res)
    res.status(204).end()
  }))
  router.delete('/api/v1/me/saved-articles/:articleId', requireAuthenticated, csrf, asyncContentRoute(async (req, res) => {
    await service.unsave({ auth: req.auth, articleId: req.params.articleId })
    noStoreContent(res)
    res.status(204).end()
  }))
  return router
}
