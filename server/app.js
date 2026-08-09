import express from 'express'
import { createRequestIdMiddleware } from './http/request-id.js'
import { createIngressMiddleware } from './http/ingress.js'
import { sendError, errorHandler } from './http/errors.js'
import { createAuthRouter } from './http/auth-router.js'
import { createSessionMiddleware } from './http/middleware/session.js'

export function createApp(options = {}) {
  const app = express()
  app.disable('x-powered-by')
  app.use(createRequestIdMiddleware())
  app.use(createIngressMiddleware(options))
  app.use(express.json({ limit: '64kb', strict: true, type: 'application/json' }))
  app.use(createSessionMiddleware({ authService: options.authService }))
  app.use(createAuthRouter({ authService: options.authService }))

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
