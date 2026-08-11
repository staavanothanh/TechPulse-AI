import { useCallback, useEffect, useState } from 'react'
import { createApiClient } from '../shared/generated/api-client.js'
import AuthAccount from './features/auth/AuthAccount.jsx'
import SourceRegistry from './features/admin/sources/SourceRegistry.jsx'
import JobsPanel from './features/admin/jobs/JobsPanel.jsx'
import IndexingJobsPanel from './features/admin/jobs/indexing/IndexingJobsPanel.jsx'
import { bootstrapSessionFailure } from './features/auth/session-state.js'
import ContentWorkspace from './features/feed/ContentWorkspace.jsx'

const api = createApiClient()

const ADMIN_DESTINATIONS = Object.freeze([
  { id: 'sources', label: 'Source Registry' },
  { id: 'jobs', label: 'Durable jobs' },
  { id: 'indexing', label: 'Indexing jobs' },
  { id: 'account', label: 'Tài khoản' },
])

export function AdminNavigation({ route, onNavigate }) {
  return (
    <nav className="side-nav" aria-label="Điều hướng quản trị">
      <span className="nav-label">TechPulse Admin</span>
      {ADMIN_DESTINATIONS.map((destination) => {
        const current = destination.id === route
        return (
          <button
            key={destination.id}
            className={`nav-item${current ? ' active' : ''}`}
            type="button"
            aria-current={current ? 'page' : undefined}
            onClick={() => onNavigate?.(destination.id)}
          >
            {destination.label}
          </button>
        )
      })}
    </nav>
  )
}

export default function App() {
  const [health, setHealth] = useState({ status: 'loading', message: 'Đang kiểm tra API…' })
  const [session, setSession] = useState({ status: 'loading', user: null, csrfToken: null, error: null, notice: null })
  const [contentRoute, setContentRoute] = useState('feed')
  const [adminRoute, setAdminRoute] = useState('sources')
  const [adminNotice, setAdminNotice] = useState('')

  useEffect(() => {
    let active = true
    api
      .getHealth()
      .then((response) => {
        if (active) setHealth({ status: 'ok', message: `API sẵn sàng · ${response.data.timestamp}` })
      })
      .catch(() => {
        if (active) setHealth({ status: 'warning', message: 'API chưa phản hồi. Có thể tiếp tục làm việc local.' })
      })
    return () => {
      active = false
    }
  }, [])

  const loadSession = useCallback((isActive = () => true) => {
    api.getCurrentUser({ credentials: 'same-origin' }).then((response) => {
      if (isActive()) setSession({ status: 'ready', user: response.data.user, csrfToken: response.data.csrfToken, error: null, notice: null })
    }).catch((error) => {
      if (isActive()) setSession(bootstrapSessionFailure(error))
    })
  }, [])

  useEffect(() => {
    let active = true
    loadSession(() => active)
    return () => { active = false }
  }, [loadSession])

  function restoreSession() {
    setSession({ status: 'loading', user: null, csrfToken: null, error: null, notice: null })
    loadSession()
  }

  function applySession(nextUser, nextCsrfToken, nextNotice) {
    setSession({ status: 'ready', user: nextUser, csrfToken: nextCsrfToken, error: null, notice: nextNotice ?? null })
  }

  function navigateAdmin(nextRoute) {
    const destination = ADMIN_DESTINATIONS.find((item) => item.id === nextRoute)
    if (!destination) return
    setAdminRoute(destination.id)
    setAdminNotice(`Đang mở ${destination.label}.`)
    if (typeof window === 'undefined') return
    window.requestAnimationFrame(() => {
      document.getElementById('main-content')?.focus({ preventScroll: true })
    })
  }

  const accountPanel = session.status === 'ready' ? <AuthAccount key={`${session.user?.id ?? 'guest'}:${session.csrfToken ?? 'none'}`} api={api} initialUser={session.user} initialCsrfToken={session.csrfToken} initialNotice={session.notice} onSession={applySession} /> : null
  const reader = session.status === 'ready' && session.user?.role === 'user'
  const admin = session.status === 'ready' && session.user?.role === 'admin'

  return (
    <>
      <a className="skip-link" href="#main-content">
        Bỏ qua điều hướng
      </a>
      <header className="site-header">
        <div className="brand-mark" aria-hidden="true">
          TP
        </div>
        <div>
          <div className="brand-name">TechPulse AI</div>
          <div className="brand-sub">Tin công nghệ có nguồn</div>
        </div>
        <div className="header-status" role="status" aria-live="polite">
          <span className={`status-dot status-${health.status}`} aria-hidden="true" />
          {health.message}
        </div>
      </header>

      <div className={`app-layout ${admin ? 'admin-app-layout' : reader ? 'reader-app-layout' : 'guest-app-layout'}`}>
        {admin ? <AdminNavigation route={adminRoute} onNavigate={navigateAdmin} /> : null}
        {admin ? <p className="sr-only" role="status" aria-live="polite" aria-atomic="true">{adminNotice}</p> : null}

        <main id="main-content" tabIndex="-1">
          {session.status === 'loading' ? <section className="hero-card" aria-busy="true"><p>Đang khôi phục phiên…</p></section> : null}
          {session.status === 'error' ? (
            <section className="auth-card" aria-labelledby="session-recovery-title" role="alert">
              <div className="eyebrow">SESSION RECOVERY</div>
              <h1 id="session-recovery-title">Không thể khôi phục phiên.</h1>
              <p className="hero-copy">{session.error}</p>
              <button className="primary-button" type="button" onClick={restoreSession}>Thử lại</button>
            </section>
          ) : null}
          {session.status === 'ready' && !session.user ? accountPanel : null}
          {reader ? <ContentWorkspace generatedApi={api} csrfToken={session.csrfToken} route={contentRoute} onRouteChange={setContentRoute} accountPanel={accountPanel} onSessionExpired={(notice) => applySession(null, null, notice)} /> : null}
          {admin && adminRoute === 'account' ? accountPanel : null}
          {admin && adminRoute === 'sources' ? <SourceRegistry api={api} csrfToken={session.csrfToken} onSessionExpired={(notice) => applySession(null, null, notice)} /> : null}
          {admin && adminRoute === 'jobs' ? <JobsPanel api={api} csrfToken={session.csrfToken} onSessionExpired={(notice) => applySession(null, null, notice)} /> : null}
          {admin && adminRoute === 'indexing' ? <IndexingJobsPanel api={api} csrfToken={session.csrfToken} onSessionExpired={(notice) => applySession(null, null, notice)} /> : null}
        </main>
      </div>
    </>
  )
}
