export function focusTrapTarget({ key, shiftKey, activeElement, focusables }) {
  if (key !== 'Tab' || !focusables?.length) return null
  const first = focusables[0]
  const last = focusables.at(-1)
  if (shiftKey && activeElement === first) return last
  if (!shiftKey && activeElement === last) return first
  return null
}
