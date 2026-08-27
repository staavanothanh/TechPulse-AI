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

  const expire = useCallback(
    (error) => {
      const expired = error?.status === 401
      if (expired) onSessionExpired?.('Phiên đăng nhập không còn hợp lệ. Vui lòng đăng nhập lại.')
      return expired
    },
    [onSessionExpired],
  )

  const markSaved = useCallback((id, value) => {
    setSavedOverrides((current) => ({ ...current, [id]: value }))
  }, [])

  const openArticle = useCallback(
    (id) => {
      if (!id) return
      setArticleId(id)
      setArticleReturnRoute(route === 'search' || route === 'saved' ? route : 'feed')
      onNavigate?.('article')
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
  const search = useSearch({ contentApi, expire, openArticle, savedOverrides, toggleSave })
  const saved = useSaved({
    contentApi,
    csrfToken,
    enabled: Boolean(user) && route === 'saved',
    expire,
    markSaved,
    openArticle,
    onNavigate,
  })
  const article = useArticle({
    articleId,
    contentApi,
    enabled: Boolean(user) && route === 'article',
    expire,
    onBack: () => onNavigate?.(articleReturnRoute),
  })
  const qa = useQa({ csrfToken, enabled: Boolean(user) && route === 'qa', expire, qaApi, user })
  const account = useAccount({ accountActions, onSessionExpired, sessionNotice, user })

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
    if (!enabled) return undefined
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

function useSearch({ contentApi, expire, openArticle, savedOverrides, toggleSave }) {
  const [state, setState] = useState('initial')
  const [query, setQuery] = useState(EMPTY_QUERY)
  const [submitted, setSubmitted] = useState(null)
  const [results, setResults] = useState([])
  const [meta, setMeta] = useState({ hasNext: false, nextCursor: null })
  const [errors, setErrors] = useState({})
  const [error, setError] = useState(null)
  const [page, setPage] = useState(1)
  const [cursors, setCursors] = useState([null])
  const [pendingArticleId, setPendingArticleId] = useState(null)

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

  function submit(event) {
    event.preventDefault()
    const validation = validateSearchInput(query)
    setErrors(validation.errors)
    if (!validation.valid) return
    setSubmitted({ ...query })
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
    if (!enabled) return undefined
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
  useEffect(() => {
    let active = true
    if (!enabled || !articleId)
      return () => {
        active = false
      }
    void Promise.resolve()
      .then(() => {
        if (active) {
          setState('loading')
          setError(null)
        }
        return contentApi.getArticle(articleId)
      })
      .then((response) => {
        if (active) {
          setArticle(responseData(response, null))
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

function useQa({ csrfToken, enabled, expire, qaApi, user }) {
  const [state, setState] = useState('empty')
  const [sessions, setSessions] = useState([])
  const [messages, setMessages] = useState([])
  const [scope, setScope] = useState(() => ({
    topics: Array.isArray(user?.topicPreferences) ? user.topicPreferences.slice(0, 10) : [],
  }))
  const [error, setError] = useState(null)

  const loadSessions = useCallback(async () => {
    try {
      const response = await qaApi.listSessions({ limit: 100 })
      setSessions(responseData(response, []))
    } catch (requestError) {
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
    setState('loading')
    setError(null)
    try {
      const response = await qaApi.getSession(id)
      const checked = validateSessionDetail(responseData(response, {}))
      if (!checked.valid)
        throw Object.assign(new Error('Phiên hỏi đáp có định dạng không hợp lệ.'), { status: 502 })
      setMessages(checked.detail.messages)
      setScope((current) => ({ ...current, sessionId: id }))
      setState('ready')
    } catch (requestError) {
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
    setState('loading')
    setError(null)
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
          chatSessionId: payload.sessionId,
        },
      )
      const checked = validateAnswerPayload(response)
      if (!checked.valid) throw new Error('Câu trả lời không đáp ứng định dạng an toàn.')
      setMessages((current) => [
        ...current,
        { id: `question-${Date.now()}`, role: 'user', text: payload.question },
        checked.answer,
      ])
      setScope((current) => ({
        ...current,
        sessionId: checked.answer.chatSessionId ?? current.sessionId,
      }))
      setState('ready')
      void loadSessions()
    } catch (requestError) {
      expire(requestError)
      setError(requestError)
      setState('error')
    }
  }

  async function clearSessions() {
    if (!csrfToken) return
    try {
      await qaApi.clearSessions(csrfToken)
      setSessions([])
      setMessages([])
      setScope((current) => ({ ...current, sessionId: undefined }))
      setState('empty')
    } catch (requestError) {
      expire(requestError)
      setError(requestError)
      setState('error')
    }
  }

  return {
    state,
    sessions,
    messages,
    scope,
    error,
    onAsk: ask,
    handlers: {
      onNewSession: () => {
        setMessages([])
        setScope((current) => ({ ...current, sessionId: undefined }))
        setState('empty')
      },
      onSelectSession: selectSession,
      onClearSessions: clearSessions,
      onRetry: scope.sessionId ? () => selectSession(scope.sessionId) : loadSessions,
      onToggleTopic: (topic) =>
        setScope((current) => ({
          ...current,
          topics: current.topics.includes(topic)
            ? current.topics.filter((item) => item !== topic)
            : [...current.topics, topic],
        })),
      onScopeChange: (field, value) => setScope((current) => ({ ...current, [field]: value })),
    },
  }
}

function useAccount({ accountActions, onSessionExpired, sessionNotice, user }) {
  const [draft, setDraft] = useState(() =>
    Array.isArray(user?.topicPreferences) ? [...user.topicPreferences] : [],
  )
  const [busy, setBusy] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const [notice, setNotice] = useState(sessionNotice)
  const [error, setError] = useState(null)
  async function run(action, setPending, successNotice) {
    setPending(true)
    setError(null)
    setNotice(null)
    try {
      await action()
      if (successNotice) setNotice(successNotice)
    } catch (requestError) {
      if (requestError?.status === 401)
        onSessionExpired?.('Phiên đăng nhập không còn hợp lệ. Vui lòng đăng nhập lại.')
      setError(requestError)
    } finally {
      setPending(false)
    }
  }

  return {
    user: user ? { ...user, topicPreferences: draft } : null,
    saving: busy,
    deleting,
    notice,
    error,
    onToggleTopic: (topic) =>
      setDraft((current) =>
        current.includes(topic) ? current.filter((item) => item !== topic) : [...current, topic],
      ),
    onSavePreferences: () =>
      run(() => accountActions.updatePreferences(draft), setBusy, 'Đã lưu chủ đề quan tâm.'),
    onRequestDeletion: () => run(accountActions.requestDeletion, setDeleting),
    onLogout: () => run(accountActions.logout, setBusy),
  }
}
