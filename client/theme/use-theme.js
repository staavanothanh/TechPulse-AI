import { useCallback, useEffect, useState } from 'react'

export const THEME_STORAGE_KEY = 'techpulse-theme'

function initialTheme() {
  if (typeof window === 'undefined') return 'light'
  const stored = window.localStorage.getItem(THEME_STORAGE_KEY)
  if (stored === 'light' || stored === 'dark') return stored
  return window.matchMedia?.('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
}

/**
 * Apply the TechPulse theme to `document.documentElement[data-theme]`.
 * Returns [theme, toggleTheme] where theme is 'light' | 'dark'.
 */
export function useTheme() {
  const [theme, setTheme] = useState(initialTheme)

  useEffect(() => {
    const root = document.documentElement
    root.setAttribute('data-theme', theme)
    try {
      window.localStorage.setItem(THEME_STORAGE_KEY, theme)
    } catch {
      // localStorage may be unavailable (privacy mode); theme still applies.
    }
  }, [theme])

  const toggleTheme = useCallback(() => {
    setTheme((current) => (current === 'dark' ? 'light' : 'dark'))
  }, [])

  return [theme, toggleTheme]
}
