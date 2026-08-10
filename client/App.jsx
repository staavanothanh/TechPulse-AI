import { useCallback, useEffect, useState } from 'react'
import { createApiClient } from '../shared/generated/api-client.js'
import AuthAccount from './features/auth/AuthAccount.jsx'
import SourceRegistry from './features/admin/sources/SourceRegistry.jsx'
import { bootstrapSessionFailure } from './features/auth/session-state.js'

const api = createApiClient()

export default function App() {
  const [health, setHealth] = useState({ status: 'loading', message: 'Đang kiểm tra API…' })
  const [session, setSession] = useState({ status: 'loading', user: null, csrfToken: null, error: null, notice: null })

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
          <div className="brand-sub">News intelligence foundation</div>
        </div>
        <div className="header-status" role="status" aria-live="polite">
          <span className={`status-dot status-${health.status}`} aria-hidden="true" />
          {health.message}
        </div>
      </header>

      <div className="app-layout">
        <nav className="side-nav" aria-label="Điều hướng nền tảng">
          <span className="nav-label">Step 03</span>
          <a className="nav-item active" href="#main-content" aria-current="page">
            Source policy
          </a>
          {session.user?.role === 'admin' ? <a className="nav-item" href="#source-registry-title">Source Registry</a> : null}
          <span className="nav-note">Source Registry quản lý quyền xử lý trước khi connector hoặc AI được phép dùng dữ liệu.</span>
        </nav>

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
          {session.status === 'ready' ? <AuthAccount key={`${session.user?.id ?? 'guest'}:${session.csrfToken ?? 'none'}`} api={api} initialUser={session.user} initialCsrfToken={session.csrfToken} initialNotice={session.notice} onSession={(nextUser, nextCsrfToken, nextNotice) => setSession({ status: 'ready', user: nextUser, csrfToken: nextCsrfToken, error: null, notice: nextNotice ?? null })} /> : null}
          {session.status === 'ready' && session.user?.role === 'admin' ? <SourceRegistry api={api} csrfToken={session.csrfToken} onSessionExpired={(notice) => setSession({ status: 'ready', user: null, csrfToken: null, error: null, notice })} /> : null}
          <section className="hero-card" aria-labelledby="page-title">
            <div className="eyebrow">STEP 03 · RIGHTS-AWARE FOUNDATION</div>
            <h1 id="page-title">Mỗi nguồn có quyền xử lý kiểm chứng được.</h1>
            <p className="hero-copy">
              Source Policy tách quyền văn bản, media và trạng thái vận hành. Nguồn chưa được con người review luôn bị chặn trước storage và AI.
            </p>
            <div className="foundation-grid">
              <article className="foundation-card">
                <span className="mono">01</span>
                <h2>Fail closed</h2>
                <p>Draft, review-needed và blocked không thể âm thầm cấp quyền xử lý.</p>
              </article>
              <article className="foundation-card">
                <span className="mono">02</span>
                <h2>Policy version</h2>
                <p>Mỗi thay đổi ảnh hưởng ingestion tạo đúng một version và marker reconciliation.</p>
              </article>
              <article className="foundation-card">
                <span className="mono">03</span>
                <h2>Audit an toàn</h2>
                <p>Mutation và changed-fields audit cùng commit, không lưu snapshot hoặc credential.</p>
              </article>
            </div>
          </section>
        </main>
      </div>
    </>
  )
}
