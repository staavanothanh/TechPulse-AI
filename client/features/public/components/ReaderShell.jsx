import BrandMark from './BrandMark.jsx'
import ThemeToggle from './ThemeToggle.jsx'
import { READER_NAV } from '../navigation.js'

function Navigation({ route, onNavigate, mobile = false }) {
  return (
    <nav
      className={mobile ? 'public-mobile-nav' : 'public-main-nav'}
      aria-label={mobile ? 'Điều hướng di động' : 'Điều hướng chính'}
    >
      {READER_NAV.map((item) => {
        const active = item.id === route
        return (
          <button
            key={item.id}
            className={active ? 'active' : ''}
            type="button"
            aria-current={active ? 'page' : undefined}
            onClick={() => onNavigate?.(item.id)}
          >
            {mobile ? item.mobileLabel : item.label}
          </button>
        )
      })}
    </nav>
  )
}

export default function ReaderShell({
  route = 'feed',
  onNavigate,
  theme = 'light',
  onThemeToggle,
  onBrandClick,
  onLogout,
  status = null,
  children,
}) {
  return (
    <div className="public-page public-reader" data-theme={theme}>
      <header className="public-topnav public-reader-nav" data-od-id="topnav">
        <div className="public-reader-nav-inner">
          <button
            className="public-brand"
            type="button"
            aria-label="TechPulse AI"
            onClick={onBrandClick}
          >
            <BrandMark />
            <span>TechPulse AI</span>
          </button>
          <Navigation route={route} onNavigate={onNavigate} />
          <div className="public-nav-right">
            {status ? (
              <span className="public-status-pill" role="status" aria-live="polite">
                {status}
              </span>
            ) : null}
            <ThemeToggle theme={theme} onToggle={onThemeToggle} />
            {onLogout ? (
              <button
                className="public-btn public-btn-ghost public-account-action"
                type="button"
                onClick={onLogout}
              >
                Đăng xuất
              </button>
            ) : null}
          </div>
        </div>
      </header>
      <div className="public-reader-content">{children}</div>
      <Navigation route={route} onNavigate={onNavigate} mobile />
    </div>
  )
}
