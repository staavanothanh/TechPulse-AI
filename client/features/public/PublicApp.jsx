import LandingPage from './components/LandingPage.jsx'
import ReaderShell from './components/ReaderShell.jsx'
import {
  AccountView,
  ArticleView,
  DonateView,
  FeedView,
  QaView,
  SavedView,
  SearchView,
} from './views/ReaderViews.jsx'
import './public.css'

const ROUTES = new Set(['feed', 'search', 'saved', 'article', 'qa', 'account', 'donate'])

function SessionLoading() {
  return (
    <div className="public-page public-session-state" aria-busy="true">
      <div className="public-container">
        <div className="public-skeleton" aria-label="Đang khôi phục phiên">
          <span />
          <span />
          <span />
        </div>
      </div>
    </div>
  )
}

function SessionError({ error, onRetry }) {
  return (
    <div className="public-page public-session-state">
      <div className="public-container">
        <section className="public-state-card" role="alert">
          <p className="public-eyebrow">Khôi phục phiên</p>
          <h1>Không thể khôi phục phiên.</h1>
          <p>
            {typeof error === 'string'
              ? error
              : error?.message || 'Thử lại để kiểm tra phiên đăng nhập.'}
          </p>
          <button className="public-btn public-btn-primary" type="button" onClick={onRetry}>
            Thử lại
          </button>
        </section>
      </div>
    </div>
  )
}

function activeView(route, props) {
  if (route === 'search') return <SearchView {...props} />
  if (route === 'saved') return <SavedView {...props} />
  if (route === 'article') return <ArticleView {...props} />
  if (route === 'qa') return <QaView {...props} />
  if (route === 'donate') return <DonateView {...props} />
  if (route === 'account') return <AccountView {...props} />
  return <FeedView {...props} />
}

export default function PublicApp({
  session = { status: 'ready', user: null },
  route = 'feed',
  theme = 'light',
  onThemeToggle,
  onNavigate,
  onBrandClick,
  onLogout,
  onRetrySession,
  onSessionExpired,
  onAuthSubmit,
  onAuthModeChange,
  onGuestBrowse,
  auth = {},
  api,
  csrfToken,
  feed = {},
  search = {},
  saved = {},
  article = {},
  qa = {},
  account = {},
}) {
  if (session?.status === 'loading') return <SessionLoading />
  if (session?.status === 'error')
    return <SessionError error={session.error} onRetry={onRetrySession} />

  const user = session?.user || null
  if (!user) {
    return (
      <LandingPage
        theme={theme}
        onThemeToggle={onThemeToggle}
        onBrandClick={onBrandClick}
        auth={{
          ...auth,
          onSubmit: auth.onSubmit || onAuthSubmit,
          onModeChange: auth.onModeChange || onAuthModeChange,
        }}
        onGuestBrowse={onGuestBrowse}
      />
    )
  }

  const safeRoute = ROUTES.has(route) ? route : 'feed'
  const shared = { api, csrfToken, onSessionExpired, onNavigate }
  const viewProps = {
    feed: { ...feed, ...shared },
    search: { ...search, ...shared },
    saved: { ...saved, ...shared },
    article: { ...article, ...shared },
    qa: { ...qa, ...shared },
    donate: { ...shared },
    account: { ...account, user, ...shared },
  }
  return (
    <ReaderShell
      route={safeRoute}
      onNavigate={onNavigate}
      theme={theme}
      onThemeToggle={onThemeToggle}
      onBrandClick={onBrandClick}
      onLogout={onLogout}
    >
      {activeView(safeRoute, viewProps[safeRoute])}
    </ReaderShell>
  )
}

export { SessionError, SessionLoading, ROUTES }
