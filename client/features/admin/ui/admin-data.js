import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

const EMPTY_QUERY = Object.freeze({})
export const ADMIN_FILTER_DEBOUNCE_MS = 250

const RESOURCE_CACHE_SCOPES = new WeakMap()

function isCacheScope(value) {
  return (typeof value === 'object' && value !== null) || typeof value === 'function'
}

function getResourceCache(scope) {
  if (!isCacheScope(scope)) return null
  let cache = RESOURCE_CACHE_SCOPES.get(scope)
  if (!cache) {
    cache = { entries: new Map() }
    RESOURCE_CACHE_SCOPES.set(scope, cache)
  }
  return cache
}

function resourceCacheKey(operation, query = {}) {
  return `${operation}:${stableQueryKey(allowlistedQuery(operation, query))}`
}

function createAbortError() {
  const error = new Error('Admin request aborted')
  error.name = 'AbortError'
  return error
}

export function isAbortError(error) {
  return error?.name === 'AbortError' || error?.code === 'ABORT_ERR'
}

function releaseInFlight(_cache, _key, entry, flight) {
  if (entry.inFlight !== flight) return
  flight.subscribers -= 1
  if (flight.subscribers <= 0) {
    entry.inFlight = null
    flight.controller.abort()
  }
}

export function acquireAdminResourceRequest({
  scope,
  api,
  operation,
  query = {},
  fetchImpl = globalThis.fetch,
  force = false,
} = {}) {
  const cacheScope = scope ?? api
  const cache = getResourceCache(cacheScope)
  if (!cache) throw new Error('Admin resource cache scope is required')
  const key = resourceCacheKey(operation, query)
  const entry = cache.entries.get(key) ?? { dataSet: false, data: null, inFlight: null }
  cache.entries.set(key, entry)

  if (entry.inFlight) {
    entry.inFlight.subscribers += 1
    const flight = entry.inFlight
    let released = false
    return {
      cached: false,
      key,
      signal: flight.controller.signal,
      promise: flight.promise,
      release() {
        if (released) return
        released = true
        releaseInFlight(cache, key, entry, flight)
      },
    }
  }

  if (!force && entry.dataSet) {
    return {
      cached: true,
      key,
      signal: null,
      promise: Promise.resolve(entry.data),
      release() {},
    }
  }

  if (force) entry.dataSet = false
  const controller = new globalThis.AbortController()
  const flight = { controller, subscribers: 1, promise: null }
  const request = controller.signal.aborted
    ? Promise.reject(createAbortError())
    : readAdmin(api, operation, { query, signal: controller.signal }, fetchImpl)
  flight.promise = request.then(
    (value) => {
      if (entry.inFlight === flight) {
        entry.data = value
        entry.dataSet = true
        entry.inFlight = null
      }
      return value
    },
    (error) => {
      if (entry.inFlight === flight) entry.inFlight = null
      throw error
    },
  )
  entry.inFlight = flight
  let released = false
  return {
    cached: false,
    key,
    signal: controller.signal,
    promise: flight.promise,
    release() {
      if (released) return
      released = true
      releaseInFlight(cache, key, entry, flight)
    },
  }
}

function readAdminResourceCache(scope, operation, query) {
  const cache = getResourceCache(scope)
  if (!cache) return { hit: false, data: null }
  const entry = cache.entries.get(resourceCacheKey(operation, query))
  return entry?.dataSet ? { hit: true, data: entry.data } : { hit: false, data: null }
}

function seedAdminResourceCache(scope, operation, query, data) {
  const cache = getResourceCache(scope)
  if (!cache) return
  const key = resourceCacheKey(operation, query)
  const entry = cache.entries.get(key) ?? { dataSet: false, data: null, inFlight: null }
  if (entry.dataSet) return
  entry.data = data
  entry.dataSet = true
  cache.entries.set(key, entry)
}

