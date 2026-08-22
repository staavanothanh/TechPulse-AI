import { describe, expect, it, vi } from 'vitest'
import {
  acquireAdminResourceRequest,
  clearAdminResourceCache,
  invalidateAdminResourceCache,
} from '../../client/features/admin/ui/admin-data.js'

function createApi(response = { data: [], meta: { hasNext: false } }) {
  return {
    listAdminUsers: vi.fn(({ fetchImpl, signal }) =>
      fetchImpl('https://techpulse.test/api/v1/admin/users', { signal }).then((response) =>
        response.json(),
      ),
    ),
    response,
  }
}

describe('admin resource request cache', () => {
  it('deduplicates an in-flight request and stores one session-scoped result', async () => {
    const scope = {}
    const api = createApi()
    const fetchImpl = vi.fn(async (_input, requestInit) => {
      expect(requestInit.signal).toBeInstanceOf(globalThis.AbortSignal)
      return {
        ok: true,
        status: 200,
        headers: { get: () => null },
        json: async () => api.response,
      }
    })

    const first = acquireAdminResourceRequest({
      scope,
      api,
      operation: 'listAdminUsers',
      query: { status: 'active' },
      fetchImpl,
    })
    const second = acquireAdminResourceRequest({
      scope,
      api,
      operation: 'listAdminUsers',
      query: { status: 'active' },
      fetchImpl,
    })

    expect(api.listAdminUsers).toHaveBeenCalledTimes(1)
    expect(fetchImpl).toHaveBeenCalledTimes(1)
    await expect(first.promise).resolves.toEqual(api.response)
    await expect(second.promise).resolves.toEqual(api.response)
    first.release()
    second.release()

    const cached = acquireAdminResourceRequest({
      scope,
      api,
      operation: 'listAdminUsers',
      query: { status: 'active' },
      fetchImpl,
    })
    expect(cached.cached).toBe(true)
    expect(fetchImpl).toHaveBeenCalledTimes(1)
    await expect(cached.promise).resolves.toEqual(api.response)
    cached.release()
  })

  it('aborts the underlying request when all subscribers release it', async () => {
    const scope = {}
    const api = createApi()
    let rejectRequest
    const fetchImpl = vi.fn((_input, requestInit) => {
      return new Promise((resolve, reject) => {
        rejectRequest = reject
        requestInit.signal.addEventListener('abort', () => {
          const error = new Error('aborted')
          error.name = 'AbortError'
          reject(error)
        })
      })
    })
    const request = acquireAdminResourceRequest({
      scope,
      api,
      operation: 'listAdminUsers',
      fetchImpl,
    })

    request.release()
    expect(request.signal.aborted).toBe(true)
    await expect(request.promise).rejects.toMatchObject({ name: 'AbortError' })
    expect(rejectRequest).toBeTypeOf('function')
  })

  it('invalidates all query variants for one operation without touching another session', async () => {
    const scope = {}
    const otherScope = {}
    const api = createApi()
    const otherApi = createApi()
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      status: 200,
      headers: { get: () => null },
      json: async () => ({ data: [], meta: { hasNext: false } }),
    }))

    for (const status of ['active', 'suspended']) {
      const request = acquireAdminResourceRequest({
        scope,
        api,
        operation: 'listAdminUsers',
        query: { status },
        fetchImpl,
      })
      await request.promise
      request.release()
    }
    const other = acquireAdminResourceRequest({
      scope: otherScope,
      api: otherApi,
      operation: 'listAdminUsers',
      query: { status: 'active' },
      fetchImpl,
    })
    await other.promise
    other.release()
    expect(fetchImpl).toHaveBeenCalledTimes(3)

    invalidateAdminResourceCache(scope, { operation: 'listAdminUsers' })
    const activeAgain = acquireAdminResourceRequest({
      scope,
      api,
      operation: 'listAdminUsers',
      query: { status: 'active' },
      fetchImpl,
    })
    await activeAgain.promise
    activeAgain.release()
    const otherAgain = acquireAdminResourceRequest({
      scope: otherScope,
      api: otherApi,
      operation: 'listAdminUsers',
      query: { status: 'active' },
      fetchImpl,
    })
    expect(otherAgain.cached).toBe(true)
    await otherAgain.promise
    otherAgain.release()
    expect(fetchImpl).toHaveBeenCalledTimes(4)
  })

  it('clears one session without affecting a different session', () => {
    const scope = {}
    const otherScope = {}
    clearAdminResourceCache(scope)
    clearAdminResourceCache(otherScope)
  })
})
