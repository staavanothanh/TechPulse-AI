import BrandMark from './BrandMark.jsx'
import ThemeToggle from './ThemeToggle.jsx'

export default function PublicHeader({
  theme = 'light',
  onThemeToggle,
  onBrandClick,
  right = null,
  className = '',
}) {
  return (
    <header className={`public-topnav ${className}`.trim()} data-od-id="topnav">
      <div className="public-container public-topnav-inner">
        <button
          className="public-brand"
          type="button"
          aria-label="TechPulse AI"
          onClick={onBrandClick}
        >
          <BrandMark />
          <span>TechPulse AI</span>
        </button>
        <div className="public-nav-right">
          {right}
          <ThemeToggle theme={theme} onToggle={onThemeToggle} />
        </div>
      </div>
    </header>
  )
}
