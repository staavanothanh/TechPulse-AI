import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { createContentApi } from '../../features/feed/content-api.js'
import { validateFeedFilters } from '../../features/feed/feed-validation.js'
import { validateSearchInput } from '../../features/search/search-validation.js'
import { createQaApi } from '../../features/qa/qa-api.js'
import {
  hasQaScope,
  isQaScopeConfirmation,
  validateAnswerPayload,
  validateQuestionScope,
  validateSessionDetail,
} from '../../features/qa/qa-validation.js'
import { topicsMatch } from '../../../shared/topic-catalog.js'

const PAGE_SIZE = 10
const MAX_DIRECT_PAGE = 10_000
const QA_SOURCE_SCOPE_FIELDS = Object.freeze(['topics', 'articleId', 'publishedAfter', 'publishedBefore'])
let qaFallbackIdempotencyCounter = 0

// 1. Khai báo 10 nguồn chuẩn (Canonical Sources)
const CANONICAL_SOURCES = Object.freeze([
  { id: 'demo:rss-the-verge', objectId: '407bf4b737898beeb84f4026', name: 'The Verge Technology (live demo)', connectorType: 'rss' },
  { id: 'demo:arxiv-cs-ai', objectId: '3c15995de36ca3f9d7354c29', name: 'arXiv Computer Science AI (live demo)', connectorType: 'arxiv' },
  { id: 'demo:hn-topstories', objectId: '6e22f866d3712afcaa2d2a7e', name: 'Hacker News Top Stories (live demo)', connectorType: 'hacker-news' },
  { id: 'rss:the-verge', objectId: 'c0a5a4bc55919ea3955375b1', name: 'The Verge Technology', connectorType: 'rss' },
  { id: 'rss:ars-technica', objectId: '57654bdfd53bf89dcc92ff3', name: 'Ars Technica', connectorType: 'rss' },
  { id: 'rss:deepmind-blog', objectId: 'af7ab17090f87e47197f48b5', name: 'Google DeepMind Blog', connectorType: 'rss' },
  { id: 'rss:openai-news', objectId: 'd05b6d8be6b254b899fbefae', name: 'OpenAI News', connectorType: 'rss' },
  { id: 'rss:huggingface-blog', objectId: '2dc0f5cf717a0e77e3eee6ff', name: 'Hugging Face Blog', connectorType: 'rss' },
  { id: 'arxiv:cs-ai', objectId: '4ca3339c26a215647d04ccfb', name: 'arXiv Computer Science AI', connectorType: 'arxiv' },
  { id: 'hn:topstories', objectId: 'b2b739bcb672bde81990c1a2', name: 'Hacker News Top Stories', connectorType: 'hacker-news' },
])

function createQaIdempotencyKey() {
  const randomUUID = globalThis.crypto?.randomUUID
  if (typeof randomUUID === 'function') return randomUUID.call(globalThis.crypto)
  qaFallbackIdempotencyCounter += 1
  return `qa-${Date.now()}-${qaFallbackIdempotencyCounter}`
}

const EMPTY_FILTERS = Object.freeze({
  topic: '',
  sourceId: '',
  publishedAfter: '',
  publishedBefore: '',
})
const EMPTY_QUERY = Object.freeze({
  q: '',
  mode: 'hybrid',
  topic: '',
  sourceId: '',
  publishedAfter: '',
  publishedBefore: '',
})
function toggleTopicValue(current, topic) {
  const selected = current.some((value) => topicsMatch(value, topic))
  return selected ? current.filter((value) => !topicsMatch(value, topic)) : [...current, topic]
}

function queryValues(value) {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== ''))
}
function searchQueryKey(value = {}) {
  return JSON.stringify(Object.keys(EMPTY_QUERY).map((field) => value[field] ?? ''))
}

function responseData(response, fallback) {
  return response?.data ?? fallback
}

function responseMeta(response) {
  return response?.meta ?? { hasNext: false, nextCursor: null }
}

