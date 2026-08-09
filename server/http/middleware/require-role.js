import { sendError } from '../errors.js'

export function requireRole(role) {
  return (req, res, next) => {
    if (!req.auth?.user) return sendError(res, { status: 401, code: 'unauthorized', message: 'Authentication is required' })
    if (req.auth.user.role !== role) return sendError(res, { status: 403, code: 'forbidden', message: 'Insufficient permissions' })
    next()
  }
}
