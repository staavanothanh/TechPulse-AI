import { useCallback, useEffect, useMemo, useState } from 'react'
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
  normalizeAdminRoute,
  normalizePublicRoute,
  publicSessionForRole,
  publicSessionKey,
  sessionSurface,
} from './app/integration/routing.js'
import { usePublicIntegration } from './app/integration/use-public-integration.js'

const api = createApiClient()
const EMPTY_SESSION = Object.freeze({
  status: 'loading',
  user: null,
  csrfToken: null,
  error: null,
  notice: null,
})

function PublicSurface({
  api,
  publicSession,
  route,
  theme,
  onThemeToggle,
  onNavigate,
  onRetrySession,
  onSessionExpired,
  onAuthSubmit,
  onAuthModeChange,
  onGuestBrowse,
  auth,
  health,
  accountActions,
  sessionNotice,
}) {
  const integration = usePublicIntegration({
    api,
    csrfToken: publicSession?.csrfToken,
    user: publicSession?.user,
    route,
    onNavigate,
    onSessionExpired,
    accountActions,
    sessionNotice,
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
      onAuthModeChange={onAuthModeChange}
      onGuestBrowse={onGuestBrowse}
      auth={auth}
      api={api}
      csrfToken={publicSession?.csrfToken}
      health={health}
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
  const [theme, toggleTheme] = useTheme()
  const [health, setHealth] = useState({ status: 'loading', message: 'Đang kiểm tra API…' })
  const [session, setSession] = useState(EMPTY_SESSION)
  const [publicRoute, setPublicRoute] = useState('feed')
  const [adminRoute, setAdminRoute] = useState('overview')
  const [auth, setAuth] = useState({ mode: 'login', busy: false, error: null, notice: null })

  useEffect(() => {
    let active = true
    void api
      .getHealth()
      .then((response) => {
        if (active)
          setHealth({ status: 'ok', message: `API sẵn sàng · ${response.data.timestamp}` })
      })
      .catch(() => {
        if (active) setHealth({ status: 'warning', message: 'API chưa phản hồi' })
      })
    return () => {
      active = false
    }
  }, [])

  const loadSession = useCallback((isActive = () => true) => {
    void api
      .getCurrentUser({ credentials: 'same-origin' })
      .then((response) => {
        if (isActive())
          setSession({
            status: 'ready',
            user: response.data.user,
            csrfToken: response.data.csrfToken,
            error: null,
            notice: null,
          })
      })
      .catch((error) => {
        if (isActive()) setSession(recoverBootstrapSession(error))
      })
  }, [])

  useEffect(() => {
    let active = true
    loadSession(() => active)
    return () => {
      active = false
    }
  }, [loadSession])

  const applySession = useCallback((nextUser, nextCsrfToken, nextNotice = null) => {
    setSession({
      status: 'ready',
      user: nextUser ?? null,
      csrfToken: nextCsrfToken ?? null,
      error: null,
      notice: nextNotice,
    })
    setAuth((current) => ({ ...current, busy: false, error: null, notice: nextNotice }))
    if (!nextUser) setPublicRoute('feed')
  }, [])

  const expireSession = useCallback(
    (notice) => {
      applySession(null, null, notice)
    },
    [applySession],
  )

  const accountActions = useMemo(
    () =>
      createSessionActions({
        api,
        getCsrfToken: () => session.csrfToken,
        applySession,
      }),
    [applySession, session.csrfToken],
  )
  const adminApi = useMemo(() => withSessionRecovery(api, expireSession), [expireSession])

  const publicSession = publicSessionForRole(session)

  async function authenticate(credentials) {
    setAuth((current) => ({ ...current, busy: true, error: null, notice: null }))
    try {
      await accountActions.authenticate(credentials)
    } catch (error) {
      setAuth((current) => ({ ...current, busy: false, error, notice: null }))
    }
  }

  function retrySession() {
    setSession(EMPTY_SESSION)
    loadSession()
  }

  const guestBrowseNotice = useCallback(() => {
    setAuth((current) => ({
      ...current,
      error: null,
      notice: 'Feed chỉ mở sau khi đăng nhập để giữ phiên và dữ liệu theo đúng contract.',
    }))
    globalThis.setTimeout?.(
      () => globalThis.document?.getElementById('public-auth-email')?.focus(),
      0,
    )
  }, [])

  const surface = sessionSurface(session)
  if (surface === 'admin') {
    return (
      <AdminRedesign
        api={adminApi}
        session={session}
        route={normalizeAdminRoute(adminRoute)}
        onNavigate={(route) => setAdminRoute(normalizeAdminRoute(route))}
        onSessionExpired={expireSession}
        onLogout={() => applySession(null, null, null)}
        theme={theme}
        onToggleTheme={toggleTheme}
      />
    )
  }

  return (
    <PublicSurface
      key={publicSessionKey(publicSession)}
      api={api}
      publicSession={publicSession}
      route={normalizePublicRoute(publicRoute)}
      theme={theme}
      onThemeToggle={toggleTheme}
      onNavigate={(route) => setPublicRoute(normalizePublicRoute(route))}
      onRetrySession={retrySession}
      onSessionExpired={expireSession}
      onAuthSubmit={authenticate}
      onAuthModeChange={(mode) => setAuth((current) => ({ ...current, mode, error: null }))}
      onGuestBrowse={guestBrowseNotice}
      auth={auth}
      health={health}
      accountActions={accountActions}
      sessionNotice={session.notice}
    />
  )
}
