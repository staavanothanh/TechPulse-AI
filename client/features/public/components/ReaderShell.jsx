import { useEffect, useState } from 'react'
import BrandMark from './BrandMark.jsx'
import ThemeToggle from './ThemeToggle.jsx'
import { documentScrollRoot, scrollToDocumentTop } from './scroll-top.js'
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

function ScrollToTopButton() {
  const [visible, setVisible] = useState(false)

  useEffect(() => {
    const updateVisibility = () => {
      const scrollRoot = documentScrollRoot()
      const scrollTop = scrollRoot?.scrollTop ?? globalThis.scrollY ?? 0
      setVisible(scrollTop >= 320)
    }
    const scrollRoot = documentScrollRoot()
    globalThis.addEventListener?.('scroll', updateVisibility, { passive: true })
    scrollRoot?.addEventListener?.('scroll', updateVisibility, { passive: true })
    updateVisibility()
    return () => {
      globalThis.removeEventListener?.('scroll', updateVisibility)
      scrollRoot?.removeEventListener?.('scroll', updateVisibility)
    }
  }, [])

  function scrollToTop(event) {
    const reducedMotion = globalThis.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches
    scrollToDocumentTop({
      target: event?.currentTarget,
      smooth: !reducedMotion,
    })
    setVisible(false)
  }

  return (
    <button
      className={`public-scroll-top${visible ? ' show' : ''}`}
      type="button"
      aria-label="Về đầu trang"
      title="Về đầu trang"
      hidden={!visible}
      onClick={scrollToTop}
    >
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
        <path d="M12 19V5M5 12l7-7 7 7" />
      </svg>
    </button>
  )
}

export default function ReaderShell({
  route = 'feed',
  onNavigate,
  theme = 'light',
  onThemeToggle,
  onBrandClick,
  onLogout,
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
      <ScrollToTopButton />
    </div>
  )
}
