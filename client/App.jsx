import { useCallback, useEffect, useState } from 'react'
import { createApiClient } from '../shared/generated/api-client.js'
import AuthAccount from './features/auth/AuthAccount.jsx'
import SourceRegistry from './features/admin/sources/SourceRegistry.jsx'
import AdminOperations from './features/admin/operations/AdminOperations.jsx'
import AdminJobsWorkspace from './features/admin/operations/AdminJobsWorkspace.jsx'
import { bootstrapSessionFailure } from './features/auth/session-state.js'
import ContentWorkspace from './features/feed/ContentWorkspace.jsx'
import BrandMark from './components/BrandMark.jsx'
import ThemeToggle from './components/ThemeToggle.jsx'
import { useTheme } from './theme/use-theme.js'
import { useScrollToTop, useScrollTopVisibility } from './theme/use-scroll.js'

const api = createApiClient()

const ADMIN_DESTINATIONS = Object.freeze([
  { id: 'overview', label: 'Tổng quan' },
  { id: 'jobs', label: 'Jobs' },
  { id: 'articles', label: 'Articles & AI index' },
  { id: 'governance', label: 'Governance' },
  { id: 'sources', label: 'Source Registry' },
  { id: 'users', label: 'Người dùng' },
  { id: 'audit', label: 'Audit bất biến' },
  { id: 'account', label: 'Tài khoản' },
])
const ADMIN_INTERNAL_ROUTES = Object.freeze(new Set(['sources', 'account', 'deletions']))

const READER_TABS = Object.freeze([
  { id: 'feed', label: 'Feed' },
  { id: 'search', label: 'Tìm kiếm' },
  { id: 'saved', label: 'Đã lưu' },
  { id: 'qa', label: 'Hỏi đáp' },
  { id: 'account', label: 'Tài khoản' },
])

const TAB_ICONS = Object.freeze({
  feed: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true"><path d="M4 5h16M4 12h16M4 19h10" /></svg>,
  search: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true"><circle cx="11" cy="11" r="7" /><path d="M21 21l-4.3-4.3" /></svg>,
  saved: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true"><path d="M6 3h12a1 1 0 0 1 1 1v17l-7-4-7 4V4a1 1 0 0 1 1-1z" /></svg>,
  qa: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true"><path d="M21 12a8 8 0 0 1-11.6 7.1L4 21l1.9-5.4A8 8 0 1 1 21 12z" /></svg>,
  account: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true"><circle cx="12" cy="8" r="4" /><path d="M4 21c0-4 3.6-6 8-6s8 2 8 6" /></svg>,
})

const MARQUEE_BRANDS = Object.freeze([
  { text: 'VnExpress', inlineStyle: { fontWeight: 700, letterSpacing: '-0.02em', fontSize: 15 } },
  { text: 'ARXIV', inlineStyle: { fontWeight: 700, letterSpacing: '0.08em', fontSize: 13, textTransform: 'uppercase' } },
  { text: 'Hacker News', inlineStyle: { fontWeight: 600, fontStyle: 'italic', fontSize: 15 } },
  { text: 'TECHPULSE', inlineStyle: { fontWeight: 700, letterSpacing: '0.12em', fontSize: 13, textTransform: 'uppercase' } },
  { text: 'GitHub Blog', inlineStyle: { fontWeight: 500, letterSpacing: '-0.01em', fontSize: 16 } },
  { text: 'DZone', inlineStyle: { fontWeight: 600, letterSpacing: '0.04em', fontSize: 14 } },
  { text: 'DEV Community', inlineStyle: { fontWeight: 700, letterSpacing: '-0.03em', fontSize: 13 } },
])

const FEATURES = Object.freeze([
  {
    id: 'feed',
    title: 'Feed có nguồn rõ ràng',
    copy: 'Mỗi bài đều dẫn về nguồn nguyên bản. Chỉ bài published từ nguồn đang active mới xuất hiện.',
    icon: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20" /><path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z" /></svg>,
  },
  {
    id: 'summary',
    title: 'Summary tiếng Việt',
    copy: 'Tóm tắt gọn do AI tạo từ metadata hoặc excerpt, luôn gắn nhãn và dẫn về bài gốc.',
    icon: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M4 6h16M4 12h10M4 18h7" /></svg>,
  },
  {
    id: 'qa',
    title: 'Hỏi đáp có citation',
    copy: 'Trả lời theo đoạn với nguồn dẫn. Thiếu bằng chứng thì từ chối an toàn, không đoán.',
    icon: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M21 12a8 8 0 0 1-11.6 7.1L4 21l1.9-5.4A8 8 0 1 1 21 12z" /></svg>,
  },
  {
    id: 'search',
    title: 'Tìm kiếm hybrid',
    copy: 'Kết hợp từ khóa và ngữ nghĩa. Keyword vẫn chạy khi AI hoặc embedding tắt.',
    icon: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="11" cy="11" r="7" /><path d="M21 21l-4.3-4.3" /></svg>,
  },
])

