import { Router } from 'express'
import { requireCsrf } from '../middleware/csrf.js'
import { asyncContentRoute, noStoreContent, requireAuthenticated } from '../articles/authenticated.js'

function unavailable() {
  throw Object.assign(new Error('Chat session service is not configured'), { status: 503, code: 'service_unavailable' })
}

export function createChatSessionsRouter({ qaService, authService } = {}) {
  const router = Router()
  const service = qaService ?? {
    listChatSessions: unavailable,
    getChatSession: unavailable,
    deleteChatSession: unavailable,
    clearChatSessions: unavailable,
  }
  const csrf = requireCsrf(authService)

  router.get('/api/v1/chat-sessions', requireAuthenticated, asyncContentRoute(async (req, res) => {
    const result = await service.listChatSessions({ auth: req.auth, query: req.query, request: req })
    noStoreContent(res)
    res.status(200).json({
      data: result?.sessions ?? result?.data ?? [],
      meta: {
        hasNext: Boolean(result?.hasNext ?? result?.meta?.hasNext),
        nextCursor: result?.nextCursor ?? result?.meta?.nextCursor ?? null,
      },
    })
  }))

  router.get('/api/v1/chat-sessions/:chatSessionId', requireAuthenticated, asyncContentRoute(async (req, res) => {
    const result = await service.getChatSession({ auth: req.auth, chatSessionId: req.params.chatSessionId, request: req })
    noStoreContent(res)
    res.status(200).json({ data: result?.session ?? result?.data ?? result })
  }))

  router.delete('/api/v1/chat-sessions/:chatSessionId', requireAuthenticated, csrf, asyncContentRoute(async (req, res) => {
    await service.deleteChatSession({ auth: req.auth, chatSessionId: req.params.chatSessionId, request: req })
    noStoreContent(res)
    res.status(204).end()
  }))

  router.delete('/api/v1/chat-sessions', requireAuthenticated, csrf, asyncContentRoute(async (req, res) => {
    await service.clearChatSessions({ auth: req.auth, request: req })
    noStoreContent(res)
    res.status(204).end()
  }))

  return router
}
