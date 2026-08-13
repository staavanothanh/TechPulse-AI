import express from 'express'
import { createRequestIdMiddleware } from './http/request-id.js'
import { createIngressMiddleware } from './http/ingress.js'
import { sendError, errorHandler } from './http/errors.js'
import { createAuthRouter } from './http/auth-router.js'
import { createAdminSourcesRouter } from './http/admin/sources/router.js'
import { createAdminIngestionJobsRouter } from './http/admin/ingestion-jobs/router.js'
import { createAdminIndexingJobsRouter } from './http/admin/indexing-jobs/router.js'
import { createArticlesRouter } from './http/articles/router.js'
import { createContentSecurityPolicyMiddleware } from './http/articles/content-security-policy.js'
import { createSearchRouter } from './http/search/router.js'
import { createSavedRouter } from './http/saved/router.js'
import { createAnswersRouter } from './http/answers/router.js'
import { createChatSessionsRouter } from './http/chat-sessions/router.js'
import { createInternalCronRouter } from './http/internal/cron/router.js'
import { createInternalMaintenanceRouter } from './http/internal/maintenance/router.js'
import { createSessionMiddleware } from './http/middleware/session.js'

export function createApp(options = {}) {
  const app = express()
  app.disable('x-powered-by')
  app.use(createRequestIdMiddleware())
  app.use(createContentSecurityPolicyMiddleware({ imageHosts: options.imageCspHosts }))
  app.use(createIngressMiddleware(options))
  app.use(express.json({ limit: '64kb', strict: true, type: 'application/json' }))
  app.use(createSessionMiddleware({ authService: options.authService }))
  app.use(createAuthRouter({ authService: options.authService }))
  app.use(createArticlesRouter({ articleService: options.articleService }))
  app.use(createSearchRouter({ searchService: options.searchService }))
  app.use(createSavedRouter({ savedService: options.savedService, authService: options.authService }))
  app.use(createAnswersRouter({ qaService: options.qaService, authService: options.authService }))
  app.use(createChatSessionsRouter({ qaService: options.qaService, authService: options.authService }))
  app.use(createAdminSourcesRouter({ sourceService: options.sourceService, authService: options.authService }))
  app.use(createAdminIngestionJobsRouter({ jobService: options.jobService, authService: options.authService }))
  app.use(createAdminIndexingJobsRouter({ indexingJobService: options.indexingJobService, authService: options.authService }))
  app.use(createInternalCronRouter({ dueWorkRunner: options.dueWorkRunner }))
  app.use(createInternalMaintenanceRouter({ maintenanceRunner: options.maintenanceRunner }))

  app.get('/api/v1/health', (_req, res) => {
    res.set('Cache-Control', 'no-store, private')
    res.json({
      data: {
        status: 'ok',
        timestamp: new Date().toISOString(),
      },
    })
  })

  if (options.afterApiMiddleware) app.use(options.afterApiMiddleware)

  app.use((_req, res) => {
    sendError(res, { status: 404, code: 'not_found', message: 'Resource not found' })
  })
  app.use(errorHandler)
  return app
}

const app = createApp()

export default app