export function invalidateAdminResourceCache(scope, { operation, query } = {}) {
  const cache = getResourceCache(scope)
  if (!cache) return
  if (!operation) {
    for (const entry of cache.entries.values()) {
      entry.dataSet = false
      if (entry.inFlight) {
        entry.inFlight.controller.abort()
        entry.inFlight = null
      }
    }
    return
  }
  const prefix = `${operation}:`
  const exactKey = query === undefined ? null : resourceCacheKey(operation, query)
  for (const [key, entry] of cache.entries) {
    if ((exactKey && key === exactKey) || (!exactKey && key.startsWith(prefix))) {
      entry.dataSet = false
      if (entry.inFlight) {
        entry.inFlight.controller.abort()
        entry.inFlight = null
      }
    }
  }
}

export function clearAdminResourceCache(scope) {
  const cache = getResourceCache(scope)
  if (!cache) return
  for (const entry of cache.entries.values()) entry.inFlight?.controller.abort()
  cache.entries.clear()
}

export const ADMIN_NAVIGATION = Object.freeze([
  { id: 'overview', label: 'Tổng quan', section: 'Vận hành' },
  { id: 'jobs', label: 'Jobs', section: 'Vận hành', badge: 'queuedJobs' },
  { id: 'articles', label: 'Articles & AI index', section: 'Vận hành' },
  {
    id: 'governance',
    label: 'Takedown & xóa tài khoản',
    section: 'Governance',
    badge: 'openTakedowns',
  },
  { id: 'sources', label: 'Source Registry', section: 'Nguồn & người dùng' },
  { id: 'users', label: 'Người dùng', section: 'Nguồn & người dùng' },
  { id: 'audit', label: 'Audit bất biến', section: 'Nguồn & người dùng' },
  { id: 'account', label: 'Tài khoản', section: 'Nguồn & người dùng' },
])

const QUERY_FIELDS = Object.freeze({
  listSources: ['operationalStatus', 'licenseStatus', 'connectorType', 'cursor', 'limit'],
  listIngestionJobs: ['status', 'sourceId', 'cursor', 'limit'],
  listIndexingJobs: ['status', 'task', 'articleId', 'sourceId', 'cursor', 'limit'],
  listAdminArticles: ['status', 'sourceId', 'summaryStatus', 'embeddingStatus', 'cursor', 'limit'],
  listTakedownRequests: ['status', 'cursor', 'limit'],
  listAccountDeletionRequests: ['status', 'cursor', 'limit'],
  listAdminUsers: ['status', 'email', 'cursor', 'limit'],
  listAuditLogs: ['actorType', 'actorId', 'targetType', 'targetId', 'cursor', 'limit'],
})

const STATUS_LABELS = Object.freeze({
  active: 'Đang hoạt động',
  approved: 'Đã duyệt',
  cancelled: 'Đã hủy',
  completed: 'Hoàn tất',
  deleted: 'Đã xóa',
  failed: 'Lỗi',
  hidden: 'Đã ẩn',
  partial: 'Một phần',
  published: 'Đang hiển thị',
  queued: 'Đang chờ',
  received: 'Đã tiếp nhận',
  rejected: 'Từ chối',
  reviewing: 'Đang xem xét',
  running: 'Đang chạy',
  suspended: 'Tạm dừng',
})

const ERROR_MESSAGES = Object.freeze({
  401: 'Phiên đăng nhập đã hết hạn. Hãy đăng nhập lại.',
  403: 'Bạn không có quyền thực hiện thao tác này.',
  404: 'Bản ghi không còn khả dụng.',
  409: 'Trạng thái vừa thay đổi. Hãy tải lại dữ liệu.',
  422: 'Dữ liệu thao tác chưa hợp lệ.',
  429: 'Thao tác quá nhanh. Hãy thử lại sau.',
  500: 'Không thể hoàn tất thao tác.',
  503: 'Dịch vụ tạm thời không sẵn sàng.',
})

