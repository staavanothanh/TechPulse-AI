import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { createContentApi } from '../../features/feed/content-api.js'
import { validateFeedFilters } from '../../features/feed/feed-validation.js'
import { validateSearchInput } from '../../features/search/search-validation.js'
import { createQaApi } from '../../features/qa/qa-api.js'
import {
  validateAnswerPayload,
  validateQuestionScope,
  validateSessionDetail,
} from '../../features/qa/qa-validation.js'
import { topicsMatch } from '../../../shared/topic-catalog.js'

const PAGE_SIZE = 10
const MAX_DIRECT_PAGE = 10_000
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

function responseData(response, fallback) {
  return response?.data ?? fallback
}

function responseMeta(response) {
  return response?.meta ?? { hasNext: false, nextCursor: null }
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

  const feed = useFeed({
    contentApi,
    enabled: Boolean(user) && route === 'feed',
    expire,
    openArticle,
    onNavigate,
    savedOverrides,
    toggleSave,
  })
  const search = useSearch({
    contentApi,
    expire,
    openArticle,
    savedOverrides,
    toggleSave,
    initialParams: routeSearchParams,
    onSearchSubmit: (query) => onNavigate?.('search', { searchParams: query }),
  })
  const saved = useSaved({
    contentApi,
    csrfToken,
    enabled: Boolean(user) && route === 'saved',
    expire,
    markSaved,
    openArticle,
    onNavigate,
  })
  const activeArticleId = routeArticleId ?? articleId
  const article = useArticle({
    articleId: activeArticleId,
    contentApi,
    enabled: Boolean(user) && route === 'article',
    expire,
    onBack: () => onNavigate?.(articleReturnRoute || 'feed', { back: true }),
  })
  const qa = useQa({ csrfToken, enabled: Boolean(user) && route === 'qa', expire, qaApi, user })
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
}) {
  const [state, setState] = useState('loading')
  const [articles, setArticles] = useState([])
  const [filters, setFilters] = useState(EMPTY_FILTERS)
  const [applied, setApplied] = useState(EMPTY_FILTERS)
  const [errors, setErrors] = useState({})
  const [error, setError] = useState(null)
  const [meta, setMeta] = useState({ hasNext: false, nextCursor: null })
  const [page, setPage] = useState(1)
  const [cursors, setCursors] = useState([null])
  const [applying, setApplying] = useState(false)
  const [pendingArticleId, setPendingArticleId] = useState(null)
  const requestSequence = useRef(0)
  const failedRequest = useRef(null)
  const hasAttemptedRef = useRef(false)
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
        setArticles(responseData(response, []))
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
    [applied, contentApi, expire],
  )

  useEffect(() => {
    if (!enabled || hasAttemptedRef.current) return undefined
    hasAttemptedRef.current = true
    const task = Promise.resolve().then(() => load({ values: applied, targetPage: 1 }))
    void task
    return undefined
  }, [enabled]) // eslint-disable-line react-hooks/exhaustive-deps

  async function save(article, nextSaved) {
    setPendingArticleId(article.id)
    try {
      await toggleSave(article, nextSaved)
    } catch {
      /* The view keeps its current state and session recovery owns auth failures. */
    } finally {
      setPendingArticleId(null)
    }
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
    filters,
    errors,
    error,
    meta,
    page,
    applying,
    pendingArticleId,
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
      onOpenArticle: openArticle,
      onOpenSearch: () => onNavigate?.('search'),
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
  const hasHydratedRef = useRef(false)
  const run = useCallback(
    async (values, targetPage = 1, cursor = null) => {
      setState('loading')
      setError(null)
      try {
        const response = await contentApi.searchArticles({
          limit: PAGE_SIZE,
          ...queryValues(values),
          ...(cursor ? { cursor } : {}),
        })
        setResults(responseData(response, []))
        setMeta(responseMeta(response))
        setPage(targetPage)
        setCursors((current) => {
          const next = current.slice(0, targetPage)
          next[targetPage - 1] = responseMeta(response).nextCursor ?? null
          return next
        })
        setState('ready')
      } catch (requestError) {
        expire(requestError)
        setError(requestError)
        setState('error')
      }
    },
    [contentApi, expire],
  )

  async function save(article, nextSaved) {
    setPendingArticleId(article.id)
    try {
      await toggleSave(article, nextSaved)
    } catch {
      /* Session recovery and the existing saved state remain authoritative. */
    } finally {
      setPendingArticleId(null)
    }
  }

  useEffect(() => {
    if (initialParams?.q && !hasHydratedRef.current) {
      hasHydratedRef.current = true
      const initialQuery = { ...EMPTY_QUERY, ...initialParams }
      setQuery(initialQuery)
      setSubmitted(initialQuery)
      void run(initialQuery)
    }
  }, [initialParams, run])

  function submit(event) {
    event?.preventDefault?.()
    const validation = validateSearchInput(query)
    setErrors(validation.errors)
    if (!validation.valid) return
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
    pendingArticleId,
    savedOverrides,
    handlers: {
      onQueryChange: (field, value) => setQuery((current) => ({ ...current, [field]: value })),
      onSubmit: submit,
      onRetry: () => submitted && run(submitted),
      onPreviousPage: () =>
        page > 1 && submitted && run(submitted, page - 1, page > 2 ? cursors[page - 3] : null),
      onNextPage: () => meta.hasNext && submitted && run(submitted, page + 1, cursors[page - 1]),
      onSaveToggle: save,
      onOpenArticle: openArticle,
    },
  }
}

