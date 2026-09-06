export function runtimeFailure(code, message, retryable = false) {
  const error = new Error(message)
  error.code = code
  error.retryable = retryable
  return error
}

export function attachCleanupFailure(primary, cleanup) {
  const cleanupError = {
    code: typeof cleanup?.code === 'string' ? cleanup.code : 'runtime_cleanup_failed',
    ...(Number.isInteger(cleanup?.status) ? { status: cleanup.status } : {}),
  }
  if (primary && typeof primary === 'object') {
    try {
      primary.cleanupError = cleanupError
      return primary
    } catch {
      // Fall through when the primary error is not extensible.
    }
  }
  const wrapped = runtimeFailure('runtime_transaction_failed', 'Transaction failed and cleanup did not complete safely')
  wrapped.cause = primary
  wrapped.cleanupError = cleanupError
  return wrapped
}

export function monotonicNow() {
  return globalThis.performance?.now?.() ?? Date.now()
}

export function settleWithinGrace(operation, milliseconds, { onTimeout } = {}) {
  const waitMs = Math.max(0, Number(milliseconds))
  return new Promise((resolve) => {
    let settled = false
    let timer
    const finish = (result) => {
      if (settled) return
      settled = true
      globalThis.clearTimeout(timer)
      resolve(result)
    }
    timer = globalThis.setTimeout(() => {
      onTimeout?.()
      finish({ kind: 'grace', settled: false })
    }, waitMs)
    timer.unref?.()
    Promise.resolve(operation).then(
      (value) => finish({ kind: 'operation', settled: true, value }),
      (error) => finish({ kind: 'operation', settled: false, error }),
    )
  })
}

export function settleBeforeDeadline(operation, remainingMs, { onTimeout, onLate, timeoutError } = {}) {
  const promise = Promise.resolve(operation)
  const notifyLate = (result) => {
    if (typeof onLate !== 'function') return
    void Promise.resolve().then(() => onLate(result)).catch(() => {})
  }
  const waitMs = Math.max(0, Number(remainingMs))
  const createTimeoutError = typeof timeoutError === 'function'
    ? timeoutError
    : () => runtimeFailure('runtime_deadline_exceeded', 'Runtime execution deadline was exceeded')
  if (!Number.isFinite(waitMs)) {
    return promise.then(
      (value) => ({ kind: 'operation', settled: true, value }),
      (error) => ({ kind: 'operation', settled: false, error }),
    )
  }
  if (waitMs === 0) {
    const error = createTimeoutError()
    onTimeout?.(error)
    promise.then((value) => notifyLate({ kind: 'operation', settled: true, value }), (errorValue) => notifyLate({ kind: 'operation', settled: false, error: errorValue }))
    return Promise.resolve({ kind: 'deadline', settled: false, error })
  }
  return new Promise((resolve) => {
    let settled = false
    let timer
    const finish = (result) => {
      if (settled) return
      settled = true
      globalThis.clearTimeout(timer)
      resolve(result)
    }
    timer = globalThis.setTimeout(() => {
      const error = createTimeoutError()
      onTimeout?.(error)
      finish({ kind: 'deadline', settled: false, error })
    }, waitMs)
    timer.unref?.()
    promise.then(
      (value) => settled ? notifyLate({ kind: 'operation', settled: true, value }) : finish({ kind: 'operation', settled: true, value }),
      (error) => settled ? notifyLate({ kind: 'operation', settled: false, error }) : finish({ kind: 'operation', settled: false, error }),
    )
  })
}
