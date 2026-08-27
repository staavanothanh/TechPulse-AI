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
