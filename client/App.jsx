import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import { InMemoryScrollRestoration } from './theme/use-scroll-restoration.js'
import { createApiClient } from '../shared/generated/api-client.js'
import PublicApp from './features/public/index.js'
import AdminRedesign from './features/admin/ui/AdminShell.jsx'
import { useTheme } from './theme/use-theme.js'
import {
  createSessionActions,
  recoverBootstrapSession,
  withSessionRecovery,
} from './app/integration/session-actions.js'
import {
  adminRouteToPath,
  normalizeAdminRoute,
  normalizePublicRoute,
  parseAdminPath,
  parsePublicPath,
  publicRouteToPath,
  publicSessionForRole,
  publicSessionKey,
  sessionSurface,
} from './app/integration/routing.js'
import { authErrorForRedirect } from './app/integration/oauth-redirect.js'
import { usePublicIntegration } from './app/integration/use-public-integration.js'

const api = createApiClient()
const EMPTY_SESSION = Object.freeze({
  status: 'loading',
  user: null,
  csrfToken: null,
  error: null,
  notice: null,
})

function sessionIdentity(session) {
  if (session?.status !== 'ready' || !session?.user) return 'guest'
  const userId = session.user.id ?? session.user._id ?? 'unknown'
  return `${session.user.role ?? 'user'}:${userId}${session.csrfToken ? `:${session.csrfToken}` : ''}`
}

function PublicSurface({
  api,
  publicSession,
  route,
  articleId,
  searchParams,
  theme,
  onThemeToggle,
  onNavigate,
  onRetrySession,
  onSessionExpired,
  onAuthSubmit,
  onGoogleLogin,
  onAuthModeChange,
  onGuestBrowse,
  auth,
  accountActions,
  sessionNotice,
  initialPasswordSuccessOpen,
}) {
  const integration = usePublicIntegration({
    api,
    csrfToken: publicSession?.csrfToken,
    user: publicSession?.user,
    route,
    articleId,
    searchParams,
    onNavigate,
    onSessionExpired,
    accountActions,
    sessionNotice,
    initialPasswordSuccessOpen,
  })
  const renderedSession =
    publicSession?.user && integration.account.user
      ? { ...publicSession, user: integration.account.user }
      : publicSession

  return (
    <PublicApp
      session={renderedSession}
      route={route}
      theme={theme}
      onThemeToggle={onThemeToggle}
      onNavigate={onNavigate}
      onBrandClick={() => onNavigate('feed')}
      onLogout={integration.onLogout}
      onRetrySession={onRetrySession}
      onSessionExpired={onSessionExpired}
      onAuthSubmit={onAuthSubmit}
      onGoogleLogin={onGoogleLogin}
      onAuthModeChange={onAuthModeChange}
      onGuestBrowse={onGuestBrowse}
      auth={auth}
      api={api}
      csrfToken={publicSession?.csrfToken}
      feed={integration.feed}
      search={integration.search}
      saved={integration.saved}
      article={integration.article}
      qa={integration.qa}
      account={integration.account}
    />
  )
}