function useSaved({ contentApi, csrfToken, enabled, expire, markSaved, openArticle, onNavigate }) {
  const [state, setState] = useState('loading')
  const [articles, setArticles] = useState([])
  const [meta, setMeta] = useState({ hasNext: false, nextCursor: null, page: 1 })
  const [error, setError] = useState(null)
  const [pendingArticleId, setPendingArticleId] = useState(null)
  const [clearOpen, setClearOpen] = useState(false)
  const [clearBusy, setClearBusy] = useState(false)
  const hasAttemptedRef = useRef(false)
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
    if (!csrfToken) return
    setPendingArticleId(article.id)
    try {
      await contentApi.unsaveArticle(article.id, csrfToken)
      setArticles((current) => current.filter((item) => item.id !== article.id))
      markSaved(article.id, false)
    } catch (requestError) {
      expire(requestError)
      setError(requestError)
    } finally {
      setPendingArticleId(null)
    }
  }

  async function clear() {
    if (!csrfToken) return
    setClearBusy(true)
    try {
      await contentApi.clearSavedArticles(csrfToken)
      articles.forEach((item) => markSaved(item.id, false))
      setArticles([])
      setMeta({ hasNext: false, nextCursor: null, page: 1 })
      setClearOpen(false)
      setState('ready')
    } catch (requestError) {
      expire(requestError)
      setError(requestError)
    } finally {
      setClearBusy(false)
    }
  }

  return {
    state,
    articles,
    meta,
    error,
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
      clearBusy,
    },
  }
}