// 2. Chuẩn hóa nguồn tin
function sourceOptionFromSource(source) {
  if (!source) return null

  if (typeof source === 'string') {
    const trimmed = source.trim()
    if (!trimmed) return null
    return { id: trimmed, name: trimmed }
  }

  const rawId = source?.id ?? source?.sourceKey ?? source?.key ?? source?.slug ?? source?.sourceType ?? source?._id ?? source?.objectId
  const id = rawId?.toHexString?.() ?? rawId
  
  if (id === undefined || id === null || String(id).trim() === '') return null
  const normalizedId = String(id).trim()

  const name = typeof source?.name === 'string' && source.name.trim() 
    ? source.name.trim() 
    : normalizedId

  const rawObjId = source?.objectId ?? source?._id
  const objectId = rawObjId ? String(rawObjId?.toHexString?.() ?? rawObjId).trim() : null

  return {
    id: normalizedId,
    objectId,
    name,
    connectorType: source?.connectorType ?? 'rss',
    status: source?.status ?? 'active'
  }
}

function sourceOptionFromArticle(article) {
  const option = sourceOptionFromSource(article?.source)
  if (option) return option

  const rawId = article?.sourceId ?? article?.sourceType ?? article?.sourceKey
  if (rawId === undefined || rawId === null || String(rawId).trim() === '') return null
  
  const id = String(rawId).trim()
  const name = typeof article?.sourceName === 'string' && article.sourceName.trim() 
    ? article.sourceName.trim() 
    : id

  return sourceOptionFromSource({ id, name })
}

// 3. Hàm gộp triệt để: Sử dụng Canonical Map để loại bỏ bản trùng Hex/ID/Name
function mergeSourceOptions(current = [], articles = [], metadataSources = []) {
  const uniqueSources = []
  const seenKeys = new Set()

  const addSource = (source) => {
    const opt = sourceOptionFromSource(source)
    if (!opt) return

    // Kiểm tra xem đã có Canonical Source tương ứng chưa
    const canonicalMatch = CANONICAL_SOURCES.find(
      (c) =>
        c.id === opt.id ||
        (c.objectId && (c.objectId === opt.id || c.objectId === opt.objectId)) ||
        c.name.toLowerCase() === opt.name.toLowerCase()
    )

    const finalOption = canonicalMatch
      ? { ...canonicalMatch, status: 'active' }
      : opt

    // Tạo key nhận diện duy nhất
    const primaryKey = finalOption.id
    const nameKey = finalOption.name.toLowerCase()
    const objectIdKey = finalOption.objectId ? `obj:${finalOption.objectId}` : null

    if (
      seenKeys.has(primaryKey) ||
      seenKeys.has(nameKey) ||
      (objectIdKey && seenKeys.has(objectIdKey))
    ) {
      return
    }

    seenKeys.add(primaryKey)
    seenKeys.add(nameKey)
    if (objectIdKey) seenKeys.add(objectIdKey)

    uniqueSources.push(finalOption)
  }

  // 1. Luôn ưu tiên 10 nguồn CANONICAL_SOURCES lên đầu
  for (const source of CANONICAL_SOURCES) {
    addSource(source)
  }

  // 2. Nạp thêm các nguồn khác từ state hiện tại / metadata API / Bài viết nếu chưa tồn tại
  for (const source of metadataSources || []) addSource(source)
  for (const source of current || []) addSource(source)
  for (const article of articles || []) {
    const opt = sourceOptionFromArticle(article)
    if (opt) addSource(opt)
  }

  return uniqueSources
}

const QA_ARTICLE_ID_PATTERN = /^[0-9a-fA-F]{24}$/

function validQaArticleId(value) {
  return typeof value === 'string' && QA_ARTICLE_ID_PATTERN.test(value) ? value : null
}
function qaScopeForArticle(scope, articleId, article = null) {
  const { articleId: _previousArticleId, sessionId: _previousSessionId, article: previousArticle, ...rest } = scope
  const targetArticle = article || (previousArticle?.id === articleId ? previousArticle : null)
  if (!articleId) return rest
  return targetArticle ? { ...rest, articleId, article: targetArticle } : { ...rest, articleId }
}

