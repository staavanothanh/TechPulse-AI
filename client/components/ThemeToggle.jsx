import BrandMark from './BrandMark.jsx'

const ICON_MOON = (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true"><path d="M20.5 14.5A8.5 8.5 0 0 1 9.5 3.5a8.5 8.5 0 1 0 11 11z" /></svg>
)
const ICON_SUN = (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true"><circle cx="12" cy="12" r="4.5" /><path d="M12 2v2.5M12 19.5V22M2 12h2.5M19.5 12H22M4.6 4.6l1.8 1.8M17.6 17.6l1.8 1.8M19.4 4.6l-1.8 1.8M6.4 17.6l-1.8 1.8" /></svg>
)

/** Pill theme toggle; label announces the *target* theme ("Sáng" when dark). */
export default function ThemeToggle({ theme, onToggle, className = 'theme-toggle', showLabel = true }) {
  const target = theme === 'dark' ? 'Sáng' : 'Tối'
  return (
    <button
      className={className}
      type="button"
      aria-label="Chuyển chế độ sáng/tối"
      title="Chế độ sáng/tối"
      aria-pressed={theme === 'dark'}
      onClick={onToggle}
    >
      <span className="icon-moon">{ICON_MOON}</span>
      <span className="icon-sun">{ICON_SUN}</span>
      {showLabel ? <span className="theme-label">{target}</span> : null}
    </button>
  )
}

export { BrandMark }
