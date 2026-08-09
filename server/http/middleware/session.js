import { hashSessionToken } from '../../security/session-token.js'
import { parseSessionCookie } from '../cookies.js'

export function createSessionMiddleware({ authService } = {}) {
  return async (req, _res, next) => {
    const token = parseSessionCookie(req.get?.('Cookie') ?? req.headers?.cookie)
    if (token && authService?.authenticate) {
      try {
        req.auth = await authService.authenticate({ token, tokenHash: hashSessionToken(token), request: req })
      } catch (error) {
        if (error?.status !== 401 || error?.code !== 'unauthorized') return next(error)
        req.auth = null
      }
    }
    next()
  }
}