export function usePublicIntegration({
  api,
  csrfToken,
  user,
  route,
  articleId: routeArticleId = null,
  searchParams: routeSearchParams = null,
  onNavigate,
  onSessionExpired,
  accountActions,
  sessionNotice,
  allowNaturalLanguageScope = false,
  scopeMode = null,
}) {
  const contentApi = useMemo(() => createContentApi(api), [api])
  const qaApi = useMemo(() => createQaApi(api), [api])
  const [savedOverrides, setSavedOverrides] = useState({})
  const [articleId, setArticleId] = useState(null)
  const [articleReturnRoute, setArticleReturnRoute] = useState('feed')
  const integrationIdentityKey = user ? `user:${user.id ?? user._id ?? 'unknown'}${csrfToken ? `:${csrfToken}` : ''}` : 'guest'
  const integrationIdentityRef = useRef(integrationIdentityKey)
  const mountedRef = useRef(true)
  useEffect(() => {
    integrationIdentityRef.current = integrationIdentityKey
    mountedRef.current = true
    return () => {
      mountedRef.current = false
    }
  }, [integrationIdentityKey])

  const expire = useCallback(
    (error, requestIdentity = integrationIdentityKey) => {
      const expired = error?.status === 401
      if (expired && mountedRef.current && requestIdentity === integrationIdentityKey && integrationIdentityRef.current === integrationIdentityKey) onSessionExpired?.('Phiên đăng nhập không còn hợp lệ. Vui lòng đăng nhập lại.', integrationIdentityKey)
      return expired
    },
    [integrationIdentityKey, onSessionExpired],
  )

  const markSaved = useCallback((id, value) => {
    setSavedOverrides((current) => ({ ...current, [id]: value }))
  }, [])

  const openArticle = useCallback(
    (id) => {
      if (!id) return
      setArticleId(id)
      setArticleReturnRoute(route === 'search' || route === 'saved' ? route : 'feed')
      onNavigate?.('article', { articleId: id })
    },
    [onNavigate, route],
  )

  const toggleSave = useCallback(
    async (article, nextSaved) => {
      if (!csrfToken || !article?.id) return
      try {
        if (nextSaved) await contentApi.saveArticle(article.id, csrfToken)
        else await contentApi.unsaveArticle(article.id, csrfToken)
        markSaved(article.id, nextSaved)
      } catch (error) {
        expire(error)
        throw error
      }
    },
    [contentApi, csrfToken, expire, markSaved],
  )

  const qaState = useQa({ articleId: routeArticleId, contentApi, csrfToken, enabled: Boolean(user) && route === 'qa', expire, qaApi, user, allowNaturalLanguageScope, scopeMode })
  const qa = {
    ...qaState,
    handlers: {
      ...qaState.handlers,
      onClearArticleScope: () => {
        qaState.handlers.onClearArticleScope()
        onNavigate?.('qa')
      },
    },
  }
  const articleAskHandler = useCallback(
    (targetArticle) => {
      if (!targetArticle?.id) return
      qa.handlers.onScopeArticleId(targetArticle)
      onNavigate?.('qa', { articleId: targetArticle.id })
    },
    [qa, onNavigate],
  )

  const feed = useFeed({
    contentApi,
    enabled: Boolean(user) && route === 'feed',
    expire,
    openArticle,
    onNavigate,
    savedOverrides,
    toggleSave,
    onAskAboutArticle: articleAskHandler,
  })
  const search = useSearch({
    contentApi,
    expire,
    openArticle,
    savedOverrides,
    toggleSave,
    initialParams: routeSearchParams,
    onSearchSubmit: (query) => onNavigate?.('search', { searchParams: query }),
    onAskAboutArticle: articleAskHandler,
  })
  const saved = useSaved({
    contentApi,
    csrfToken,
    enabled: Boolean(user) && route === 'saved',
    expire,
    markSaved,
    openArticle,
    onNavigate,
    onAskAboutArticle: articleAskHandler,
  })
  const activeArticleId = routeArticleId ?? articleId
  const articleState = useArticle({
    articleId: activeArticleId,
    contentApi,
    enabled: Boolean(user) && route === 'article',
    expire,
    onBack: () => onNavigate?.(articleReturnRoute || 'feed', { back: true }),
    onAskAboutArticle: articleAskHandler,
  })
  const article = {
    ...articleState,
    onAskAboutArticle: articleAskHandler,
  }
  const account = useAccount({ accountActions, expire, sessionNotice, csrfToken, user })
  return { feed, search, saved, article, qa, account, onLogout: account.onLogout }
}

