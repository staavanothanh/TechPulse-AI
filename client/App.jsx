import { useCallback, useEffect, useState } from 'react'
import { createApiClient } from '../shared/generated/api-client.js'
import AuthAccount from './features/auth/AuthAccount.jsx'
import SourceRegistry from './features/admin/sources/SourceRegistry.jsx'
import JobsPanel from './features/admin/jobs/JobsPanel.jsx'
import IndexingJobsPanel from './features/admin/jobs/indexing/IndexingJobsPanel.jsx'
import { bootstrapSessionFailure } from './features/auth/session-state.js'
import ContentWorkspace from './features/feed/ContentWorkspace.jsx'

const api = createApiClient()

export default function App() {
  const [health, setHealth] = useState({ status: 'loading', message: 'Đang kiểm tra API…' })
  const [session, setSession] = useState({ status: 'loading', user: null, csrfToken: null, error: null, notice: null })
  const [contentRoute, setContentRoute] = useState('feed')

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

  const accountPanel = session.status === 'ready' ? <AuthAccount key={`${session.user?.id ?? 'guest'}:${session.csrfToken ?? 'none'}`} api={api} initialUser={session.user} initialCsrfToken={session.csrfToken} initialNotice={session.notice} onSession={applySession} /> : null
  const reader = session.status === 'ready' && session.user?.role === 'user'

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

      <div className={`app-layout ${reader ? 'reader-app-layout' : ''}`}>
        {!reader ? <nav className="side-nav" aria-label="Điều hướng nền tảng">
          <span className="nav-label">Step 04</span>
          <a className="nav-item active" href="#main-content" aria-current="page">
            Source policy
          </a>
          {session.user?.role === 'admin' ? <a className="nav-item" href="#source-registry-title">Source Registry</a> : null}
          {session.user?.role === 'admin' ? <a className="nav-item" href="#jobs-panel-title">Durable jobs</a> : null}
          {session.user?.role === 'admin' ? <a className="nav-item" href="#indexing-jobs-title">Indexing jobs</a> : null}
          <span className="nav-note">Source policy, durable jobs và fenced leases giữ ingestion fail closed trước các connector ở Step 5.</span>
        </nav> : null}

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
          {session.status === 'ready' && (!session.user || session.user.role === 'admin') ? accountPanel : null}
          {reader ? <ContentWorkspace generatedApi={api} csrfToken={session.csrfToken} route={contentRoute} onRouteChange={setContentRoute} accountPanel={accountPanel} onSessionExpired={(notice) => applySession(null, null, notice)} /> : null}
          {session.status === 'ready' && session.user?.role === 'admin' ? <SourceRegistry api={api} csrfToken={session.csrfToken} onSessionExpired={(notice) => setSession({ status: 'ready', user: null, csrfToken: null, error: null, notice })} /> : null}
          {session.status === 'ready' && session.user?.role === 'admin' ? <JobsPanel api={api} csrfToken={session.csrfToken} onSessionExpired={(notice) => setSession({ status: 'ready', user: null, csrfToken: null, error: null, notice })} /> : null}
          {session.status === 'ready' && session.user?.role === 'admin' ? <IndexingJobsPanel api={api} csrfToken={session.csrfToken} onSessionExpired={(notice) => setSession({ status: 'ready', user: null, csrfToken: null, error: null, notice })} /> : null}
          {!reader ? <section className="hero-card" aria-labelledby="page-title">
            <div className="eyebrow">STEP 04 · DURABLE EXECUTION FOUNDATION</div>
            <h1 id="page-title">Mỗi lần chạy có identity, lease và giới hạn rõ ràng.</h1>
            <p className="hero-copy">
              Admin trigger và cron dùng chung durable queue. Safe-fetch kiểm chứng network boundary; lease generation chặn stale worker ghi kết quả.
            </p>
            <div className="foundation-grid">
              <article className="foundation-card">
                <span className="mono">01</span>
                <h2>SSRF fail closed</h2>
                <p>HTTPS, toàn bộ A/AAAA, redirect, content type và payload đều bị giới hạn trước connector.</p>
              </article>
              <article className="foundation-card">
                <span className="mono">02</span>
                <h2>Exact fence</h2>
                <p>Owner hash, generation và thời hạn lease phải cùng khớp trong transaction trước mutation.</p>
              </article>
              <article className="foundation-card">
                <span className="mono">03</span>
                <h2>Bounded fairness</h2>
                <p>Mỗi queue có reserved attempt trước spill; queue chưa đăng ký giữ zero counters và không bị query.</p>
              </article>
            </div>
          </section> : null}
        </main>
      </div>
    </>
  )
}