function useArticle({ articleId, contentApi, enabled, expire, onBack }) {
  const [state, setState] = useState('loading')
  const [article, setArticle] = useState(null)
  const [error, setError] = useState(null)
  const articleCacheRef = useRef(new Map())

  useEffect(() => {
    let active = true
    if (!enabled || !articleId)
      return () => {
        active = false
      }

    if (articleCacheRef.current.has(articleId)) {
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
  }, [articleId, contentApi, enabled, expire])
  return { state, article, error, onBack }
}

export function useQa({ csrfToken, enabled, expire, qaApi, user }) {
  const [state, setState] = useState('empty')
  const [sessions, setSessions] = useState([])
  const [messages, setMessages] = useState([])
  const [scope, setScope] = useState(() => ({
    topics: Array.isArray(user?.topicPreferences) ? user.topicPreferences.slice(0, 10) : [],
  }))
  const [error, setError] = useState(null)
  const sessionIdRef = useRef(undefined)
  const queueTailRef = useRef(null)
  const epochRef = useRef(0)
  const listEpochRef = useRef(0)
  const identityKey = JSON.stringify([user?.id ?? user?._id ?? null, csrfToken ?? null])
  const identityRef = useRef(identityKey)
  const identityChanged = identityRef.current !== identityKey
  if (identityChanged) {
    identityRef.current = identityKey
    epochRef.current += 1
    listEpochRef.current += 1
    sessionIdRef.current = undefined
  }
  useEffect(() => {
    if (!identityChanged) return undefined
    const nextTopics = Array.isArray(user?.topicPreferences) ? user.topicPreferences.slice(0, 10) : []
    setSessions([])
    setMessages([])
    setScope({ topics: nextTopics })
    setState('empty')
    setError(null)
    return undefined
  }, [identityChanged, identityKey])

  function trackQueue(taskPromise) {
    let tail
    tail = taskPromise.then(
      () => {
        if (queueTailRef.current === tail) queueTailRef.current = null
      },
      () => {
        if (queueTailRef.current === tail) queueTailRef.current = null
      },
    )
    queueTailRef.current = tail
    return taskPromise
  }

  function enqueue(task) {
    const prev = queueTailRef.current
    if (!prev) return trackQueue(task())
    return trackQueue(prev.catch(() => {}).then(task))
  }

  const loadSessions = useCallback(async () => {
    const listEpoch = ++listEpochRef.current
    try {
      const response = await qaApi.listSessions({ limit: 100 })
      if (listEpoch !== listEpochRef.current) return
      setSessions(responseData(response, []))
    } catch (requestError) {
      if (listEpoch !== listEpochRef.current) return
      expire(requestError)
      setError(requestError)
      setState('error')
    }
  }, [expire, qaApi])
  useEffect(() => {
    if (!enabled) return undefined
    const task = Promise.resolve().then(loadSessions)
    void task
    return undefined
  }, [enabled, loadSessions])

  async function selectSession(id) {
    const epoch = ++epochRef.current
    sessionIdRef.current = id
    setState('loading')
    setError(null)
    try {
      const response = await qaApi.getSession(id)
      if (epoch !== epochRef.current) return
      const checked = validateSessionDetail(responseData(response, {}))
      if (!checked.valid)
        throw Object.assign(new Error('Phiên hỏi đáp có định dạng không hợp lệ.'), { status: 502 })
      setMessages(checked.detail.messages)
      setScope((current) => ({ ...current, sessionId: id }))
      setState('ready')
    } catch (requestError) {
      if (epoch !== epochRef.current) return
      expire(requestError)
      setError(requestError)
      setState('error')
    }
  }

  async function ask(payload) {
    const validation = validateQuestionScope(payload.question, payload)
    if (!validation.valid) {
      setError(new Error(validation.message))
      setState('error')
      return
    }
    const epoch = epochRef.current
    setState('loading')
    setError(null)

    const runTask = async () => {
      if (epoch !== epochRef.current) return
      setState('loading')
      setError(null)
      const currentSessionId = sessionIdRef.current ?? payload.sessionId
      try {
        const response = await qaApi.createAnswer(
          {
            question: payload.question,
            scope: {
              ...(typeof payload.articleId === 'string' && payload.articleId.trim().length > 0 ? { articleId: payload.articleId } : {}),
              ...(Array.isArray(payload.topics) && payload.topics.length > 0 ? { topics: payload.topics } : {}),
              ...(payload.publishedAfter ? { publishedAfter: payload.publishedAfter } : {}),
              ...(payload.publishedBefore ? { publishedBefore: payload.publishedBefore } : {}),
            }
          },
          {
            csrfToken,
            idempotencyKey: globalThis.crypto?.randomUUID?.() ?? `qa-${Date.now()}`,
            chatSessionId: currentSessionId,
          },
        )
        const checked = validateAnswerPayload(response)
        if (!checked.valid) throw new Error('Câu trả lời không đáp ứng định dạng an toàn.')
        const returnedSessionId = checked.answer.chatSessionId ?? currentSessionId
        if (epoch !== epochRef.current) return
        if (returnedSessionId) sessionIdRef.current = returnedSessionId
        setMessages((current) => [
          ...current,
          { id: `question-${Date.now()}`, role: 'user', text: payload.question },
          checked.answer,
        ])
        setScope((current) => ({
          ...current,
          sessionId: returnedSessionId ?? current.sessionId,
        }))
        setState('ready')
        void loadSessions()
      } catch (requestError) {
        if (epoch !== epochRef.current) return
        expire(requestError)
        setError(requestError)
        setState('error')
      }
    }

    return enqueue(runTask)
  }

  async function clearSessions() {
    if (!csrfToken) return
    const epoch = ++epochRef.current
    listEpochRef.current += 1
    sessionIdRef.current = undefined

    const runClear = async () => {
      try {
        await qaApi.clearSessions(csrfToken)
        if (epoch !== epochRef.current) return
        sessionIdRef.current = undefined
        setSessions([])
        setMessages([])
        setScope((current) => ({ ...current, sessionId: undefined }))
        setState('empty')
      } catch (requestError) {
        if (epoch !== epochRef.current) return
        expire(requestError)
        setError(requestError)
        setState('error')
      }
    }

    return enqueue(runClear)
  }

  const displayState = identityChanged ? 'empty' : state
  const displaySessions = identityChanged ? [] : sessions
  const displayMessages = identityChanged ? [] : messages
  const displayScope = identityChanged
    ? { topics: Array.isArray(user?.topicPreferences) ? user.topicPreferences.slice(0, 10) : [] }
    : scope
  const displayError = identityChanged ? null : error
  return {
    state: displayState,
    sessions: displaySessions,
    messages: displayMessages,
    scope: displayScope,
    error: displayError,
    onAsk: ask,
    handlers: {
      onNewSession: () => {
        epochRef.current += 1
        sessionIdRef.current = undefined
        setMessages([])
        setScope((current) => ({ ...current, sessionId: undefined }))
        setState('empty')
        setError(null)
      },
      onSelectSession: selectSession,
      onClearSessions: clearSessions,
      onRetry: () => (sessionIdRef.current ? selectSession(sessionIdRef.current) : loadSessions()),
      onToggleTopic: (topic) =>
        setScope((current) => ({
          ...current,
          topics: toggleTopicValue(current.topics, topic),
        })),
      onScopeChange: (field, value) => {
        if (field === 'sessionId') sessionIdRef.current = value || undefined
        setScope((current) => ({ ...current, [field]: value }))
      },
    },
  }
}
function useAccount({ accountActions, csrfToken, expire, sessionNotice, user }) {
  const identityKey = user ? `user:${user.id ?? user._id ?? 'unknown'}${csrfToken ? `:${csrfToken}` : ''}` : 'guest'
  const identityRef = useRef(identityKey)
  const identityChanged = identityRef.current !== identityKey
  if (identityChanged) identityRef.current = identityKey
  const [draft, setDraft] = useState(() => (Array.isArray(user?.topicPreferences) ? [...user.topicPreferences] : []))
  const [busy, setBusy] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const [notice, setNotice] = useState(sessionNotice)
  const [error, setError] = useState(null)

  useEffect(() => {
    if (!identityChanged) return undefined
    setDraft(Array.isArray(user?.topicPreferences) ? [...user.topicPreferences] : [])
    setBusy(false)
    setDeleting(false)
    setNotice(sessionNotice)
    setError(null)
    return undefined
  }, [identityChanged, identityKey, sessionNotice, user])

  const displayDraft = identityChanged ? (Array.isArray(user?.topicPreferences) ? [...user.topicPreferences] : []) : draft
  const displayNotice = identityChanged ? sessionNotice : notice
  const displayError = identityChanged ? null : error
  const displayBusy = identityChanged ? false : busy
  const displayDeleting = identityChanged ? false : deleting

  async function run(action, setPending, successNotice) {
    const requestIdentity = identityKey
    setPending(true)
    setError(null)
    setNotice(null)
    try {
      await action()
      if (identityRef.current !== requestIdentity) return
      if (successNotice) setNotice(successNotice)
    } catch (requestError) {
      if (identityRef.current !== requestIdentity) return
      if (requestError?.status === 401) expire(requestError, requestIdentity)
      setError(requestError)
    } finally {
      if (identityRef.current === requestIdentity) setPending(false)
    }
  }

  return {
    user: user ? { ...user, topicPreferences: displayDraft } : null,
    saving: displayBusy,
    deleting: displayDeleting,
    notice: displayNotice,
    error: displayError,
    onToggleTopic: (topic) => setDraft((current) => toggleTopicValue(current, topic)),
    onSavePreferences: () => run(() => accountActions.updatePreferences(displayDraft), setBusy, 'Đã lưu chủ đề quan tâm.'),
    onRequestDeletion: () => run(accountActions.requestDeletion, setDeleting),
    onLogout: () => run(accountActions.logout, setBusy),
  }
}