function useFeed({
  contentApi,
  enabled,
  expire,
  openArticle,
  onNavigate,
  savedOverrides,
  toggleSave,
  onAskAboutArticle,
}) {
  const [state, setState] = useState('loading')
  const [articles, setArticles] = useState([])
  const [sources, setSources] = useState(() => CANONICAL_SOURCES.map(s => ({ ...s, status: 'active' })))
  const sourcesRef = useRef(CANONICAL_SOURCES.map(s => ({ ...s, status: 'active' })))
  
  const [filters, setFilters] = useState(EMPTY_FILTERS)
  const [applied, setApplied] = useState(EMPTY_FILTERS)
  const [errors, setErrors] = useState({})
  const [error, setError] = useState(null)
  const [meta, setMeta] = useState({ hasNext: false, nextCursor: null })
  const [page, setPage] = useState(1)
  const [cursors, setCursors] = useState([null])
  const [applying, setApplying] = useState(false)
  const [pendingArticleId, setPendingArticleId] = useState(null)
  const [saveError, setSaveError] = useState(null)
  const failedSave = useRef(null)
  const saveInFlightRef = useRef(false)
  const requestSequence = useRef(0)
  const failedRequest = useRef(null)
  const hasAttemptedRef = useRef(false)

  const updateSources = useCallback((newArticles = [], newMetaSources = []) => {
    const merged = mergeSourceOptions(sourcesRef.current, newArticles, newMetaSources)
    sourcesRef.current = merged
    setSources(merged)
  }, [])

  const load = useCallback(
    async ({ values = applied, targetPage = 1, cursor = null, requestedPage = 1, lastPage = false, filterChange = false } = {}) => {
      const sequence = requestSequence.current + 1
      requestSequence.current = sequence
      failedRequest.current = { values, targetPage, cursor, requestedPage, lastPage, filterChange }
      setState('loading')
      setError(null)
      setApplying(filterChange)
      try {
        const response = await contentApi.listArticles({
          limit: PAGE_SIZE,
          ...queryValues(values),
          ...(lastPage ? { lastPage: true } : cursor ? { cursor } : requestedPage > 1 ? { page: requestedPage } : {}),
        })
        if (sequence !== requestSequence.current) return null
        const nextMeta = responseMeta(response)
        const responseTotalItems = Number(nextMeta.totalItems)
        const resolvedPage = lastPage && Number.isFinite(responseTotalItems)
          ? Math.max(1, Math.ceil(responseTotalItems / PAGE_SIZE))
          : targetPage
        const nextArticles = responseData(response, [])
        setArticles(nextArticles)
        
        updateSources(nextArticles, nextMeta.sources ?? response?.sources ?? [])

        setMeta(nextMeta)
        setPage(resolvedPage)
        setCursors((current) => {
          const next = current.slice(0, resolvedPage)
          next[resolvedPage - 1] = nextMeta.nextCursor ?? null
          return next
        })
        setState('ready')
        failedRequest.current = null
        return response
      } catch (requestError) {
        if (sequence !== requestSequence.current) return null
        expire(requestError)
        setError(requestError)
        setState('error')
      } finally {
        if (sequence === requestSequence.current) setApplying(false)
      }
    },
    [applied, contentApi, expire, updateSources],
  )

  useEffect(() => {
    if (!enabled) return undefined

    async function initFeedData() {
      if (!hasAttemptedRef.current) {
        hasAttemptedRef.current = true
        await load({ values: applied, targetPage: 1 })
      }

      try {
        let fetchedSources = []
        if (typeof contentApi.listSources === 'function') {
          const sourcesRes = await contentApi.listSources()
          fetchedSources = responseData(sourcesRes, Array.isArray(sourcesRes) ? sourcesRes : [])
        }
        updateSources([], fetchedSources)
      } catch (e) {}
    }

    void initFeedData()
    return undefined
  }, [enabled])

  async function save(article, nextSaved) {
    if (saveInFlightRef.current) return
    saveInFlightRef.current = true
    setPendingArticleId(article.id)
    setSaveError(null)
    failedSave.current = { article, nextSaved }
    try {
      await toggleSave(article, nextSaved)
      failedSave.current = null
      setSaveError(null)
    } catch (requestError) {
      setSaveError(requestError)
    } finally {
      setPendingArticleId(null)
      saveInFlightRef.current = false
    }
  }

  function dismissSaveError() {
    failedSave.current = null
    setSaveError(null)
  }

  function retrySave() {
    const failed = failedSave.current
    return failed ? save(failed.article, failed.nextSaved) : undefined
  }

  function submit(event) {
    event.preventDefault()
    const validation = validateFeedFilters(filters)
    setErrors(validation.errors)
    if (!validation.valid) return
    setApplied({ ...filters })
    void load({ values: filters, targetPage: 1, filterChange: true })
  }

  function clear() {
    setFilters(EMPTY_FILTERS)
    setApplied(EMPTY_FILTERS)
    setErrors({})
    void load({ values: EMPTY_FILTERS, targetPage: 1 })
  }

  async function goToPage(value) {
    const totalItems = Number(meta.totalItems)
    const totalPages = Number.isFinite(totalItems) && totalItems > 0 ? Math.ceil(totalItems / PAGE_SIZE) : 0
    const requestedPage = Math.min(Math.max(Number.parseInt(value, 10) || 1, 1), totalPages || 1)
    if (requestedPage > MAX_DIRECT_PAGE && requestedPage !== totalPages) return
    const targetPage = requestedPage
    if (targetPage === page) return
    if (targetPage === 1) {
      await load({ values: applied, targetPage: 1 })
      return
    }
    if (totalPages > 1 && targetPage === totalPages) {
      await load({ values: applied, targetPage, lastPage: true })
      return
    }
    await load({ values: applied, targetPage, requestedPage: targetPage })
  }

  function retryPage() {
    return load(failedRequest.current ?? { values: applied, targetPage: page, requestedPage: page, cursor: null })
  }

  function loadPreviousPage() {
    if (page <= 1 || page > MAX_DIRECT_PAGE) return false
    const cursor = cursors[page - 3]
    return load({ values: applied, targetPage: page - 1, cursor: cursor ?? null, requestedPage: cursor ? 1 : page - 1 })
  }

  function loadNextPage() {
    if (!meta.hasNext) return false
    const cursor = cursors[page - 1]
    return load({ values: applied, targetPage: page + 1, cursor: cursor ?? null, requestedPage: cursor ? 1 : page + 1 })
  }

  return {
    state,
    articles,
    sources,
    filters,
    errors,
    error,
    meta,
    page,
    applying,
    pendingArticleId,
    saveError,
    savedOverrides,
    handlers: {
      onFilterChange: (field, value) => setFilters((current) => ({ ...current, [field]: value })),
      onSubmit: submit,
      onClearFilters: clear,
      onRetry: retryPage,
      onPreviousPage: loadPreviousPage,
      onNextPage: loadNextPage,
      onFirstPage: () => goToPage(1),
      onLastPage: () => goToPage(Math.ceil(Number(meta.totalItems) / PAGE_SIZE)),
      onPageChange: (value) => goToPage(value),
      onSaveToggle: save,
      onSaveRetry: retrySave,
      onDismissSaveError: dismissSaveError,
      onOpenArticle: openArticle,
      onOpenSearch: () => onNavigate?.('search'),
      onAskAboutArticle,
    },
  }
}

