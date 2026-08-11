import { sendError } from '../errors.js'

export function requireAuthenticated(req, res, next) {
  if (!req.auth?.user || req.auth.user.status !== 'active') return sendError(res, { status: 401, code: 'unauthorized', message: 'Authentication is required' })
  next()
}

export function noStoreContent(res) {
  res.set('Cache-Control', 'no-store, private')
  res.set('Vary', 'Cookie')
}

export const asyncContentRoute = (handler) => (req, res, next) => Promise.resolve(handler(req, res)).catch(next)
