export function createRequestSequence() {
  let current = 0
  return Object.freeze({
    start() { current += 1; return current },
    isCurrent(sequence) { return sequence === current },
    invalidate() { current += 1 },
  })
}

export async function runLatestRequest({ sequence, request, onSuccess, onError, propagate = false } = {}) {
  if (!sequence?.start || !sequence?.isCurrent || typeof request !== 'function') throw new Error('Request sequence and request are required')
  const ticket = sequence.start()
  try {
    const value = await request()
    if (!sequence.isCurrent(ticket)) return { current: false }
    onSuccess?.(value)
    return { current: true, value }
  } catch (error) {
    if (!sequence.isCurrent(ticket)) return { current: false }
    onError?.(error)
    if (propagate) throw error
    return { current: true, error }
  }
}
