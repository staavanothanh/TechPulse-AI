export default function ThemeToggle({ theme = 'light', onToggle }) {
  const dark = theme === 'dark'
  return (
    <button
      className="public-theme-toggle"
      type="button"
      aria-label="Chuyển chế độ sáng hoặc tối"
      aria-pressed={dark}
      onClick={() => onToggle?.(dark ? 'light' : 'dark')}
    >
      <span aria-hidden="true">{dark ? '☼' : '◐'}</span>
      <span>{dark ? 'Sáng' : 'Tối'}</span>
    </button>
  )
}