export const OVERVIEW_METRICS = Object.freeze([
  ['failedJobs', 'Job lỗi', 'danger'],
  ['failedIndexes', 'Index lỗi', 'danger'],
  ['openTakedowns', 'Takedown đang mở', 'warning'],
  ['failedAccountDeletions', 'Xóa tài khoản lỗi', 'danger'],
  ['sourcesNeedingReview', 'Nguồn cần duyệt', 'warning'],
  ['articlesNeedingReview', 'Article cần duyệt', 'warning'],
  ['queuedJobs', 'Job đang chờ', 'quiet'],
  ['activeSources', 'Nguồn đang hoạt động', 'quiet'],
  ['pausedSources', 'Nguồn tạm dừng', 'quiet'],
])

export const DELETION_FLAGS = Object.freeze([
  ['sessionsRevoked', 'Thu hồi phiên'],
  ['sessionsDeleted', 'Xóa phiên'],
  ['savedArticlesDeleted', 'Xóa bài đã lưu'],
  ['chatSessionsDeleted', 'Xóa phiên hỏi đáp'],
  ['answerAttemptsDeleted', 'Xóa lượt trả lời'],
  ['userQuotaDataDeleted', 'Xóa quota'],
  ['identityAnonymized', 'Ẩn danh định danh'],
])

export function artifactJobRequest(task) {
  if (task === 'summary')
    return {
      operation: 'createSummaryJob',
      body: { reasonCode: 'artifact_regeneration_requested' },
    }
  return {
    operation: 'createIndexingJob',
    body: { task, reasonCode: 'artifact_regeneration_requested' },
  }
}

export function isAdminJobRetryable(job) {
  if (!job || !['partial', 'failed'].includes(job.status)) return false
  const statusAllowsRetry = job.status === 'partial' || job.error?.retryable === true
  const attempt = Number(job.attempt)
  return statusAllowsRetry && Number.isInteger(attempt) && attempt >= 1 && attempt < 3
}

export function readResponseData(response) {
  return response?.data ?? response ?? null
}

export function listItems(response) {
  const payload = readResponseData(response)
  return Array.isArray(payload) ? payload : Array.isArray(payload?.data) ? payload.data : []
}

export function listMeta(response) {
  const payload = readResponseData(response)
  return response?.meta ?? payload?.meta ?? { hasNext: false }
}

export function allowlistedQuery(operation, query = {}) {
  const allowed = QUERY_FIELDS[operation] ?? []
  return Object.fromEntries(
    allowed.flatMap((key) => {
      const value = query[key]
      return value === undefined || value === null || value === '' ? [] : [[key, String(value)]]
    }),
  )
}

export function stableQueryKey(query = {}) {
  return JSON.stringify(
    Object.entries(query)
      .filter(([, value]) => value !== undefined && value !== null && value !== '')
      .sort(([a], [b]) => a.localeCompare(b)),
  )
}

export function formatAdminDate(value) {
  if (!value) return 'Chưa ghi nhận'
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return 'Không xác định'
  return new Intl.DateTimeFormat('vi-VN', { dateStyle: 'medium', timeStyle: 'short' }).format(date)
}

export function statusLabel(value) {
  return STATUS_LABELS[value] ?? value ?? 'Chưa xác định'
}

export function statusTone(value) {
  if (['failed', 'rejected', 'suspended', 'deleted'].includes(value)) return 'danger'
  if (['partial', 'reviewing', 'received', 'paused', 'review-needed'].includes(value))
    return 'warning'
  if (['active', 'approved', 'completed', 'published', 'succeeded', 'passed'].includes(value))
    return 'success'
  if (['queued', 'running', 'testing', 'processing'].includes(value)) return 'accent'
  return 'muted'
}

export function safeAdminError(error) {
  const status = Number(error?.status)
  return ERROR_MESSAGES[status] ?? 'Không thể hoàn tất thao tác.'
}

export function isSessionExpired(error) {
  return Number(error?.status) === 401
}

