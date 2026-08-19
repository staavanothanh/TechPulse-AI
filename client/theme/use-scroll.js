import { useCallback, useEffect, useRef, useState } from 'react'

/** Shared scroll-to-top: rAF-based 420ms cubic-out, instant when reduced motion. */
export function useScrollToTop() {
  const scrollTop = useCallback(() => {
    if (typeof window === 'undefined') return
    const reduce = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches
    const scroller = document.scrollingElement || document.documentElement
    const start = scroller.scrollTop
    if (!reduce && start > 0) {
      const duration = 420
      const startTime = performance.now()
      const step = (now) => {
        const progress = Math.min(1, (now - startTime) / duration)
        const eased = 1 - Math.pow(1 - progress, 3)
        scroller.scrollTop = Math.round(start * (1 - eased))
        if (progress < 1) requestAnimationFrame(step)
      }
      requestAnimationFrame(step)
    } else {
      window.scrollTo(0, 0)
    }
  }, [])
  return scrollTop
}

/** Show a floating scroll-top control once the page passes `threshold` px. */
export function useScrollTopVisibility(threshold = 320) {
  const [visible, setVisible] = useState(false)
  useEffect(() => {
    if (typeof window === 'undefined') return undefined
    const update = () => {
      const scroller = document.scrollingElement || document.documentElement
      setVisible(scroller.scrollTop >= threshold)
    }
    window.addEventListener('scroll', update, { passive: true })
    update()
    return () => window.removeEventListener('scroll', update)
  }, [threshold])
  return visible
}

/** Auto-grow a textarea from a min height up to a cap (then scrolls internally). */
export function useAutoGrow(minHeight = 56, cap = 220) {
  const ref = useRef(null)
  const resize = useCallback(() => {
    const node = ref.current
    if (!node) return
    node.style.height = 'auto'
    node.style.height = `${Math.min(Math.max(node.scrollHeight, minHeight), cap)}px`
  }, [minHeight, cap])
  useEffect(resize, [resize])
  return [ref, resize]
}
