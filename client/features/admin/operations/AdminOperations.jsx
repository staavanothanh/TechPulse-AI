import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { normalizeAdminFailure } from './admin-utils.js'
import { createAdminReadApi } from './admin-api.js'
import AdminArticles from './AdminArticles.jsx'
import AdminAudit from './AdminAudit.jsx'
import AdminDeletions from './AdminDeletions.jsx'
import AdminGovernance from './AdminGovernance.jsx'
import AdminOverview from './AdminOverview.jsx'
import AdminUsers from './AdminUsers.jsx'
import { AdminConfirmationDialog } from './admin-shared.jsx'
import { invalidateRequest } from './admin-helpers.js'

const NAV_ITEMS = Object.freeze([
  { id: 'overview', label: 'Tổng quan' },
  { id: 'jobs', label: 'Jobs' },
  { id: 'articles', label: 'Articles & AI index' },
  { id: 'governance', label: 'Governance' },
  { id: 'users', label: 'Người dùng' },
  { id: 'audit', label: 'Audit bất biến' },
])

export { AdminConfirmationDialog }

export default function AdminOperations({ api, csrfToken, route = 'overview', onNavigate, onSessionExpired, initialData = null }) {
  const [state, setState] = useState(initialData ? 'ready' : 'loading')
  const [data, setData] = useState(initialData)
  const [failure, setFailure] = useState(null)
  const [query, setQuery] = useState({})
  const [loadingMore, setLoadingMore] = useState(false)
  const [adminLive, setAdminLive] = useState('')
  const [mobileMoreOpen, setMobileMoreOpen] = useState(false)
  const moreTriggerRef = useRef(null)
  const moreDialogRef = useRef(null)
  const wasMoreOpen = useRef(false)
  const requestId = useRef(0)
  const queryRef = useRef({})
  const onSessionExpiredRef = useRef(onSessionExpired)
  const previousRouteRef = useRef(route)
  const initialDataRouteRef = useRef(initialData ? route : null)
  const operationFor = useMemo(
    () =>
      ({
        overview: 'getAdminOverview',
        articles: 'listAdminArticles',
        governance: 'listTakedownRequests',
        users: 'listAdminUsers',
        deletions: 'listAccountDeletionRequests',
        audit: 'listAuditLogs',
      })[route] ?? null,
    [route],
  )
  const readApi = useMemo(() => createAdminReadApi(api), [api])
  const load = useCallback(
    async ({ nextQuery = queryRef.current, append = false } = {}) => {
      if (!operationFor || !readApi?.[operationFor]) {
        ++requestId.current
        setFailure(null)
        setState('ready')
        return
      }
      queryRef.current = nextQuery
      const current = ++requestId.current
      if (!append) setState('loading')
      else setLoadingMore(true)
      setFailure(null)
      try {
        const response = await readApi[operationFor]({
          credentials: 'same-origin',
          query: nextQuery,
        })
        if (current !== requestId.current) return
        const payload = operationFor === 'getAdminOverview' ? (response?.data ?? response) : response
        if (append && Array.isArray(payload?.data))
          setData((previous) => ({
            ...payload,
            data: [...(previous?.data ?? []), ...payload.data],
          }))
        else setData(payload)
        setState('ready')
      } catch (error) {
        if (current !== requestId.current) return
        if (error.status === 401) onSessionExpiredRef.current?.('Phiên đăng nhập đã hết hạn khi mở admin workspace.')
        setFailure(normalizeAdminFailure(error))
        if (!append) setState('error')
      } finally {
        if (append && current === requestId.current) setLoadingMore(false)
      }
    },
    [operationFor, readApi],
  )
  useLayoutEffect(() => {
    onSessionExpiredRef.current = onSessionExpired
  }, [onSessionExpired])
  useLayoutEffect(() => {
    const routeChanged = previousRouteRef.current !== route
    previousRouteRef.current = route
    if (!routeChanged) return
    invalidateRequest(requestId)
    initialDataRouteRef.current = null
    queryRef.current = {}
    setQuery({})
    setData(null)
    setFailure(null)
    setLoadingMore(false)
    setState('loading')
  }, [route])
  useEffect(() => {
    if (initialData && initialDataRouteRef.current === route) return undefined
    const timer = globalThis.setTimeout(() => {
      void load()
    }, 0)
    return () => {
      globalThis.clearTimeout(timer)
      invalidateRequest(requestId)
    }
  }, [initialData, load, route])
  useEffect(() => {
    if (!mobileMoreOpen) {
      if (wasMoreOpen.current) moreTriggerRef.current?.focus?.({ preventScroll: true })
      wasMoreOpen.current = false
      return undefined
    }
    wasMoreOpen.current = true
    moreDialogRef.current?.querySelector?.('button:not([disabled])')?.focus?.({ preventScroll: true })
    const onKeyDown = (event) => {
      if (event.key === 'Escape') {
        event.preventDefault()
        setMobileMoreOpen(false)
        return
      }
      if (event.key !== 'Tab') return
      const focusables = [...(moreDialogRef.current?.querySelectorAll?.('button:not([disabled])') ?? [])]
      if (!focusables.length) return
      const first = focusables[0]
      const last = focusables[focusables.length - 1]
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault()
        last.focus()
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault()
        first.focus()
      }
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [mobileMoreOpen])
  const applyQuery = useCallback(
    (nextQuery) => {
      setQuery(nextQuery)
      void load({ nextQuery })
    },
    [load],
  )
  const loadMore = useCallback(() => {
    const cursor = data?.meta?.nextCursor
    if (cursor) void load({ nextQuery: { ...queryRef.current, cursor }, append: true })
  }, [data, load])
  const common = {
    data,
    state,
    failure,
    onRetry: () => load(),
    query,
    onQueryChange: applyQuery,
    loadingMore,
    onLoadMore: loadMore,
    onNotice: setAdminLive,
    onNavigate,
  }
  const mobilePrimary = NAV_ITEMS.slice(0, 3)
  const mobileMore = NAV_ITEMS.slice(3)
  return (
    <section className="admin-operations" aria-label="Điều hành quản trị">
      <p id="admin-live-region" className="admin-sr-only" role="status" aria-live="polite" aria-atomic="true">
        {failure?.message ?? adminLive}
      </p>
      <div className="admin-mobile-nav" aria-label="Điều hướng quản trị mobile">
        {mobilePrimary.map((item) => (
          <button
            type="button"
            key={item.id}
            aria-current={route === item.id ? 'page' : undefined}
            onClick={() => {
              setMobileMoreOpen(false)
              onNavigate?.(item.id)
            }}
          >
            {item.label}
          </button>
        ))}
        <button type="button" ref={moreTriggerRef} aria-expanded={mobileMoreOpen} aria-controls="admin-mobile-more" onClick={() => setMobileMoreOpen((open) => !open)}>
          Thêm
        </button>
      </div>
      {mobileMoreOpen ? (
        <div
          className="admin-mobile-more-scrim"
          role="presentation"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) setMobileMoreOpen(false)
          }}
        >
          <div id="admin-mobile-more" ref={moreDialogRef} className="admin-mobile-more" role="dialog" aria-modal="true" aria-label="Điều hướng quản trị thêm">
            {mobileMore.map((item) => (
              <button
                type="button"
                key={item.id}
                aria-current={route === item.id ? 'page' : undefined}
                onClick={() => {
                  setMobileMoreOpen(false)
                  onNavigate?.(item.id)
                }}
              >
                {item.label}
              </button>
            ))}
          </div>
        </div>
      ) : null}
      {route === 'overview' ? <AdminOverview {...common} /> : null}
      {route === 'articles' ? <AdminArticles {...common} adminApi={readApi} readApi={readApi} csrfToken={csrfToken} /> : null}
      {route === 'governance' ? <AdminGovernance {...common} readApi={readApi} adminApi={readApi} csrfToken={csrfToken} /> : null}
      {route === 'users' ? <AdminUsers {...common} adminApi={readApi} csrfToken={csrfToken} /> : null}
      {route === 'deletions' ? <AdminDeletions {...common} adminApi={readApi} csrfToken={csrfToken} /> : null}
      {route === 'audit' ? <AdminAudit {...common} /> : null}
    </section>
  )
}
