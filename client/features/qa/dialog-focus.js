import { useEffect, useRef } from 'react'

const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), textarea:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])'

export function dialogFocusAction({ key, shiftKey = false, activeElement, focusables = [], fallbackTarget } = {}) {
  if (key === 'Escape') return { type: 'close' }
  if (key !== 'Tab') return null
  if (focusables.length === 0) return fallbackTarget ? { type: 'focus', target: fallbackTarget } : null
  const first = focusables[0]
  const last = focusables.at(-1)
  if (!focusables.includes(activeElement)) return { type: 'focus', target: shiftKey ? last : first }
  if (!shiftKey && activeElement === last) return { type: 'focus', target: first }
  if (shiftKey && activeElement === first) return { type: 'focus', target: last }
  return null
}

export function bindDialogFocus(eventTarget, { getActiveElement, getFocusables, fallbackTarget, onClose } = {}) {
  const onKeyDown = (event) => {
    const action = dialogFocusAction({
      key: event.key,
      shiftKey: event.shiftKey,
      activeElement: getActiveElement?.(),
      focusables: getFocusables?.() ?? [],
      fallbackTarget,
    })
    if (!action) return
    event.preventDefault()
    if (action.type === 'close') onClose?.()
    else action.target?.focus?.()
  }
  eventTarget?.addEventListener?.('keydown', onKeyDown, true)
  return () => eventTarget?.removeEventListener?.('keydown', onKeyDown, true)
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
    const unbindKeyboard = bindDialogFocus(document, {
      getActiveElement: () => document.activeElement,
      getFocusables: focusables,
      fallbackTarget: dialog,
      onClose,
    })
    return () => {
      unbindKeyboard()
      returnFocusRef.current?.focus?.()
    }
  }, [open, onClose])

  return dialogRef
}