export function createIdempotencyKey(intent, store = null) {
  const existing = store?.get?.(intent)
  if (existing) return existing
  const suffix =
    globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`
  const key = `admin-${intent}-${suffix}`
  store?.set?.(intent, key)
  return key
}

export function createIdempotencyKeyStore() {
  const store = new Map()
  return Object.freeze({
    get: (intent) => store.get(intent),
    set: (intent, key) => store.set(intent, key),
    delete: (intent) => store.delete(intent),
    clear: () => store.clear(),
  })
}

function retryAfter(response) {
  const raw = response?.headers?.get?.('Retry-After')
  if (typeof raw !== 'string' || !/^[1-9]\d*$/.test(raw.trim())) return null
  const seconds = Number(raw.trim())
  return Number.isSafeInteger(seconds) && seconds <= 86_400 ? seconds : null
}

export async function readAdmin(
  api,
  operation,
  { query = {}, ...init } = {},
  fetchImpl = globalThis.fetch,
) {
  const method = api?.[operation]
  if (typeof method !== 'function')
    throw Object.assign(new Error('Admin operation unavailable'), { status: 503 })
  let response
  const managedFetch = async (input, requestInit) => {
    const url = new URL(input)
    for (const [key, value] of Object.entries(allowlistedQuery(operation, query)))
      url.searchParams.set(key, value)
    response = await fetchImpl(url, requestInit)
    return response
  }
  try {
    return await method({ ...init, credentials: 'same-origin', fetchImpl: managedFetch })
  } catch (error) {
    const seconds = retryAfter(response)
    if (seconds !== null) {
      try {
        error.retryAfter = seconds
      } catch {
        /* Keep canonical transport fields when frozen. */
      }
    }
    throw error
  }
}

export function mutateAdmin(
  api,
  operation,
  { csrfToken, pathParams, body, idempotencyIntent, idempotencyStore } = {},
) {
  const method = api?.[operation]
  if (typeof method !== 'function')
    return Promise.reject(Object.assign(new Error('Admin operation unavailable'), { status: 503 }))
  if (!csrfToken)
    return Promise.reject(Object.assign(new Error('Admin session is required'), { status: 401 }))
  const headers = { 'Content-Type': 'application/json', 'X-CSRF-Token': csrfToken }
  if (idempotencyIntent)
    headers['Idempotency-Key'] = createIdempotencyKey(idempotencyIntent, idempotencyStore)
  return method({
    pathParams,
    headers,
    body: JSON.stringify(body),
    credentials: 'same-origin',
  }).then(
    (response) => {
      if (idempotencyIntent) idempotencyStore?.delete?.(idempotencyIntent)
      return response
    },
    (error) => {
      const status = Number(error?.status)
      const keepForRetry = !status || (status === 409 && error?.code !== 'idempotency_mismatch')
      if (idempotencyIntent && !keepForRetry) idempotencyStore?.delete?.(idempotencyIntent)
      throw error
    },
  )
}

export function useAdminResource(
  api,
  operation,
  {
    enabled = true,
    initialData,
    onSessionExpired,
    query = EMPTY_QUERY,
    cacheScope = api,
  } = {},
) {
  const queryKey = useMemo(
    () => stableQueryKey(allowlistedQuery(operation, query)),
    [operation, query],
  )
  const stableQuery = useMemo(() => Object.fromEntries(JSON.parse(queryKey)), [queryKey])
  const seeded = initialData !== undefined
  const cached = readAdminResourceCache(cacheScope, operation, stableQuery)
  const cachedHit = cached.hit
  const hasSeed = seeded && !cachedHit
  const [state, setState] = useState(
    hasSeed || cachedHit ? 'ready' : enabled ? 'loading' : 'idle',
  )
  const [data, setData] = useState(cachedHit ? cached.data : (initialData ?? null))
  const [error, setError] = useState(null)
  const [reloadKey, setReloadKey] = useState(0)
  const [loadingMore, setLoadingMore] = useState(false)
  const loadingMoreRef = useRef(false)
  const seededQueryKeyRef = useRef(hasSeed ? queryKey : null)
  const didSeedRef = useRef(false)
  const consumedReloadKeyRef = useRef(0)

  useEffect(() => {
    let active = true
    let request
    if (!enabled) {
      return () => {
        active = false
      }
    }

    const shouldUseSeed =
      initialData !== undefined &&
      !cachedHit &&
      !didSeedRef.current &&
      seededQueryKeyRef.current === queryKey &&
      reloadKey === 0
    if (shouldUseSeed) {
      didSeedRef.current = true
      seedAdminResourceCache(cacheScope, operation, stableQuery, initialData)
      setData(initialData)
      setState('ready')
      return () => {
        active = false
      }
    }

    const force = reloadKey !== consumedReloadKeyRef.current
    consumedReloadKeyRef.current = reloadKey
    const timer = globalThis.setTimeout(() => {
      if (!active) return
      request = acquireAdminResourceRequest({
        scope: cacheScope,
        api,
        operation,
        query: stableQuery,
        force,
      })
      if (request.cached) {
        request.promise.then((response) => {
          if (!active) return
          setData(response)
          setError(null)
          setState('ready')
        })
        return
      }
      setState('loading')
      setError(null)
      void request.promise
        .then((response) => {
          if (!active) return
          setData(response)
          setState('ready')
        })
        .catch((requestError) => {
          if (!active || isAbortError(requestError)) return
          if (isSessionExpired(requestError))
            onSessionExpired?.('Phiên đăng nhập đã hết hạn khi mở admin workspace.')
          setError(safeAdminError(requestError))
          setState('error')
        })
        .finally(() => request.release())
    }, force ? 0 : ADMIN_FILTER_DEBOUNCE_MS)
    return () => {
      active = false
      globalThis.clearTimeout(timer)
      request?.release?.()
    }
  }, [api, cacheScope, cachedHit, enabled, initialData, onSessionExpired, operation, queryKey, reloadKey, stableQuery])

  const loadMore = useCallback(async () => {
    const meta = listMeta(data)
    if (loadingMoreRef.current || !meta.hasNext || !meta.nextCursor) return false
    loadingMoreRef.current = true
    setLoadingMore(true)
    const request = acquireAdminResourceRequest({
      scope: cacheScope,
      api,
      operation,
      query: { ...stableQuery, cursor: meta.nextCursor },
    })
    try {
      const response = await request.promise
      const currentItems = listItems(data)
      const nextItems = listItems(response)
      const combined = {
        ...(response && typeof response === 'object' && !Array.isArray(response) ? response : {}),
        data: [...currentItems, ...nextItems],
        meta: listMeta(response),
      }
      setData(combined)
      seedAdminResourceCache(cacheScope, operation, stableQuery, combined)
      return true
    } catch (requestError) {
      if (isAbortError(requestError)) return false
      if (isSessionExpired(requestError))
        onSessionExpired?.('Phiên đăng nhập đã hết hạn khi tải thêm dữ liệu admin.')
      setError(safeAdminError(requestError))
      return false
    } finally {
      request.release()
      loadingMoreRef.current = false
      setLoadingMore(false)
    }
  }, [api, cacheScope, data, onSessionExpired, operation, stableQuery])

  const reload = useCallback(() => {
    invalidateAdminResourceCache(cacheScope, { operation })
    setReloadKey((value) => value + 1)
  }, [cacheScope, operation])

  return {
    state,
    data,
    error,
    loadingMore,
    loadMore,
    reload,
  }
}

export function useAdminMutation({ onSessionExpired, cacheScope } = {}) {
  const [idempotencyStore] = useState(() => createIdempotencyKeyStore())
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)
  const [notice, setNotice] = useState('')
  async function run(action, successMessage) {
    setBusy(true)
    setError(null)
    setNotice('')
    try {
      const response = await action()
      if (response) invalidateAdminResourceCache(cacheScope)
      setNotice(successMessage)
      return response
    } catch (requestError) {
      if (isSessionExpired(requestError))
        onSessionExpired?.('Phiên đăng nhập đã hết hạn khi thực hiện thao tác admin.')
      setError(safeAdminError(requestError))
      return null
    } finally {
      setBusy(false)
    }
  }
  const mutate = (api, operation, options = {}) =>
    mutateAdmin(api, operation, { ...options, idempotencyStore })
  return { busy, error, notice, run, setError, setNotice, idempotencyStore, mutate }
}

export function safeTopics(topics) {
  return Array.isArray(topics)
    ? topics.filter((topic) => typeof topic === 'string').slice(0, 20)
    : []
}