export function AdminNavigation({ route, onNavigate }) {
  return (
    <nav className="side-nav" aria-label="Điều hướng quản trị">
      <span className="nav-label">Vận hành</span>
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

export function AdminMobileAccountNavigation({ route, onNavigate }) {
  const accountRoute = route === 'account'
  const sourceRoute = route === 'sources'
  return (
    <nav className="admin-mobile-account-nav" aria-label="Điều hướng quản trị mobile">
      <button
        className="admin-button"
        type="button"
        aria-current={sourceRoute ? 'page' : undefined}
        onClick={() => onNavigate?.('sources')}
      >
        Source Registry
      </button>
      <button
        className="admin-button"
        type="button"
        onClick={() => onNavigate?.(accountRoute ? 'overview' : 'account')}
      >
        {accountRoute ? 'Quay lại admin' : 'Tài khoản'}
      </button>
    </nav>
  )
}

export default function App() {
  const [theme, toggleTheme] = useTheme()
  const scrollTop = useScrollToTop()
  const scrollVisible = useScrollTopVisibility()
  const [health, setHealth] = useState({ status: 'loading', message: 'Đang kiểm tra API…' })
  const [session, setSession] = useState({ status: 'loading', user: null, csrfToken: null, error: null, notice: null })
  const [contentRoute, setContentRoute] = useState('feed')
  const [adminRoute, setAdminRoute] = useState('overview')
  const [adminNotice, setAdminNotice] = useState('')

  useEffect(() => {
    let active = true
    api
      .getHealth()
      .then((response) => {
        if (active) setHealth({ status: 'ok', message: `API sẵn sàng · ${response.data.timestamp}` })
      })
      .catch(() => {
        if (active) setHealth({ status: 'warning', message: 'API chưa phản hồi' })
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
    if (!destination && !ADMIN_INTERNAL_ROUTES.has(nextRoute)) return
    setAdminRoute(destination?.id ?? nextRoute)
    setAdminNotice(`Đang mở ${destination?.label ?? (nextRoute === 'deletions' ? 'Xóa tài khoản' : nextRoute === 'sources' ? 'Source Registry' : 'Tài khoản')}.`)
    if (typeof window === 'undefined') return
    window.requestAnimationFrame(() => {
      document.getElementById('main-content')?.focus({ preventScroll: true })
    })
  }

  const accountPanel = session.status === 'ready' ? <AuthAccount key={`${session.user?.id ?? 'guest'}:${session.csrfToken ?? 'none'}`} api={api} initialUser={session.user} initialCsrfToken={session.csrfToken} initialNotice={session.notice} onSession={applySession} /> : null
  const reader = session.status === 'ready' && session.user?.role === 'user'
  const admin = session.status === 'ready' && session.user?.role === 'admin'
  const guest = session.status === 'ready' && !session.user

  const readerContent = reader ? <ContentWorkspace generatedApi={api} csrfToken={session.csrfToken} route={contentRoute} onRouteChange={setContentRoute} accountPanel={accountPanel} onSessionExpired={(notice) => applySession(null, null, notice)} /> : null

  return (
    <>
      <a className="skip-link" href="#main-content">
        Bỏ qua điều hướng
      </a>

      {admin ? (
        <div className="app-layout admin-app-layout">
          <aside className="sidebar">
            <div className="brand">
              <BrandMark size={28} />
              TechPulse Admin
            </div>
            <AdminNavigation route={adminRoute} onNavigate={navigateAdmin} />
            <ThemeToggle theme={theme} onToggle={toggleTheme} />
            <div className="side-foot">
              <span className={`api-pill${health.status === 'warning' ? ' warn' : ''}`}><i aria-hidden="true" />{health.status === 'ok' ? 'API sẵn sàng' : health.status === 'warning' ? 'API chưa phản hồi' : 'Đang kiểm tra…'}</span>
              <span>CSRF trong memory · phiên no-store</span>
            </div>
          </aside>

          <div className="mobile-tabs" aria-label="Điều hướng quản trị trên thiết bị di động">
            {ADMIN_DESTINATIONS.map((destination) => (
              <button key={destination.id} className={adminRoute === destination.id ? 'active' : ''} type="button" aria-current={adminRoute === destination.id ? 'page' : undefined} onClick={() => navigateAdmin(destination.id)}>
                {destination.label}
              </button>
            ))}
          </div>

          <main id="main-content" tabIndex="-1" className="admin-main">
            <p className="sr-only" aria-hidden="true">{adminNotice}</p>
            <AdminMobileAccountNavigation route={adminRoute} onNavigate={navigateAdmin} />
            {adminRoute === 'account' ? accountPanel : null}
            {['overview', 'articles', 'governance', 'users', 'deletions', 'audit'].includes(adminRoute) ? <AdminOperations api={api} csrfToken={session.csrfToken} route={adminRoute} onNavigate={navigateAdmin} onSessionExpired={(notice) => applySession(null, null, notice)} /> : null}
            {adminRoute === 'jobs' ? <AdminJobsWorkspace api={api} csrfToken={session.csrfToken} onSessionExpired={(notice) => applySession(null, null, notice)} /> : null}
            {adminRoute === 'sources' ? <SourceRegistry api={api} csrfToken={session.csrfToken} onSessionExpired={(notice) => applySession(null, null, notice)} /> : null}
          </main>
        </div>
      ) : (
        <>
          <header className="topnav">
            <div className="topnav-inner">
              <button className="brand" type="button" aria-label="TechPulse AI" onClick={() => setContentRoute('feed')}>
                <BrandMark />
                TechPulse AI
              </button>
              {reader ? (
                <nav className="main-nav" aria-label="Điều hướng chính">
                  {READER_TABS.filter((tab) => tab.id !== 'account').map((tab) => (
                    <button key={tab.id} className={contentRoute === tab.id ? 'active' : ''} type="button" aria-current={contentRoute === tab.id ? 'page' : undefined} onClick={() => setContentRoute(tab.id)}>
                      {tab.label}
                    </button>
                  ))}
                </nav>
              ) : null}
              <div className="nav-right">
                <span className="status-pill" role="status" aria-live="polite"><i aria-hidden="true" />{health.message}</span>
                <ThemeToggle theme={theme} onToggle={toggleTheme} />
                {reader ? <button className="btn btn-ghost" type="button" onClick={() => setContentRoute('account')}>Demo</button> : null}
              </div>
            </div>
          </header>

          <main id="main-content" tabIndex="-1" className={reader ? 'app-shell' : 'main-guest'}>
            {session.status === 'loading' ? <section className="hero-card" aria-busy="true"><p>Đang khôi phục phiên…</p></section> : null}
            {session.status === 'error' ? (
              <section className="auth-card" aria-labelledby="session-recovery-title" role="alert">
                <div className="eyebrow">SESSION RECOVERY</div>
                <h1 id="session-recovery-title">Không thể khôi phục phiên.</h1>
                <p className="hero-copy">{session.error}</p>
                <button className="btn btn-primary" type="button" onClick={restoreSession}>Thử lại</button>
              </section>
            ) : null}
            {guest ? (
              <>
                <section className="hero">
                  <div className="container hero-inner">
                    <div>
                      <p className="eyebrow">TechPulse AI · Cho sinh viên CNTT &amp; lập trình viên</p>
                      <h1>Nắm nhanh công nghệ.<br />Biết rõ nguồn&nbsp;gốc.</h1>
                      <p className="lead">Tin công nghệ mỗi ngày, tóm tắt gọn bằng tiếng Việt — và mỗi câu trả lời của AI đều kèm bằng chứng, mở được bài gốc để kiểm chứng.</p>
                    </div>
                    {accountPanel}
                  </div>
                  <div className="container">
                    <div className="marquee" aria-hidden="true">
                      <div className="marquee-track">
                        {[...MARQUEE_BRANDS, ...MARQUEE_BRANDS].map((brand, index) => (
                          <span key={`${brand.text}-${index}`} style={{ ...brand.inlineStyle, display: 'inline-block' }}>{brand.text}</span>
                        ))}
                      </div>
                    </div>
                  </div>
                </section>
                <section className="section">
                  <div className="container">
                    <h2>TechPulse AI giúp bạn nắm nhanh công nghệ</h2>
                    <p>Bốn tính năng chính, xoay quanh một lời hứa: mỗi kết luận đều có nguồn, mỗi câu trả lời đều có bằng chứng.</p>
                    <div className="feature-grid">
                      {FEATURES.map((feature) => (
                        <div className="feature-card" key={feature.id} data-od-id={`feature-card-${feature.id}`}>
                          <span className="ic" aria-hidden="true">{feature.icon}</span>
                          <h3>{feature.title}</h3>
                          <p>{feature.copy}</p>
                        </div>
                      ))}
                    </div>
                  </div>
                </section>
              </>
            ) : null}
            {reader ? readerContent : null}
          </main>

          {reader ? (
            <nav className="mobile-nav" aria-label="Điều hướng di động">
              <div className="mobile-nav-inner">
                {READER_TABS.map((tab) => (
                  <button key={tab.id} className={contentRoute === tab.id ? 'active' : ''} type="button" aria-current={contentRoute === tab.id ? 'page' : undefined} onClick={() => setContentRoute(tab.id)}>
                    {TAB_ICONS[tab.id]}
                    {tab.label}
                  </button>
                ))}
              </div>
            </nav>
          ) : null}

          {guest ? (
            <footer className="foot">
              <div className="container">
                <span>© 2026 TechPulse AI</span>
              </div>
            </footer>
          ) : null}
        </>
      )}

      <button className={`scroll-top${scrollVisible ? ' show' : ''}`} type="button" aria-label="Về đầu trang" title="Về đầu trang" hidden={!scrollVisible} onClick={scrollTop}>
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true"><path d="M12 19V5M5 12l7-7 7 7" /></svg>
      </button>
    </>
  )
}
