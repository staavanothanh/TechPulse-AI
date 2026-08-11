import { normalizeReviewedHostname } from '../../domain/source/validation.js'

export function contentSecurityPolicy(imageHosts = []) {
  const exactImageSources = [...new Set(imageHosts.map(normalizeReviewedHostname))].sort().map((host) => `https://${host}`)
  return `base-uri 'self'; object-src 'none'; frame-ancestors 'none'; img-src 'self'${exactImageSources.length ? ` ${exactImageSources.join(' ')}` : ''}`
}

export function createContentSecurityPolicyMiddleware({ imageHosts = [] } = {}) {
  const policy = contentSecurityPolicy(imageHosts)
  return (_req, res, next) => {
    res.set('Content-Security-Policy', policy)
    next()
  }
}