function useSearch({
  contentApi,
  expire,
  openArticle,
  savedOverrides,
  toggleSave,
  initialParams = null,
  onSearchSubmit,
  onAskAboutArticle,
}) {
  const [state, setState] = useState('initial')
  const [query, setQuery] = useState(() => ({ ...EMPTY_QUERY, ...(initialParams || {}) }))
  const [submitted, setSubmitted] = useState(null)
  const [results, setResults] = useState([])
  const [meta, setMeta] = useState({ hasNext: false, nextCursor: null })
  const [errors, setErrors] = useState({})
  const [error, setError] = useState(null)
  const [page, setPage] = useState(1)
  const [cursors, setCursors] = useState([null])
  const [pendingArticleId, setPendingArticleId] = useState(null)
  const [saveError, setSaveError] = useState(null)
  const failedSave = useRef(null)
  const saveInFlightRef = useRef(false)
  const hydratedQueryKeyRef = useRef(null)
  const requestSequence = useRef(0)
  const run = useCallback(
    async (values, targetPage = 1, cursor = null) => {
      const sequence = requestSequence.current + 1
      requestSequence.current = sequence
      setState('loading')
      setError(null)
      try {
        const response = await contentApi.searchArticles({
          limit: PAGE_SIZE,
          ...queryValues(values),
          ...(cursor ? { cursor } : {}),
        })
        if (sequence !== requestSequence.current) return null
        const nextMeta = responseMeta(response)
        setResults(responseData(response, []))
        setMeta(nextMeta)
        setPage(targetPage)
        setCursors((current) => {
          const next = current.slice(0, targetPage)
          next[targetPage - 1] = nextMeta.nextCursor ?? null
          return next
        })
        setState('ready')
      } catch (requestError) {
        if (sequence !== requestSequence.current) return null
        expire(requestError)
        setError(requestError)
        setState('error')
      }
    },
    [contentApi, expire],
  )

  async function save(article, nextSaved) {
    if (saveInFlightRef.current) return
    saveInFlightRef.current = true
    setPendingArticleId(article.id)
    setSaveError(null)
    failedSave.current = { article, nextSaved }
    try {
      await toggleSave(article, nextSaved)
      failedSave.current = null
      setSaveError(null)
    } catch (requestError) {
      setSaveError(requestError)
    } finally {
      setPendingArticleId(null)
      saveInFlightRef.current = false
    }
  }

  function dismissSaveError() {
    failedSave.current = null
    setSaveError(null)
  }

  function retrySave() {
    const failed = failedSave.current
    return failed ? save(failed.article, failed.nextSaved) : undefined
  }

  useEffect(() => {
    const initialQuery = { ...EMPTY_QUERY, ...(initialParams || {}) }
    const initialKey = searchQueryKey(initialQuery)
    if (!initialQuery.q) {
      if (hydratedQueryKeyRef.current === initialKey) return
      hydratedQueryKeyRef.current = initialKey
      requestSequence.current += 1
      setQuery(initialQuery)
      setSubmitted(null)
      setResults([])
      setMeta({ hasNext: false, nextCursor: null })
      setPage(1)
      setErrors({})
      setError(null)
      setState('initial')
      return
    }
    if (hydratedQueryKeyRef.current === initialKey) return
    hydratedQueryKeyRef.current = initialKey
    setQuery(initialQuery)
    setSubmitted(initialQuery)
    void run(initialQuery)
  }, [initialParams, run])

  function submit(event) {
    event?.preventDefault?.()
    const validation = validateSearchInput(query)
    setErrors(validation.errors)
    if (!validation.valid) return
    hydratedQueryKeyRef.current = searchQueryKey(query)
    setSubmitted({ ...query })
    onSearchSubmit?.(query)
    void run(query)
  }

  return {
    state,
    query,
    results,
    meta,
    errors,
    error,
    page,
    saveError,
    pendingArticleId,
    savedOverrides,
    sources: CANONICAL_SOURCES,
    handlers: {
      onQueryChange: (field, value) => setQuery((current) => ({ ...current, [field]: value })),
      onSubmit: submit,
      onRetry: () => submitted && run(submitted),
      onPreviousPage: () =>
        page > 1 && submitted && run(submitted, page - 1, page > 2 ? cursors[page - 3] : null),
      onNextPage: () => meta.hasNext && submitted && run(submitted, page + 1, cursors[page - 1]),
      onSaveToggle: save,
      onSaveRetry: retrySave,
      onDismissSaveError: dismissSaveError,
      onOpenArticle: openArticle,
      onAskAboutArticle,
    },
  }
}

