import { describe, expect, it } from 'vitest'
import { createRequestSequence, runLatestRequest } from '../../client/features/admin/request-sequence.js'

function deferred() {
  let resolve
  let reject
  const promise = new Promise((nextResolve, nextReject) => { resolve = nextResolve; reject = nextReject })
  return { promise, resolve, reject }
}

describe('admin request sequencing', () => {
  it('rejects a reverse-order initial response after a newer manual reload begins', () => {
    const sequence = createRequestSequence()
    const initial = sequence.start()
    const manualReload = sequence.start()
    expect(sequence.isCurrent(initial)).toBe(false)
    expect(sequence.isCurrent(manualReload)).toBe(true)
    sequence.invalidate()
    expect(sequence.isCurrent(manualReload)).toBe(false)
  })

  it('ignores a stale reload rejection after a newer reload succeeds, including session-expiry handling', async () => {
    const sequence = createRequestSequence()
    const first = deferred()
    const second = deferred()
    const success = []
    const failures = []
    const firstReload = runLatestRequest({
      sequence,
      request: () => first.promise,
      onSuccess: (value) => success.push(value),
      onError: (error) => failures.push(error),
    })
    const secondReload = runLatestRequest({
      sequence,
      request: () => second.promise,
      onSuccess: (value) => success.push(value),
      onError: (error) => failures.push(error),
    })
    second.resolve('latest')
    await expect(secondReload).resolves.toEqual(expect.objectContaining({ current: true, value: 'latest' }))
    first.reject({ status: 401 })
    await expect(firstReload).resolves.toEqual({ current: false })
    expect(success).toEqual(['latest'])
    expect(failures).toEqual([])
  })
})
