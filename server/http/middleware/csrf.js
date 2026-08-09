import { sendError } from '../errors.js'

export function requireCsrf(authService) {
  return async (req, res, next) => {
    if (!req.auth) return sendError(res, { status: 401, code: 'unauthorized', message: 'Authentication is required' })
    if (!authService?.verifyCsrf) return sendError(res, { status: 503, code: 'service_unavailable', message: 'Authentication service is not configured' })
    try {
      await authService.verifyCsrf({ auth: req.auth, token: req.get('X-CSRF-Token') })
      return next()
    } catch (error) {
      if (error?.status === 403 && error?.code === 'csrf_invalid') return sendError(res, { status: 403, code: 'csrf_invalid', message: 'CSRF token is invalid' })
      return next(error)
    }
  }
}