function useSaved({ contentApi, csrfToken, enabled, expire, markSaved, openArticle, onNavigate, onAskAboutArticle }) {
  const [state, setState] = useState('loading')
  const [articles, setArticles] = useState([])
  const [meta, setMeta] = useState({ hasNext: false, nextCursor: null, page: 1 })
  const [error, setError] = useState(null)
  const [saveError, setSaveError] = useState(null)
  const [pendingArticleId, setPendingArticleId] = useState(null)
  const [clearOpen, setClearOpen] = useState(false)
  const [clearBusy, setClearBusy] = useState(false)
  const hasAttemptedRef = useRef(false)
  const failedSave = useRef(null)
  const saveInFlightRef = useRef(false)
  const load = useCallback(async () => {
    setState('loading')
    setError(null)
    try {
      const response = await contentApi.listSavedArticles({ limit: 100 })
      const items = responseData(response, [])
      setArticles(items)
      setMeta({ ...responseMeta(response), page: 1 })
      items.forEach((item) => markSaved(item.id, true))
      setState('ready')
    } catch (requestError) {
      expire(requestError)
      setError(requestError)
      setState('error')
    }
  }, [contentApi, expire, markSaved])

  useEffect(() => {
    if (!enabled || hasAttemptedRef.current) return undefined
    hasAttemptedRef.current = true
    const task = Promise.resolve().then(load)
    void task
    return undefined
  }, [enabled, load])

  async function unsave(article) {
    if (!csrfToken || saveInFlightRef.current) return
    saveInFlightRef.current = true
    setPendingArticleId(article.id)
    setSaveError(null)
    failedSave.current = { article, nextSaved: false }
    try {
      await contentApi.unsaveArticle(article.id, csrfToken)
      failedSave.current = null
      setArticles((current) => current.filter((item) => item.id !== article.id))
      markSaved(article.id, false)
    } catch (requestError) {
      expire(requestError)
      setSaveError(requestError)
    } finally {
      setPendingArticleId(null)
      saveInFlightRef.current = false
    }
  }

  async function clear() {
    if (!csrfToken) return
    setClearBusy(true)
    setSaveError(null)
    failedSave.current = { clear: true }
    try {
      await contentApi.clearSavedArticles(csrfToken)
      failedSave.current = null
      articles.forEach((item) => markSaved(item.id, false))
      setArticles([])
      setMeta({ hasNext: false, nextCursor: null, page: 1 })
      setClearOpen(false)
      setState('ready')
    } catch (requestError) {
      expire(requestError)
      setSaveError(requestError)
    } finally {
      setClearBusy(false)
    }
  }

  function dismissSaveError() {
    failedSave.current = null
    setSaveError(null)
  }

  function retrySave() {
    const failed = failedSave.current
    if (!failed) return undefined
    if (failed.clear) return clear()
    return unsave(failed.article)
  }

  return {
    state,
    articles,
    meta,
    error,
    saveError,
    pendingArticleId,
    clearOpen,
    handlers: {
      onRetry: load,
      onUnsave: unsave,
      onOpenArticle: openArticle,
      onOpenFeed: () => onNavigate?.('feed'),
      onOpenClear: () => setClearOpen(true),
      onCancelClear: () => setClearOpen(false),
      onConfirmClear: clear,
      onSaveRetry: retrySave,
      onDismissSaveError: dismissSaveError,
      onAskAboutArticle,
      clearBusy,
    },
  }
}

