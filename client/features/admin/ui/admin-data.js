import { useCallback, useEffect, useMemo, useState } from 'react'

const EMPTY_QUERY = Object.freeze({})

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
  { enabled = true, initialData, onSessionExpired, query = EMPTY_QUERY } = {},
) {
  const queryKey = useMemo(() => stableQueryKey(query), [query])
  const stableQuery = useMemo(() => Object.fromEntries(JSON.parse(queryKey)), [queryKey])
  const seeded = initialData !== undefined
  const [state, setState] = useState(seeded ? 'ready' : enabled ? 'loading' : 'idle')
  const [data, setData] = useState(initialData ?? null)
  const [error, setError] = useState(null)
  const [reloadKey, setReloadKey] = useState(0)
  const [loadingMore, setLoadingMore] = useState(false)

  useEffect(() => {
    let active = true
    if (!enabled || initialData !== undefined)
      return () => {
        active = false
      }
    const timer = globalThis.setTimeout(() => {
      if (!active) return
      setState('loading')
      setError(null)
      void readAdmin(api, operation, { query: stableQuery })
        .then((response) => {
          if (!active) return
          setData(response)
          setState('ready')
        })
        .catch((requestError) => {
          if (!active) return
          if (isSessionExpired(requestError))
            onSessionExpired?.('Phiên đăng nhập đã hết hạn khi mở admin workspace.')
          setError(safeAdminError(requestError))
          setState('error')
        })
    }, 0)
    return () => {
      active = false
      globalThis.clearTimeout(timer)
    }
  }, [api, enabled, initialData, onSessionExpired, operation, queryKey, reloadKey, stableQuery])

  const loadMore = useCallback(async () => {
    const meta = listMeta(data)
    if (loadingMore || !meta.hasNext || !meta.nextCursor) return false
    setLoadingMore(true)
    try {
      const response = await readAdmin(api, operation, {
        query: { ...stableQuery, cursor: meta.nextCursor },
      })
      const currentItems = listItems(data)
      const nextItems = listItems(response)
      setData({
        ...(response && typeof response === 'object' && !Array.isArray(response) ? response : {}),
        data: [...currentItems, ...nextItems],
        meta: listMeta(response),
      })
      return true
    } catch (requestError) {
      if (isSessionExpired(requestError))
        onSessionExpired?.('Phiên đăng nhập đã hết hạn khi tải thêm dữ liệu admin.')
      setError(safeAdminError(requestError))
      return false
    } finally {
      setLoadingMore(false)
    }
  }, [api, data, loadingMore, onSessionExpired, operation, stableQuery])

  return {
    state,
    data,
    error,
    loadingMore,
    loadMore,
    reload: () => setReloadKey((value) => value + 1),
  }
}

export function useAdminMutation({ onSessionExpired } = {}) {
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
