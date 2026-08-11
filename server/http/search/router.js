import { Router } from 'express'
import { ContentError } from '../../application/articles/service.js'
import { asyncContentRoute, noStoreContent, requireAuthenticated } from '../articles/authenticated.js'

export function createSearchRouter({ searchService } = {}) {
  const router = Router()
  const service = searchService ?? { search: () => { throw new ContentError(503, 'service_unavailable', 'Search service is not configured') } }
  router.get('/api/v1/search-results', requireAuthenticated, asyncContentRoute(async (req, res) => {
    const result = await service.search({ auth: req.auth, query: req.query })
    noStoreContent(res)
    res.status(200).json({ data: result.results ?? [], meta: result.meta })
  }))
  return router
}