export default function App() {
  const location = useLocation()
  const navigate = useNavigate()
  const [theme, toggleTheme] = useTheme()
  const [session, setSession] = useState(EMPTY_SESSION)
  const publicPath = useMemo(
    () => parsePublicPath(location.pathname, location.search),
    [location.pathname, location.search],
  )
  const adminPath = useMemo(() => parseAdminPath(location.pathname), [location.pathname])
  const publicRoute = publicPath.route
  const articleId = publicPath.articleId
  const searchParams = publicPath.searchParams
  const adminRoute = adminPath.route

  const handlePublicNavigate = useCallback(
    (nextRoute, options) => {
      if (options?.back) {
        if (typeof window !== 'undefined' && window.history?.state && window.history.state.idx > 0) {
          navigate(-1)
          return
        }
        const fallback = nextRoute || 'feed'
        navigate(publicRouteToPath(fallback), { replace: true })
        return
      }
      const target = publicRouteToPath(nextRoute, options)
      navigate(target)
    },
    [navigate],
  )
  const publicNavigateRef = useRef(handlePublicNavigate)
  useLayoutEffect(() => {
    publicNavigateRef.current = handlePublicNavigate
  }, [handlePublicNavigate])

  const handleAdminNavigate = useCallback(
    (nextRoute) => {
      const target = adminRouteToPath(nextRoute)
      navigate(target)
    },
    [navigate],
  )

  const [auth, setAuth] = useState({
    mode: 'login',
    busy: false,
    googleBusy: false,
    error: null,
    notice: null,
  })
  const [passwordSuccessPending, setPasswordSuccessPending] = useState(false)

  useEffect(() => {
    if (typeof window === 'undefined') return undefined
    const marker = new URLSearchParams(window.location.search).get('auth_error')
    const redirectError = authErrorForRedirect(marker)
    if (!redirectError) return undefined
    setAuth((current) => ({
      ...current,
      mode: 'login',
      busy: false,
      googleBusy: false,
      error: redirectError,
      notice: null,
    }))
    const next = new URL(window.location.href)
    next.searchParams.delete('auth_error')
    window.history.replaceState(window.history.state, '', next)
    return undefined
  }, [])

  const sessionEpochRef = useRef(0)
  const sessionIdentityRef = useRef(sessionIdentity(session))
  const sessionCsrfRef = useRef(session.csrfToken)
  useLayoutEffect(() => {
    sessionIdentityRef.current = sessionIdentity(session)
    sessionCsrfRef.current = session.csrfToken
  }, [session])
  const beginSessionTransition = useCallback(() => {
    sessionEpochRef.current += 1
    return sessionEpochRef.current
  }, [])
  const isSessionTransitionCurrent = useCallback((epoch) => epoch === sessionEpochRef.current, [])

  const applySession = useCallback((nextUser, nextCsrfToken, nextNotice = null, expectedTransition) => {
    if (expectedTransition !== undefined && expectedTransition !== sessionEpochRef.current) return false
    sessionEpochRef.current += 1
    if (!nextUser) setPasswordSuccessPending(false)
    if (typeof window !== 'undefined' && window.sessionStorage) {
      try {
        window.sessionStorage.removeItem('techpulse_pending_logout')
      } catch {
        // ignore
      }
    }
    setSession({
      status: 'ready',
      user: nextUser ?? null,
      csrfToken: nextCsrfToken ?? null,
      error: null,
      notice: nextNotice,
    })
    setAuth((current) => ({
      ...current,
      mode: 'login',
      busy: false,
      googleBusy: false,
      error: null,
      notice: nextNotice,
    }))
    if (!nextUser) publicNavigateRef.current('feed')
    return true
  }, [])

  const loadSession = useCallback((isActive = () => true) => {
    const requestEpoch = sessionEpochRef.current
    if (typeof window !== 'undefined' && window.sessionStorage) {
      try {
        const pendingNotice = window.sessionStorage.getItem('techpulse_pending_logout')
        if (pendingNotice) {
          window.sessionStorage.removeItem('techpulse_pending_logout')
          window.sessionStorage.removeItem('techpulse_password_success')
          window.sessionStorage.removeItem('techpulse_logout_deadline')
          void api.logout({ credentials: 'same-origin' }).catch(() => {})
          if (isActive() && requestEpoch === sessionEpochRef.current) {
            applySession(null, null, pendingNotice)
          }
          return
        }
      } catch {
        // ignore
      }
    }

    void api
      .getCurrentUser({ credentials: 'same-origin' })
      .then((response) => {
        if (isActive() && requestEpoch === sessionEpochRef.current)
          setSession({
            status: 'ready',
            user: response.data.user,
            csrfToken: response.data.csrfToken,
            error: null,
            notice: null,
          })
      })
      .catch((error) => {
        if (isActive() && requestEpoch === sessionEpochRef.current) setSession(recoverBootstrapSession(error))
      })
  }, [applySession])

  useEffect(() => {
    let active = true
    loadSession(() => active)
    return () => {
      active = false
    }
  }, [loadSession])

  const expireSession = useCallback(
    (notice, expectedIdentity, expectedEpoch) => {
      if (expectedIdentity !== undefined && expectedIdentity !== sessionIdentityRef.current) return false
      if (expectedEpoch !== undefined && expectedEpoch !== sessionEpochRef.current) return false
      return applySession(null, null, notice)
    },
    [applySession],
  )

  const handlePasswordChangeSuccess = useCallback((notice) => {
    setPasswordSuccessPending(true)
    if (typeof window !== 'undefined' && window.sessionStorage) {
      try {
        window.sessionStorage.setItem('techpulse_pending_logout', notice)
      } catch {
        // ignore
      }
    }
  }, [])

  const accountActions = useMemo(
    () =>
      createSessionActions({
        api,
        getCsrfToken: () => sessionCsrfRef.current,
        applySession,
        commitSession: (nextUser, nextCsrfToken, nextNotice, expectedTransition) => applySession(nextUser, nextCsrfToken, nextNotice, expectedTransition),
        beginSessionTransition,
        isSessionTransitionCurrent,
        onPasswordChangeSuccess: handlePasswordChangeSuccess,
      }),
    [applySession, beginSessionTransition, handlePasswordChangeSuccess, isSessionTransitionCurrent],
  )
  const adminApi = useMemo(
    () => withSessionRecovery(api, expireSession, {
      getSessionIdentity: () => sessionIdentityRef.current,
      isSessionIdentityCurrent: (identity) => identity === sessionIdentityRef.current,
      getSessionEpoch: () => sessionEpochRef.current,
      isSessionEpochCurrent: (epoch) => epoch === sessionEpochRef.current,
    }),
    [expireSession],
  )

  const publicSession = publicSessionForRole(session)

  async function authenticate(credentials) {
    const expectedEpoch = sessionEpochRef.current + 1
    setAuth((current) => ({
      ...current,
      busy: true,
      googleBusy: false,
      error: null,
      notice: null,
    }))
    try {
      await accountActions.authenticate(credentials)
    } catch (error) {
      if (expectedEpoch !== sessionEpochRef.current) return
      setAuth((current) => ({
        ...current,
        busy: false,
        googleBusy: false,
        error,
        notice: null,
      }))
    }
  }

  async function authenticateWithGoogle() {
    const expectedEpoch = sessionEpochRef.current + 1
    setAuth((current) => ({
      ...current,
      busy: true,
      googleBusy: true,
      error: null,
      notice: null,
    }))
    try {
      await accountActions.authenticateWithGoogle()
    } catch (error) {
      if (expectedEpoch !== sessionEpochRef.current) return
      setAuth((current) => ({
        ...current,
        busy: false,
        googleBusy: false,
        error,
        notice: null,
      }))
    }
  }

  function retrySession() {
    beginSessionTransition()
    setSession(EMPTY_SESSION)
    loadSession()
  }

  const guestBrowseNotice = useCallback(() => {
    setAuth((current) => ({
      ...current,
      mode: 'login',
      error: null,
      notice: 'Feed chỉ mở sau khi đăng nhập để giữ phiên và dữ liệu theo đúng contract.',
    }))
    globalThis.setTimeout?.(
      () => globalThis.document?.getElementById('public-auth-email')?.focus(),
      0,
    )
  }, [])

  const surfaceIdentity = sessionIdentity(session)
  const surfaceEpoch = sessionEpochRef.current
  const guardedSurfaceExpire = useCallback(
    (notice, requestIdentity, requestEpoch) => expireSession(notice, requestIdentity ?? surfaceIdentity, requestEpoch ?? surfaceEpoch),
    [expireSession, surfaceEpoch, surfaceIdentity],
  )

  const surface = sessionSurface(session)
  if (surface === 'admin') {
    return (
      <>
        <InMemoryScrollRestoration />
        <AdminRedesign
          api={adminApi}
          session={session}
          route={normalizeAdminRoute(adminRoute)}
          onNavigate={handleAdminNavigate}
          onSessionExpired={guardedSurfaceExpire}
          onLogout={() => applySession(null, null, null)}
          theme={theme}
          onToggleTheme={toggleTheme}
        />
      </>
    )
  }

  return (
    <>
      <InMemoryScrollRestoration />
      <PublicSurface
        key={publicSessionKey(publicSession)}
        api={api}
        publicSession={publicSession}
        route={normalizePublicRoute(publicRoute)}
        articleId={articleId}
        searchParams={searchParams}
        theme={theme}
        onThemeToggle={toggleTheme}
        onNavigate={handlePublicNavigate}
        onRetrySession={retrySession}
        onSessionExpired={guardedSurfaceExpire}
        onAuthSubmit={authenticate}
        onGoogleLogin={authenticateWithGoogle}
        onAuthModeChange={(mode) => setAuth((current) => ({ ...current, mode, error: null }))}
        onGuestBrowse={guestBrowseNotice}
        auth={auth}
        accountActions={accountActions}
        sessionNotice={session.notice}
        initialPasswordSuccessOpen={passwordSuccessPending}
      />
    </>
  )
}
