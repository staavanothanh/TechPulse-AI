import { useEffect, useRef } from 'react'

const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), textarea:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])'

export function dialogFocusAction({ key, shiftKey = false, activeElement, focusables = [], fallbackTarget } = {}) {
  if (key === 'Escape') return { type: 'close' }
  if (key !== 'Tab') return null
  if (focusables.length === 0) return fallbackTarget ? { type: 'focus', target: fallbackTarget } : null
  if (!shiftKey && activeElement === focusables.at(-1)) return { type: 'focus', target: focusables[0] }
  if (shiftKey && activeElement === focusables[0]) return { type: 'focus', target: focusables.at(-1) }
  return null
}

export function useDialogFocus(open, onClose) {
  const dialogRef = useRef(null)
  const returnFocusRef = useRef(null)

  useEffect(() => {
    if (!open) return undefined
    returnFocusRef.current = document.activeElement?.focus ? document.activeElement : null
    const dialog = dialogRef.current
    const focusables = () => [...(dialog?.querySelectorAll(FOCUSABLE) ?? [])].filter((element) => typeof element?.focus === 'function')
    const first = focusables()[0] ?? dialog
    first?.focus?.()
    const onKeyDown = (event) => {
      const action = dialogFocusAction({ key: event.key, shiftKey: event.shiftKey, activeElement: document.activeElement, focusables: focusables(), fallbackTarget: dialog })
      if (!action) return
      event.preventDefault()
      if (action.type === 'close') onClose?.()
      else action.target.focus()
    }
    dialog?.addEventListener('keydown', onKeyDown)
    return () => {
      dialog?.removeEventListener('keydown', onKeyDown)
      returnFocusRef.current?.focus?.()
    }
  }, [open, onClose])

  return dialogRef
}
