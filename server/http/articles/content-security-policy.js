import { normalizeReviewedHostname } from '../../domain/source/validation.js'

export function contentSecurityPolicy(imageHosts = []) {
  const exactImageSources = [...new Set((Array.isArray(imageHosts) ? imageHosts : []).flatMap((host) => {
    try {
      return [normalizeReviewedHostname(host)]
    } catch {
      return []
    }
  }))].sort().map((host) => `https://${host}`)
  return `base-uri 'self'; object-src 'none'; frame-ancestors 'none'; img-src 'self'${exactImageSources.length ? ` ${exactImageSources.join(' ')}` : ''}`
}

export function createContentSecurityPolicyMiddleware({ imageHosts = [] } = {}) {
  return (_req, res, next) => {
    const writeHead = res.writeHead
    res.writeHead = function writeHeadWithContentSecurityPolicy(...args) {
      let policy = contentSecurityPolicy()
      try {
        const resolvedHosts = typeof imageHosts === 'function' ? imageHosts() : imageHosts
        policy = contentSecurityPolicy(resolvedHosts)
      } catch { /* Invalid dynamic policy data must fail closed. */ }
      res.setHeader('Content-Security-Policy', policy)
      return writeHead.apply(this, args)
    }
    next()
  }
}
