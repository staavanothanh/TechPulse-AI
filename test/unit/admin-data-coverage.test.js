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
} from '../../client/features/admin/ui/admin-data.js'

const response = (data, headers = new Map()) => ({
  data,
  headers: { get: (name) => headers.get(name) },
})

function fetchResponse(data = { ok: true }) {
  return { ok: true, json: vi.fn(async () => data), headers: { get: vi.fn(() => null) } }
}

describe('admin-data helpers and cache requests', () => {
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
})
