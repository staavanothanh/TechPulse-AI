import React from 'react'
import { describe, expect, it, vi } from 'vitest'
import {
  OVERVIEW_METRICS,
  acquireAdminResourceRequest,
  aggregateDueWorkCounters,
  allowlistedQuery,
  artifactJobRequest,
  clearAdminResourceCache,
  createIdempotencyKey,
  createIdempotencyKeyStore,
  formatAdminDate,
  invalidateAdminResourceCache,
  isAbortError,
  isAdminJobRetryable,
  isSessionExpired,
  listItems,
  listMeta,
  mutateAdmin,
  normalizeDueWorkRun,
  readAdmin,
  readResponseData,
  safeAdminError,
  safeTopics,
  stableQueryKey,
  statusLabel,
  statusTone,
  useAdminResource,
} from '../../client/features/admin/ui/admin-data.js'

const response = (data, headers = new Map()) => ({
  data,
  headers: { get: (name) => headers.get(name) },
})

function fetchResponse(data = { ok: true }) {
  return { ok: true, json: vi.fn(async () => data), headers: { get: vi.fn(() => null) } }
}

function createHookRunner(hookFn) {
  let hookIdx = 0
  const hooks = []
  const effectCleanups = []
  let pendingEffects = []
  let rerenderPending = false
  let rendering = false
  let disposed = false

  const dispatcher = {
    useState(initial) {
      const idx = hookIdx++
      if (hooks[idx] === undefined) hooks[idx] = typeof initial === 'function' ? initial() : initial
      const setState = (next) => {
        if (disposed) return
        const val = typeof next === 'function' ? next(hooks[idx]) : next
        if (Object.is(hooks[idx], val)) return
        hooks[idx] = val
        if (rendering) {
          rerenderPending = true
          return
        }
        render()
      }
      return [hooks[idx], setState]
    },
    useRef(initial) {
      const idx = hookIdx++
      if (hooks[idx] === undefined) hooks[idx] = { current: initial }
      return hooks[idx]
    },
    useCallback(fn, deps) {
      const idx = hookIdx++
      const previous = hooks[idx]
      if (previous && deps && previous.deps.every((value, index) => Object.is(value, deps[index]))) return previous.fn
      hooks[idx] = { fn, deps }
      return fn
    },
    useMemo(fn, deps) {
      const idx = hookIdx++
      const previous = hooks[idx]
      if (previous && deps && previous.deps.every((value, index) => Object.is(value, deps[index]))) return previous.value
      const value = fn()
      hooks[idx] = { value, deps }
      return value
    },
    useEffect(effect, deps) {
      const idx = hookIdx++
      const previous = hooks[idx]
      const changed = !previous || !deps || !previous.deps || !previous.deps.every((value, index) => Object.is(value, deps[index]))
      hooks[idx] = { deps }
      if (changed) pendingEffects.push({ idx, effect })
    },
  }

  let currentProps
  let latestResult
  function render(props = currentProps) {
    if (disposed) return latestResult
    currentProps = props
    do {
      rerenderPending = false
      hookIdx = 0
      pendingEffects = []
      rendering = true
      try {
        const internals = React.__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE
        const previous = internals.H
        internals.H = dispatcher
        try {
          latestResult = hookFn(currentProps, dispatcher)
        } finally {
          internals.H = previous
        }
        const effects = pendingEffects
        pendingEffects = []
        for (const { idx, effect } of effects) {
          effectCleanups[idx]?.()
          const cleanup = effect()
          effectCleanups[idx] = typeof cleanup === 'function' ? cleanup : undefined
        }
      } finally {
        rendering = false
      }
    } while (rerenderPending && !disposed)
    return latestResult
  }
  function unmount() {
    if (disposed) return
    disposed = true
    rerenderPending = false
    pendingEffects = []
    for (const cleanup of effectCleanups) cleanup?.()
    effectCleanups.length = 0
  }
  return { render, unmount, get current() { return latestResult } }
}
describe('admin-data helpers and cache requests', () => {
  it('queues effect state updates until cleanup registration completes', () => {
    const events = []
    const runner = createHookRunner((_, dispatcher) => {
      const [value, setValue] = dispatcher.useState(0)
      dispatcher.useEffect(() => {
        events.push(`effect:${value}`)
        if (value === 0) setValue(1)
        return () => events.push(`cleanup:${value}`)
      }, [value])
      return value
    })

    expect(runner.render()).toBe(1)
    runner.unmount()
    expect(events).toEqual(['effect:0', 'cleanup:0', 'effect:1', 'cleanup:1'])
  })
  it('normalizes due-work payloads and aggregates bounded counters', () => {
    const run = normalizeDueWorkRun({
      data: {
        runId: 'run-1',
        startedAt: 'start',
        finishedAt: 'finish',
        nextAvailableAt: 'next',
        queues: {
          ingestion: { claimed: 2, failed: -1 },
          indexing: { succeeded: 3 },
          accountDeletion: { deferred: 4 },
        },
        recovery: { inspected: 5, recovered: 'bad' },
      },
    })
    expect(run.queues.ingestion).toEqual({
      claimed: 2,
      succeeded: 0,
      partial: 0,
      failed: 0,
      deferred: 0,
    })
    expect(run.recovery).toEqual({ inspected: 5, recovered: 0, retriesCreated: 0, failed: 0 })
    expect(
      aggregateDueWorkCounters({
        queues: {
          ingestion: { claimed: 1 },
          indexing: { claimed: 2 },
          accountDeletion: { failed: 3 },
        },
      }),
    ).toEqual({ claimed: 3, succeeded: 0, partial: 0, failed: 3, deferred: 0 })
    expect(normalizeDueWorkRun(null).queues.accountDeletion.failed).toBe(0)
  })

  it('builds artifact and due-work requests with retryable-job decisions', async () => {
    expect(artifactJobRequest('summary')).toEqual({
      operation: 'createSummaryJob',
      body: { reasonCode: 'artifact_regeneration_requested' },
    })
    expect(artifactJobRequest('embedding')).toEqual({
      operation: 'createIndexingJob',
      body: { task: 'embedding', reasonCode: 'artifact_regeneration_requested' },
    })
    expect(isAdminJobRetryable({ status: 'partial', attempt: 2 })).toBe(true)
    expect(isAdminJobRetryable({ status: 'failed', attempt: 2, error: { retryable: true } })).toBe(
      true,
    )
    expect(isAdminJobRetryable({ status: 'failed', attempt: 2 })).toBe(false)
    expect(isAdminJobRetryable({ status: 'failed', attempt: 3, error: { retryable: true } })).toBe(
      false,
    )
    const api = { runAdminDueWork: vi.fn(async () => ({ ok: true })) }
    await expect(
      (await import('../../client/features/admin/ui/admin-data.js')).runAdminDueWork(api, {
        csrfToken: 'csrf',
      }),
    ).resolves.toEqual({ ok: true })
  })

  it('normalizes response shapes, allowlists queries and formats statuses', () => {
    expect(readResponseData({ data: { value: 1 } })).toEqual({ value: 1 })
    expect(readResponseData({ value: 1 })).toEqual({ value: 1 })
    expect(readResponseData(null)).toBeNull()
    expect(listItems({ data: [1, 2] })).toEqual([1, 2])
    expect(listItems({ data: { data: [3] } })).toEqual([3])
    expect(listItems({})).toEqual([])
    expect(listMeta({ meta: { hasNext: true } })).toEqual({ hasNext: true })
    expect(listMeta({ data: { meta: { nextCursor: 'x' } } })).toEqual({ nextCursor: 'x' })
    expect(
      allowlistedQuery('listSources', {
        operationalStatus: 'active',
        limit: 10,
        password: 'secret',
        cursor: null,
      }),
    ).toEqual({ operationalStatus: 'active', limit: '10' })
    expect(stableQueryKey({ b: '2', a: '1', empty: '' })).toBe(stableQueryKey({ a: '1', b: '2' }))
    expect(formatAdminDate()).toBe('Chưa ghi nhận')
    expect(formatAdminDate('bad-date')).toBe('Không xác định')
    expect(formatAdminDate('2026-08-20T08:00:00.000Z')).toContain('2026')
    expect(statusLabel('running')).toBe('Đang chạy')
    expect(statusLabel('unknown')).toBe('unknown')
    expect(statusLabel(null)).toBe('Chưa xác định')
    expect(statusTone('failed')).toBe('danger')
    expect(statusTone('reviewing')).toBe('warning')
    expect(statusTone('published')).toBe('success')
    expect(statusTone('processing')).toBe('accent')
    expect(statusTone('other')).toBe('muted')
    expect(OVERVIEW_METRICS.length).toBeGreaterThan(5)
  })

  it('handles canonical error and idempotency utilities', () => {
    expect(safeAdminError({ status: 401 })).toContain('hết hạn')
    expect(safeAdminError({ status: 503 })).toContain('sẵn sàng')
    expect(safeAdminError({ status: 418 })).toContain('hoàn tất')
    expect(isSessionExpired({ status: 401 })).toBe(true)
    expect(isSessionExpired({ status: 403 })).toBe(false)
    const store = createIdempotencyKeyStore()
    const first = createIdempotencyKey('intent', store)
    expect(first).toMatch(/^admin-intent-/)
    expect(createIdempotencyKey('intent', store)).toBe(first)
    expect(store.delete('intent')).toBe(true)
    expect(store.get('intent')).toBeUndefined()
    store.set('a', 'b')
    store.clear()
    expect(store.get('a')).toBeUndefined()
    expect(createIdempotencyKey('no-store')).toMatch(/^admin-no-store-/)
    expect(safeTopics(['a', 1, 'b']).length).toBe(2)
    expect(safeTopics('not-array')).toEqual([])
  })

  it('reads admin operations with query encoding and retry-after propagation', async () => {
    const fetchImpl = vi.fn(async (url) => fetchResponse({ url: String(url) }))
    const api = {
      listSources: vi.fn(async ({ fetchImpl: request }) =>
        request('https://example.test/admin/sources'),
      ),
    }
    const result = await readAdmin(
      api,
      'listSources',
      { query: { limit: 2, operationalStatus: 'active' } },
      fetchImpl,
    )
    expect(result.ok).toBe(true)
    expect(String(fetchImpl.mock.calls[0][0])).toContain('limit=2')
    expect(String(fetchImpl.mock.calls[0][0])).toContain('operationalStatus=active')
    await expect(readAdmin({}, 'listSources')).rejects.toMatchObject({ status: 503 })

    const retryError = new Error('busy')
    const retryApi = {
      listSources: vi.fn(async ({ fetchImpl: request }) => {
        await request('https://example.test/admin/sources')
        throw retryError
      }),
    }
    const retryFetch = vi.fn(async () => ({ headers: { get: () => '12' } }))
    await expect(readAdmin(retryApi, 'listSources', {}, retryFetch)).rejects.toMatchObject({
      retryAfter: 12,
    })
    const frozenError = Object.freeze(new Error('frozen'))
    const frozenApi = {
      listSources: vi.fn(async ({ fetchImpl: request }) => {
        await request('https://example.test/admin/sources')
        throw frozenError
      }),
    }
    await expect(readAdmin(frozenApi, 'listSources', {}, retryFetch)).rejects.toBe(frozenError)
    expect(isAbortError({ name: 'AbortError' })).toBe(true)
    expect(isAbortError({ code: 'ABORT_ERR' })).toBe(true)
    expect(isAbortError({ code: 'other' })).toBe(false)
  })

  it('mutates admin operations with CSRF and retry-safe idempotency keys', async () => {
    const method = vi.fn(async (input) => ({ ok: true, input }))
    const api = { update: method }
    const store = createIdempotencyKeyStore()
    const result = await mutateAdmin(api, 'update', {
      csrfToken: 'csrf',
      pathParams: { id: '1' },
      body: { status: 'active' },
      idempotencyIntent: 'update:1',
      idempotencyStore: store,
    })
    expect(result.input.headers).toEqual(
      expect.objectContaining({
        'X-CSRF-Token': 'csrf',
        'Idempotency-Key': expect.stringMatching(/^admin-update:1-/),
      }),
    )
    expect(result.input.body).toBe('{"status":"active"}')
    expect(store.get('update:1')).toBeUndefined()
    await expect(mutateAdmin({}, 'update', {})).rejects.toMatchObject({ status: 503 })
    await expect(mutateAdmin(api, 'update', {})).rejects.toMatchObject({ status: 401 })

    const retryStore = createIdempotencyKeyStore()
    const conflict = Object.assign(new Error('conflict'), { status: 409, code: 'conflict' })
    const conflictApi = { update: vi.fn(() => Promise.reject(conflict)) }
    const key = createIdempotencyKey('retry', retryStore)
    await expect(
      mutateAdmin(conflictApi, 'update', {
        csrfToken: 'csrf',
        idempotencyIntent: 'retry',
        idempotencyStore: retryStore,
      }),
    ).rejects.toBe(conflict)
    expect(retryStore.get('retry')).toBe(key)
    const mismatch = Object.assign(new Error('mismatch'), {
      status: 409,
      code: 'idempotency_mismatch',
    })
    const mismatchApi = { update: vi.fn(() => Promise.reject(mismatch)) }
    await expect(
      mutateAdmin(mismatchApi, 'update', {
        csrfToken: 'csrf',
        idempotencyIntent: 'retry',
        idempotencyStore: retryStore,
      }),
    ).rejects.toBe(mismatch)
    expect(retryStore.get('retry')).toBeUndefined()
  })

  it('deduplicates, caches, invalidates and aborts resource requests', async () => {
    const scope = {}
    const fetchImpl = vi.fn(async () => fetchResponse({ value: 1 }))
    const api = {
      listSources: vi.fn(async ({ fetchImpl: request }) =>
        request('https://example.test/admin/sources'),
      ),
    }
    const first = acquireAdminResourceRequest({
      scope,
      api,
      operation: 'listSources',
      query: { limit: 1 },
      fetchImpl,
    })
    expect(first.cached).toBe(false)
    await expect(first.promise).resolves.toEqual(expect.objectContaining({ ok: true }))
    first.release()
    const cached = acquireAdminResourceRequest({
      scope,
      api,
      operation: 'listSources',
      query: { limit: 1 },
      fetchImpl,
    })
    expect(cached.cached).toBe(true)
    await expect(cached.promise).resolves.toEqual(expect.objectContaining({ ok: true }))
    invalidateAdminResourceCache(scope, { operation: 'listSources', query: { limit: 1 } })
    const forced = acquireAdminResourceRequest({
      scope,
      api,
      operation: 'listSources',
      query: { limit: 1 },
      fetchImpl,
      force: true,
    })
    await forced.promise
    forced.release()
    expect(fetchImpl).toHaveBeenCalledTimes(2)
    clearAdminResourceCache(scope)
    expect(() =>
      acquireAdminResourceRequest({ scope: null, api: null, operation: 'listSources' }),
    ).toThrow(/cache scope/i)
  })

  it('shares an in-flight request and releases it only once per subscriber', async () => {
    const scope = {}
    let resolveFetch
    const pending = new Promise((resolve) => {
      resolveFetch = resolve
    })
    const fetchImpl = vi.fn(() => pending)
    const api = {
      listSources: vi.fn(async ({ fetchImpl: request }) =>
        request('https://example.test/admin/sources'),
      ),
    }
    const first = acquireAdminResourceRequest({ scope, api, operation: 'listSources', fetchImpl })
    const second = acquireAdminResourceRequest({ scope, api, operation: 'listSources', fetchImpl })
    expect(second.cached).toBe(false)
    expect(fetchImpl).toHaveBeenCalledTimes(1)
    first.release()
    first.release()
    resolveFetch(fetchResponse({ value: 2 }))
    await expect(second.promise).resolves.toEqual(expect.objectContaining({ ok: true }))
    second.release()

    const failing = acquireAdminResourceRequest({
      scope,
      api: {
        listSources: vi.fn(async ({ fetchImpl: request }) =>
          request('https://example.test/admin/sources'),
        ),
      },
      operation: 'listSources',
      fetchImpl: vi.fn(async () => {
        throw new Error('network')
      }),
      force: true,
    })
    await expect(failing.promise).rejects.toThrow('network')
    failing.release()
    invalidateAdminResourceCache(scope)
  })

  it('guards pagination across status changes and preserves a newer query loading lock', async () => {

    const scope = {}
    clearAdminResourceCache(scope)

    let resolveOldLoadMore
    const oldLoadMorePromise = new Promise((resolve) => {
      resolveOldLoadMore = resolve
    })
    let resolveNewLoadMore
    const newLoadMoreResponse = new Promise((resolve) => {
      resolveNewLoadMore = resolve
    })

    const api = {
      listAdminArticles: vi.fn(async ({ fetchImpl, signal }) => {
        const res = await fetchImpl('https://techpulse.test/api/v1/admin/articles', { signal })
        return res.json()
      }),
    }

    const fetchImpl = vi.fn(async (url) => {
      const parsed = new URL(url)
      if (parsed.searchParams.get('cursor') === 'cursor-old') {
        return oldLoadMorePromise
      }
      if (parsed.searchParams.get('cursor') === 'cursor-new') {
        return newLoadMoreResponse
      }
      if (parsed.searchParams.get('status') === 'hidden') {
        return {
          ok: true,
          json: async () => ({
            data: [{ id: 'article-hidden-1', status: 'hidden' }],
            meta: { hasNext: true, nextCursor: 'cursor-new' },
          }),
        }
      }
      return {
        ok: true,
        json: async () => ({
          data: [{ id: 'article-published-1', status: 'published' }],
          meta: { hasNext: true, nextCursor: 'cursor-old' },
        }),
      }
    })

    const originalFetch = globalThis.fetch
    globalThis.fetch = fetchImpl

    const runner = createHookRunner((props) =>
      useAdminResource(api, 'listAdminArticles', props),
    )
    try {

      runner.render({
        initialData: {
          data: [{ id: 'article-published-1', status: 'published' }],
          meta: { hasNext: true, nextCursor: 'cursor-old' },
        },
        query: {},
        cacheScope: scope,
      })

      const oldPagePromise = runner.current.loadMore()
      expect(
        fetchImpl.mock.calls.filter(
          ([url]) => new URL(url).searchParams.get('cursor') === 'cursor-old',
        ),
      ).toHaveLength(1)

      runner.render({
        query: { status: 'hidden' },
        cacheScope: scope,
      })

      expect(await runner.current.loadMore()).toBe(false)
      expect(
        fetchImpl.mock.calls.filter(
          ([url]) => new URL(url).searchParams.get('cursor') === 'cursor-old',
        ),
      ).toHaveLength(1)
      expect(
        fetchImpl.mock.calls.filter(
          ([url]) => new URL(url).searchParams.get('cursor') === 'cursor-new',
        ),
      ).toHaveLength(0)

      await new Promise((r) => setTimeout(r, 300))
      await new Promise((r) => setTimeout(r, 50))

      const newQueryLoadMorePromise = runner.current.loadMore()
      expect(runner.current.loadingMore).toBe(true)
      expect(
        fetchImpl.mock.calls.filter(
          ([url]) => new URL(url).searchParams.get('cursor') === 'cursor-new',
        ),
      ).toHaveLength(1)

      resolveOldLoadMore({
        ok: true,
        json: async () => ({
          data: [{ id: 'article-published-2', status: 'published' }],
          meta: { hasNext: false },
        }),
      })

      expect(await oldPagePromise).toBe(false)
      expect(runner.current.loadingMore).toBe(true)
      const blockedWhileCurrentRequestPending = runner.current.loadMore()
      expect(await blockedWhileCurrentRequestPending).toBe(false)

      const filteredCache = acquireAdminResourceRequest({
        scope,
        api,
        operation: 'listAdminArticles',
        query: { status: 'hidden' },
        fetchImpl,
      })
      expect(filteredCache.cached).toBe(true)
      expect(listItems(await filteredCache.promise)).toEqual([
        expect.objectContaining({ id: 'article-hidden-1', status: 'hidden' }),
      ])
      filteredCache.release()

      resolveNewLoadMore({
        ok: true,
        json: async () => ({
          data: [{ id: 'article-hidden-2', status: 'hidden' }],
          meta: { hasNext: false },
        }),
      })

      expect(await newQueryLoadMorePromise).toBe(true)
      expect(runner.current.loadingMore).toBe(false)
      expect(listItems(runner.current.data)).toEqual([
        expect.objectContaining({ id: 'article-hidden-1', status: 'hidden' }),
        expect.objectContaining({ id: 'article-hidden-2', status: 'hidden' }),
      ])
    } finally {
      runner.unmount()
      globalThis.fetch = originalFetch
      clearAdminResourceCache(scope)
    }
  })

  it('combines items and updates cache during valid same-query pagination', async () => {

    const scope = {}
    clearAdminResourceCache(scope)
    const api = {
      listAdminArticles: vi.fn(async ({ fetchImpl, signal }) => {
        const res = await fetchImpl('https://techpulse.test/api/v1/admin/articles', { signal })
        return res.json()
      }),
    }
    const fetchImpl = vi.fn(async (url) => {
      const parsed = new URL(url)
      if (parsed.searchParams.get('cursor') === 'cursor-1') {
        return {
          ok: true,
          json: async () => ({
            data: [{ id: 'article-2', status: 'published' }],
            meta: { hasNext: false },
          }),
        }
      }
      return {
        ok: true,
        json: async () => ({
          data: [{ id: 'article-1', status: 'published' }],
          meta: { hasNext: true, nextCursor: 'cursor-1' },
        }),
      }
    })

    const originalFetch = globalThis.fetch
    globalThis.fetch = fetchImpl

    const runner = createHookRunner((props) =>
      useAdminResource(api, 'listAdminArticles', props),
    )
    try {
      runner.render({
        initialData: {
          data: [{ id: 'article-1', status: 'published' }],
          meta: { hasNext: true, nextCursor: 'cursor-1' },
        },
        query: {},
        cacheScope: scope,
      })

      const ok = await runner.current.loadMore()
      expect(ok).toBe(true)
      expect(listItems(runner.current.data)).toEqual([
        expect.objectContaining({ id: 'article-1' }),
        expect.objectContaining({ id: 'article-2' }),
      ])
      expect(listMeta(runner.current.data)).toEqual({ hasNext: false })

      const cached = acquireAdminResourceRequest({
        scope,
        api,
        operation: 'listAdminArticles',
        query: {},
        fetchImpl,
      })
      expect(cached.cached).toBe(true)
      const cachedData = await cached.promise
      cached.release()
      expect(listItems(cachedData)).toEqual([
        expect.objectContaining({ id: 'article-1' }),
        expect.objectContaining({ id: 'article-2' }),
      ])
    } finally {
      runner.unmount()
      globalThis.fetch = originalFetch
      clearAdminResourceCache(scope)
    }
  })

  it('invalidates pagination when the cache scope changes', async () => {

    const scopeA = {}
    const scopeB = {}
    clearAdminResourceCache(scopeA)
    clearAdminResourceCache(scopeB)
    let resolveOldPage
    let resolveNewPage
    const oldPage = new Promise((resolve) => { resolveOldPage = resolve })
    const newPage = new Promise((resolve) => { resolveNewPage = resolve })
    let cursorRequests = 0
    const api = {
      listAdminArticles: vi.fn(async ({ fetchImpl, signal }) => {
        const response = await fetchImpl('https://techpulse.test/api/v1/admin/articles', { signal })
        return response.json()
      }),
    }
    const fetchImpl = vi.fn(async (url) => {
      const parsed = new URL(url)
      if (parsed.searchParams.get('cursor') === 'cursor-a') {
        cursorRequests += 1
        return cursorRequests === 1 ? oldPage : newPage
      }
      return {
        ok: true,
        json: async () => ({ data: [{ id: 'article-b1', status: 'published' }], meta: { hasNext: false } }),
      }
    })
    const originalFetch = globalThis.fetch
    globalThis.fetch = fetchImpl
    const runner = createHookRunner((props) => useAdminResource(api, 'listAdminArticles', props))
    try {
      runner.render({
        initialData: { data: [{ id: 'article-a1', status: 'published' }], meta: { hasNext: true, nextCursor: 'cursor-a' } },
        cacheScope: scopeA,
      })
      const oldResult = runner.current.loadMore()
      runner.render({ cacheScope: scopeB })
      const newResult = runner.current.loadMore()
      await new Promise((resolve) => setTimeout(resolve, 300))
      resolveOldPage({ ok: true, json: async () => ({ data: [{ id: 'article-a2' }], meta: { hasNext: false } }) })
      resolveNewPage({ ok: true, json: async () => ({ data: [{ id: 'article-b2' }], meta: { hasNext: false } }) })
      expect(await oldResult).toBe(false)
      expect(await newResult).toBe(false)
      expect(cursorRequests).toBe(1)
      expect(listItems(runner.current.data)).toEqual([expect.objectContaining({ id: 'article-b1' })])
    } finally {
      runner.unmount()
      globalThis.fetch = originalFetch
      clearAdminResourceCache(scopeA)
      clearAdminResourceCache(scopeB)
    }
  })
})
