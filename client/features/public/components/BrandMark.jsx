export default function BrandMark({ size = 30 }) {
  return (
    <span
      className="public-brand-mark"
      aria-hidden="true"
      style={{ '--brand-mark-size': `${size}px` }}
    >
      <svg viewBox="0 0 256 256" fill="currentColor" focusable="false">
        <path d="M128.005 191.173C128.448 156.208 156.93 128 192 128V64h-64c0 35.346-28.654 64-64 64v64h64ZM192 256H64c-35.346 0-64-28.654-64-64V64h64V0h128c35.346 0 64 28.654 64 64v128c0 35.346-28.654 64-64 64Z" />
      </svg>
    </span>
  )
}
