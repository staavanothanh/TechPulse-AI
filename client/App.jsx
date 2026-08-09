import { useCallback, useEffect, useState } from 'react'
import { createApiClient } from '../shared/generated/api-client.js'
import AuthAccount from './features/auth/AuthAccount.jsx'
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
          <span className="nav-label">Step 02</span>
          <a className="nav-item active" href="#main-content" aria-current="page">
            App shell
          </a>
          <span className="nav-note">Feed, Search, Article, Q&amp;A và Admin sẽ được triển khai ở các step sau.</span>
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
          <section className="hero-card" aria-labelledby="page-title">
            <div className="eyebrow">STEP 02 · AUTHENTICATED FOUNDATION</div>
            <h1 id="page-title">Theo dõi công nghệ với bằng chứng rõ ràng.</h1>
            <p className="hero-copy">
              Nền tảng hiện đã có đăng ký, đăng nhập, phiên cookie và lưu chủ đề cá nhân. Feed, Search, Article, Q&amp;A và Admin đầy đủ sẽ được triển khai ở các step sau.
            </p>
            <div className="foundation-grid">
              <article className="foundation-card">
                <span className="mono">01</span>
                <h2>JavaScript/JSX</h2>
                <p>Frontend và backend dùng chung quy ước module, JSDoc và OpenAPI.</p>
              </article>
              <article className="foundation-card">
                <span className="mono">02</span>
                <h2>Boundary trước feature</h2>
                <p>Ingress, error envelope, Origin và request ID được khóa trước business flow.</p>
              </article>
              <article className="foundation-card">
                <span className="mono">03</span>
                <h2>Accessibility mặc định</h2>
                <p>Skip link, focus-visible, live status và responsive layout sẵn sàng cho step kế tiếp.</p>
              </article>
            </div>
          </section>
        </main>
      </div>
    </>
  )
}
