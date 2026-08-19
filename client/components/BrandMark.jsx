const BRAND_PATH =
  'M128.005 191.173 C128.448 156.208 156.93 128 192 128 L192 64 L128 64 C128 99.346 99.346 128 64 128 L64 192 L128 192 Z M192 256 L64 256 C28.654 256 0 227.346 0 192 L0 64 L64 64 L64 0 L192 0 C227.346 0 256 28.654 256 64 L256 192 L192 192 Z'

/** The TechPulse brand mark (monochrome `currentColor` SVG). */
export default function BrandMark({ size = 30, className = 'brand-mark' }) {
  return (
    <span className={className} aria-hidden="true">
      <svg viewBox="0 0 256 256" fill="currentColor" width={size} height={size}>
        <path d={BRAND_PATH} />
      </svg>
    </span>
  )
}

export { BRAND_PATH }
