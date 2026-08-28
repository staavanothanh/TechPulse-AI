import { useEffect, useLayoutEffect, useRef } from 'react'
import { useLocation, useNavigationType } from 'react-router-dom'

/**
 * Pure in-memory storage for scroll positions: locationKey -> { left: number, top: number }
 * Strictly uses in-memory Map; zero browser persistent storage APIs used.
 */
const scrollPositions = new Map()

export function getSavedScrollPosition(key) {
  return scrollPositions.get(key) || null
}

export function clearScrollPositions() {
  scrollPositions.clear()
}

export function InMemoryScrollRestoration({ targetRef } = {}) {
  const location = useLocation()
  const navigationType = useNavigationType()
  const currentKeyRef = useRef(location.key)

  const savePosition = (key) => {
    if (!key) return
    const el =
      targetRef?.current ||
      (typeof document !== 'undefined'
        ? document.scrollingElement || document.documentElement
        : null)
    const left = targetRef?.current
      ? targetRef.current.scrollLeft
      : typeof window !== 'undefined'
        ? window.scrollX
        : 0
    const top = targetRef?.current
      ? targetRef.current.scrollTop
      : (el?.scrollTop ?? (typeof window !== 'undefined' ? window.scrollY : 0))
    scrollPositions.set(key, { left, top })
  }

  // Outgoing page position is captured in useLayoutEffect cleanup BEFORE any scrollTo(0,0)
  useLayoutEffect(() => {
    if (typeof window === 'undefined') return undefined

    if (navigationType === 'POP') {
      const saved = scrollPositions.get(location.key)
      if (saved) {
        if (targetRef?.current) {
          targetRef.current.scrollTo({ left: saved.left, top: saved.top, behavior: 'instant' })
        } else {
          window.scrollTo({ left: saved.left, top: saved.top, behavior: 'instant' })
        }
      }
    } else {
      // PUSH or REPLACE: scroll to top
      if (targetRef?.current) {
        targetRef.current.scrollTo({ left: 0, top: 0, behavior: 'instant' })
      } else {
        window.scrollTo({ left: 0, top: 0, behavior: 'instant' })
      }
    }

    return () => {
      savePosition(location.key)
    }
  }, [location.key, navigationType, targetRef])

  // Continuous scroll tracking during user interaction
  useEffect(() => {
    currentKeyRef.current = location.key

    const handleScroll = () => {
      savePosition(currentKeyRef.current)
    }

    if (typeof window !== 'undefined') {
      window.addEventListener('scroll', handleScroll, { passive: true })
    }

    return () => {
      if (typeof window !== 'undefined') {
        window.removeEventListener('scroll', handleScroll)
      }
    }
  }, [location.key, targetRef])

  return null
}
