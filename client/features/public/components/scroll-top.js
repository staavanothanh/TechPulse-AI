export function documentScrollRoot(documentRef = globalThis.document) {
  return documentRef?.scrollingElement || documentRef?.documentElement || documentRef?.body || null
}

export function scrollToDocumentTop({
  document: documentRef = globalThis.document,
  window: windowRef = globalThis,
  target = null,
  smooth = true,
  now: nowOverride,
  requestFrame: requestFrameOverride,
} = {}) {
  const roots = [documentScrollRoot(documentRef), documentRef?.documentElement, documentRef?.body]
  let ancestor = target?.parentElement || null
  while (ancestor) {
    roots.push(ancestor)
    ancestor = ancestor.parentElement || null
  }
  const uniqueRoots = roots.filter(
    (root, index, allRoots) => root && allRoots.indexOf(root) === index,
  )
  const currentTop = Math.max(
    Number(windowRef?.scrollY) || 0,
    ...uniqueRoots.map((root) => Number(root.scrollTop) || 0),
  )
  const requestFrame = requestFrameOverride || globalThis.requestAnimationFrame?.bind(globalThis)
  const now = nowOverride || (() => globalThis.performance?.now?.() ?? Date.now())

  function applyTop(top) {
    const options = { top, left: 0, behavior: 'instant' }
    for (const root of uniqueRoots) {
      root.scrollTo?.(options)
    }
    windowRef?.scrollTo?.(options)
    for (const root of uniqueRoots) {
      if ('scrollTop' in root) root.scrollTop = top
    }
  }

  if (!smooth || currentTop <= 0 || typeof requestFrame !== 'function') {
    applyTop(0)
    return
  }

  const startTime = now()
  const duration = 420
  function step(timestamp) {
    const progress = Math.min(1, Math.max(0, (timestamp - startTime) / duration))
    const eased = 1 - Math.pow(1 - progress, 3)
    applyTop(Math.round(currentTop * (1 - eased)))
    if (progress < 1) requestFrame(step)
  }
  requestFrame(step)
}
