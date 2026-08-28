export const PUBLIC_ROUTES = Object.freeze(
  new Set(['feed', 'search', 'saved', 'article', 'qa', 'account', 'donate']),
)
export const ADMIN_ROUTES = Object.freeze(
  new Set([
    'overview',
    'jobs',
    'articles',
    'governance',
    'sources',
    'users',
    'audit',
    'account',
    'deletions',
  ]),
)

export function normalizePublicRoute(route) {
  return PUBLIC_ROUTES.has(route) ? route : 'feed'
}

export function normalizeAdminRoute(route) {
  return ADMIN_ROUTES.has(route) ? route : 'overview'
}

export function sessionSurface(session) {
  return session?.status === 'ready' && session?.user?.role === 'admin' ? 'admin' : 'public'
}

export function isSessionAccessFailure(error) {
  return error?.status === 401
}

export function publicSessionForRole(session) {
  if (session?.status !== 'ready' || !session?.user || session.user.role === 'user') return session
  return { ...session, user: null, csrfToken: null }
}

export function publicSessionKey(session) {
  if (session?.status === 'ready' && session?.user?.role === 'user') {
    const userId = session.user.id ?? session.user._id ?? 'unknown'
    return session.csrfToken ? `user:${userId}:${session.csrfToken}` : `user:${userId}`
  }
  return 'guest'
}

export function parsePublicPath(pathname, search = '') {
  if (!pathname || pathname === '/') return { route: 'feed', articleId: null }
  const clean = pathname.replace(/^\/+|\/+$/g, '')
  const segments = clean.split('/')
  const root = segments[0]

  if (root === 'article') {
    return {
      route: 'article',
      articleId: segments[1] ? decodeURIComponent(segments[1]) : null,
    }
  }
  if (PUBLIC_ROUTES.has(root)) {
    const result = { route: root, articleId: null }
    if (root === 'search' && search) {
      const params = new URLSearchParams(search)
      result.searchParams = {
        q: params.get('q') || '',
        mode: params.get('mode') || 'hybrid',
        topic: params.get('topic') || '',
        sourceId: params.get('sourceId') || '',
        publishedAfter: params.get('publishedAfter') || '',
        publishedBefore: params.get('publishedBefore') || '',
      }
    }
    return result
  }
  return { route: 'feed', articleId: null }
}

export function parseAdminPath(pathname) {
  if (!pathname) return { route: 'overview' }
  const clean = pathname.replace(/^\/+|\/+$/g, '')
  const segments = clean.split('/')
  if (segments[0] !== 'admin') return { route: 'overview' }
  const subRoute = segments[1] || 'overview'
  return { route: ADMIN_ROUTES.has(subRoute) ? subRoute : 'overview' }
}

export function publicRouteToPath(route, { articleId, searchParams } = {}) {
  const normalized = normalizePublicRoute(route)
  if (normalized === 'article' && articleId) {
    return `/article/${encodeURIComponent(articleId)}`
  }
  if (normalized === 'search' && searchParams) {
    const params = new URLSearchParams()
    if (searchParams.q) params.set('q', searchParams.q)
    if (searchParams.topic) params.set('topic', searchParams.topic)
    if (searchParams.sourceId) params.set('sourceId', searchParams.sourceId)
    if (searchParams.mode && searchParams.mode !== 'hybrid') params.set('mode', searchParams.mode)
    if (searchParams.publishedAfter) params.set('publishedAfter', searchParams.publishedAfter)
    if (searchParams.publishedBefore) params.set('publishedBefore', searchParams.publishedBefore)
    const queryString = params.toString()
    return queryString ? `/search?${queryString}` : '/search'
  }
  if (normalized === 'feed') return '/feed'
  return `/${normalized}`
}

export function adminRouteToPath(route) {
  const normalized = normalizeAdminRoute(route)
  return `/admin/${normalized}`
}