function useArticle({ articleId, contentApi, enabled, expire, onBack, onAskAboutArticle }) {
  const [state, setState] = useState('loading')
  const [article, setArticle] = useState(null)
  const [error, setError] = useState(null)
  const articleCacheRef = useRef(new Map())
  const [retryRequest, setRetryRequest] = useState({ articleId: null, count: 0 })

  useEffect(() => {
    let active = true
    if (!enabled || !articleId)
      return () => {
        active = false
      }

    const bypassCache = retryRequest.articleId === articleId && retryRequest.count > 0
    if (!bypassCache && articleCacheRef.current.has(articleId)) {
      setArticle(articleCacheRef.current.get(articleId))
      setState('ready')
      setError(null)
      return () => {
        active = false
      }
    }

    setState('loading')
    setError(null)

    void Promise.resolve()
      .then(() => contentApi.getArticle(articleId))
      .then((response) => {
        if (active) {
          const item = responseData(response, null)
          if (item) articleCacheRef.current.set(articleId, item)
          setArticle(item)
          setState('ready')
          setRetryRequest((current) => current.articleId === articleId ? { articleId: null, count: 0 } : current)
        }
      })
      .catch((requestError) => {
        if (active) {
          expire(requestError)
          setError(requestError)
          setState('error')
        }
      })
    return () => {
      active = false
    }
  }, [articleId, contentApi, enabled, expire, retryRequest])

  function retry() {
    if (!enabled || !articleId) return false
    setRetryRequest((current) => current.articleId === articleId
      ? { articleId, count: current.count + 1 }
      : { articleId, count: 1 })
    return true
  }
  return { state, article, error, onBack, onAskAboutArticle, onRetry: retry }
}

export function useQa({ articleId: routeArticleId = null, contentApi, csrfToken, enabled, expire, qaApi, user, allowNaturalLanguageScope = false, scopeMode: requestedScopeMode = null } = {}) {
  const [state, setState] = useState('empty')
  const [sessions, setSessions] = useState([])
  const [messages, setMessages] = useState([])
  const initialArticleId = validQaArticleId(routeArticleId)
  const [scope, setScope] = useState(() => ({
    topics: Array.isArray(user?.topicPreferences) ? user.topicPreferences.slice(0, 10) : [],
    ...(initialArticleId ? { articleId: initialArticleId } : {}),
  }))
  const [error, setError] = useState(null)
  const [scopeModeState, setScopeModeState] = useState(null)
  const [scopeProposal, setScopeProposal] = useState(null)
  const [scopeConfirmation, setScopeConfirmation] = useState(null)
  const sessionIdRef = useRef(undefined)
  const queueTailRef = useRef(null)
  const epochRef = useRef(0)
  const sessionResetEpochRef = useRef(null)
  const pendingNaturalQuestionRef = useRef('')
  const naturalScopeAllowed = allowNaturalLanguageScope === true || requestedScopeMode === 'natural-language'
  const defaultScopeMode = naturalScopeAllowed ? 'natural-language' : 'explicit'
  function resetNaturalScope() {
    pendingNaturalQuestionRef.current = ''
    setScopeModeState(defaultScopeMode)
    setScopeProposal(null)
    setScopeConfirmation(null)
  }

  const listEpochRef = useRef(0)
  const routeArticleRef = useRef(initialArticleId)
  const routeArticleChanged = routeArticleRef.current !== initialArticleId

  const identityKey = JSON.stringify([user?.id ?? user?._id ?? null, csrfToken ?? null])
  const identityRef = useRef(identityKey)
  const identityChanged = identityRef.current !== identityKey
  if (identityChanged) {
    identityRef.current = identityKey
    epochRef.current += 1
    listEpochRef.current += 1
    sessionIdRef.current = undefined
    sessionResetEpochRef.current = epochRef.current
  }
  useEffect(() => {
    if (!identityChanged) return undefined
    const nextTopics = Array.isArray(user?.topicPreferences) ? user.topicPreferences.slice(0, 10) : []
    setSessions([])
    setMessages([])
    setScope({ topics: nextTopics, ...(enabled && initialArticleId ? { articleId: initialArticleId } : {}) })
    setState('empty')
    setError(null)
    resetNaturalScope()
    return undefined
  }, [identityChanged, identityKey])
  useEffect(() => {
    if (!routeArticleChanged || routeArticleRef.current === initialArticleId) return undefined
    routeArticleRef.current = initialArticleId
    epochRef.current += 1
    listEpochRef.current += 1
    sessionIdRef.current = undefined
    sessionResetEpochRef.current = epochRef.current
    setSessions([])
    setMessages([])
    setScope((current) => qaScopeForArticle(current, initialArticleId))
    setState('empty')
    setError(null)
    resetNaturalScope()
    return undefined
  }, [initialArticleId, routeArticleChanged])

  useEffect(() => {
    if (!enabled) return undefined
    setScope((current) => {
      if (initialArticleId) return current.articleId === initialArticleId ? current : { ...current, articleId: initialArticleId }
      if (!Object.prototype.hasOwnProperty.call(current, 'articleId')) return current
      const { articleId: _removed, article: _removedArt, ...rest } = current
      return rest
    })
    return undefined
  }, [enabled, initialArticleId])
  function resetSessionForScopeChange(updateScope) {
    epochRef.current += 1
    sessionResetEpochRef.current = epochRef.current
    sessionIdRef.current = undefined
    setMessages([])
    setState('empty')
    setError(null)
    resetNaturalScope()
    setScope((current) => ({ ...updateScope(current), sessionId: undefined }))
  }

  useEffect(() => {
    if (!enabled || !initialArticleId || !contentApi?.getArticle) return undefined
    let active = true
    contentApi
      .getArticle(initialArticleId)
      .then((response) => {
        if (!active) return
        const item = responseData(response, null)
        if (item) {
          setScope((current) => {
            if (current.articleId !== initialArticleId || current.article === item) return current
            return { ...current, article: item }
          })
        }
      })
      .catch(() => {})
    return () => {
      active = false
    }
  }, [contentApi, enabled, initialArticleId])

  return {
    state,
    sessions,
    messages,
    scope,
    error,
    scopeMode: scopeModeState ?? defaultScopeMode,
    scopeProposal,
    scopeConfirmation,
    handlers: {
      onTopicToggle: (topic) => resetSessionForScopeChange((current) => ({ ...current, topics: toggleTopicValue(current.topics ?? [], topic) })),
      onFilterChange: (field, value) => resetSessionForScopeChange((current) => ({ ...current, [field]: value })),
      onClearArticleScope: () => resetSessionForScopeChange((current) => qaScopeForArticle(current, null)),
      onScopeArticleId: (article) => {
        if (!article?.id) return
        resetSessionForScopeChange((current) => qaScopeForArticle(current, article.id, article))
      },
    },
  }
}

function useAccount({ accountActions, expire, sessionNotice, csrfToken, user }) {
  return {
    user,
    sessionNotice,
    onLogout: async () => {
      if (!csrfToken) return
      try {
        await accountActions?.logout?.(csrfToken)
      } catch (error) {
        expire(error)
      }
    },
  }
}
