import React from 'react'
import { describe, expect, it, vi } from 'vitest'
import {
  parsePublicPath,
  publicRouteToPath,
} from '../../../client/app/integration/routing.js'
import { usePublicIntegration, useQa } from '../../../client/app/integration/use-public-integration.js'

function createHookRunner(hookFn) {
  let hookIndex = 0
  const hooks = []
  const effectCleanups = []
  let pendingEffects = []
  let currentProps
  let latestResult

  const dispatcher = {
    useState(initial) {
      const index = hookIndex++
      if (hooks[index] === undefined) hooks[index] = typeof initial === 'function' ? initial() : initial
      return [hooks[index], (next) => {
        hooks[index] = typeof next === 'function' ? next(hooks[index]) : next
      }]
    },
    useRef(initial) {
      const index = hookIndex++
      if (hooks[index] === undefined) hooks[index] = { current: initial }
      return hooks[index]
    },
    useCallback(fn, deps) {
      const index = hookIndex++
      const previous = hooks[index]
      if (previous && deps && previous.deps?.length === deps.length && previous.deps.every((value, offset) => Object.is(value, deps[offset]))) return previous.fn
      hooks[index] = { fn, deps }
      return fn
    },
    useMemo(fn, deps) {
      const index = hookIndex++
      const previous = hooks[index]
      if (previous && deps && previous.deps?.length === deps.length && previous.deps.every((value, offset) => Object.is(value, deps[offset]))) return previous.value
      const value = fn()
      hooks[index] = { value, deps }
      return value
    },
    useEffect(effect, deps) {
      const index = hookIndex++
      const previous = hooks[index]
      const changed = !previous || !deps || !previous.deps || previous.deps.length !== deps.length || !previous.deps.every((value, offset) => Object.is(value, deps[offset]))
      hooks[index] = { deps }
      if (changed) pendingEffects.push({ index, effect })
    },
  }

  function render(props = currentProps) {
    currentProps = props
    hookIndex = 0
    pendingEffects = []
    const internals = React.__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE
    const previousDispatcher = internals.H
    internals.H = dispatcher
    try {
      latestResult = hookFn(props)
    } finally {
      internals.H = previousDispatcher
    }
    for (const { index, effect } of pendingEffects) {
      if (typeof effectCleanups[index] === 'function') effectCleanups[index]()
      const cleanup = effect()
      effectCleanups[index] = typeof cleanup === 'function' ? cleanup : undefined
    }
    return latestResult
  }

  return {
    render,
    get current() {
      return latestResult
    },
  }
}

function response(data, meta = { hasNext: false }) {
  return { data, meta }
}

async function flushMicrotasks(count = 10) {
  for (let index = 0; index < count; index += 1) await Promise.resolve()
}
function deferred() {
  let resolve
  let reject
  const promise = new Promise((promiseResolve, promiseReject) => {
    resolve = promiseResolve
    reject = promiseReject
  })
  return { promise, resolve, reject }
}


const article = {
  id: '507f1f77bcf86cd799439011',
  titleVi: 'Bài kiểm thử',
  titleOriginal: 'Test article',
  source: { id: 'source-a', name: 'Nguồn A' },
  topics: ['AI'],
}

function integrationProps(overrides = {}) {
  return {
    api: {},
    csrfToken: 'csrf-token',
    user: { id: 'user-1', topicPreferences: ['AI'] },
    route: 'feed',
    onNavigate: vi.fn(),
    onSessionExpired: vi.fn(),
    accountActions: {},
    ...overrides,
  }
}

describe('public integration request and state regressions', () => {
  it('performs one search GET when submit navigation hydrates the URL', async () => {
    const api = { searchArticles: vi.fn().mockResolvedValue(response([article])) }
    const props = integrationProps({ api, route: 'search', searchParams: null })
    const runner = createHookRunner(usePublicIntegration)

    let result = runner.render(props)
    result.search.handlers.onQueryChange('q', 'AI')
    result = runner.render(props)
    result.search.handlers.onSubmit({ preventDefault: vi.fn() })

    runner.render({ ...props, searchParams: { q: 'AI', mode: 'hybrid', topic: '', sourceId: '' } })
    await flushMicrotasks()
    result = runner.render({ ...props, searchParams: { q: 'AI', mode: 'hybrid', topic: '', sourceId: '' } })

    expect(api.searchArticles).toHaveBeenCalledTimes(1)
    expect(result.search.state).toBe('ready')
  })
  it('does not let a pending search repopulate the clean URL or expire the session', async () => {
    const pendingSearch = deferred()
    const expire = vi.fn()
    const api = { searchArticles: vi.fn().mockReturnValue(pendingSearch.promise) }
    const runner = createHookRunner(usePublicIntegration)
    const searchedProps = integrationProps({ api, route: 'search', searchParams: { q: 'AI' }, onSessionExpired: expire })
    const cleanProps = { ...searchedProps, searchParams: null }

    runner.render(searchedProps)
    await flushMicrotasks()
    expect(api.searchArticles).toHaveBeenCalledTimes(1)

    runner.render(cleanProps)
    let result = runner.render(cleanProps)
    expect(result.search.state).toBe('initial')
    expect(result.search.results).toEqual([])

    pendingSearch.resolve(response([article]))
    await flushMicrotasks()
    result = runner.render(cleanProps)

    expect(result.search.state).toBe('initial')
    expect(result.search.results).toEqual([])
    expect(expire).not.toHaveBeenCalled()
  })
  it('keeps the newest search results and metadata when an older request resolves later', async () => {
    const articleA = { ...article, id: '507f1f77bcf86cd7994390a1', titleVi: 'Kết quả A' }
    const articleB = { ...article, id: '507f1f77bcf86cd7994390b2', titleVi: 'Kết quả B' }
    const searchA = deferred()
    const searchB = deferred()
    const metaA = { hasNext: true, nextCursor: 'cursor-a' }
    const metaB = { hasNext: false, nextCursor: null }
    const api = {
      searchArticles: vi.fn().mockImplementationOnce(() => searchA.promise).mockImplementationOnce(() => searchB.promise),
    }
    const props = integrationProps({ api, route: 'search', searchParams: null })
    const runner = createHookRunner(usePublicIntegration)

    let result = runner.render(props)
    result.search.handlers.onQueryChange('q', 'query-A')
    result = runner.render(props)
    result.search.handlers.onSubmit({ preventDefault: vi.fn() })
    result = runner.render(props)
    result.search.handlers.onQueryChange('q', 'query-B')
    result = runner.render(props)
    result.search.handlers.onSubmit({ preventDefault: vi.fn() })
    await flushMicrotasks()

    expect(api.searchArticles).toHaveBeenCalledTimes(2)
    expect(props.onNavigate.mock.calls.map(([, options]) => options.searchParams.q)).toEqual(['query-A', 'query-B'])

    searchB.resolve(response([articleB], metaB))
    await flushMicrotasks()
    result = runner.render(props)
    expect(result.search.state).toBe('ready')
    expect(result.search.results).toEqual([articleB])
    expect(result.search.meta).toEqual(metaB)

    searchA.resolve(response([articleA], metaA))
    await flushMicrotasks()
    result = runner.render(props)

    expect(result.search.state).toBe('ready')
    expect(result.search.results).toEqual([articleB])
    expect(result.search.meta).toEqual(metaB)
  })

  it('reuses a cached article after a successful retry when re-entering the same route', async () => {
    const loadError = new Error('article unavailable')
    const postCacheError = new Error('network unavailable after cache')
    const api = {
      getArticle: vi.fn()
        .mockRejectedValueOnce(loadError)
        .mockResolvedValueOnce(response(article))
        .mockRejectedValue(postCacheError),
    }
    const runner = createHookRunner(usePublicIntegration)
    const articleProps = integrationProps({ api, route: 'article', articleId: article.id })

    let result = runner.render(articleProps)
    await flushMicrotasks()
    result = runner.render(articleProps)
    expect(result.article.state).toBe('error')

    result.article.onRetry()
    runner.render(articleProps)
    await flushMicrotasks()
    result = runner.render(articleProps)
    expect(result.article.state).toBe('ready')
    expect(result.article.article).toEqual(article)
    expect(api.getArticle).toHaveBeenCalledTimes(2)

    const leaveProps = integrationProps({ api, route: 'search', searchParams: null })
    runner.render(leaveProps)
    runner.render(articleProps)
    await flushMicrotasks()
    result = runner.render(articleProps)

    expect(result.article.state).toBe('ready')
    expect(result.article.article).toEqual(article)
    expect(api.getArticle).toHaveBeenCalledTimes(2)
  })


  it('exposes source options and sends the selected source filter to feed GET', async () => {
    const observedUrls = []
    const originalFetch = globalThis.fetch
    globalThis.fetch = vi.fn(async (input) => {
      observedUrls.push(String(input))
      return { headers: { get: () => null } }
    })
    const api = {
      listArticles: vi.fn(async (init) => {
        await init.fetchImpl('https://example.test/api/v1/articles')
        return response([article])
      }),
    }
    const props = integrationProps({ api })
    const runner = createHookRunner(usePublicIntegration)

    try {
      let result = runner.render(props)
      await flushMicrotasks()
      result = runner.render(props)
      expect(result.feed.sources).toEqual([{ id: 'source-a', name: 'Nguồn A' }])

      result.feed.handlers.onFilterChange('sourceId', 'source-a')
      result = runner.render(props)
      result.feed.handlers.onSubmit({ preventDefault: vi.fn() })
      await flushMicrotasks()
      result = runner.render(props)

      expect(result.feed.filters.sourceId).toBe('source-a')
      expect(result.feed.sources).toEqual([{ id: 'source-a', name: 'Nguồn A' }])
      expect(new URL(observedUrls.at(-1)).searchParams.get('sourceId')).toBe('source-a')
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  it('keeps ready Q&A messages and session scope when a short question is rejected', async () => {
    const qaApi = {
      listSessions: vi.fn().mockResolvedValue(response([])),
      createAnswer: vi.fn().mockResolvedValue({
        data: {
          status: 'answered',
          chatSessionId: 'session-1',
          refusalReason: null,
          paragraphs: [{ text: 'Câu trả lời.', citationIds: ['citation-1'] }],
          citations: [{ id: 'citation-1', articleId: article.id, sourceId: 'source-a' }],
        },
      }),
    }
    const runner = createHookRunner(useQa)
    const props = { csrfToken: 'csrf-token', enabled: true, expire: vi.fn(), qaApi, user: { topicPreferences: ['AI'] } }

    runner.render(props)
    await flushMicrotasks()
    runner.render(props)
    await runner.current.onAsk({ question: 'Câu hỏi hợp lệ', topics: ['AI'] })
    await flushMicrotasks()
    let result = runner.render(props)
    const messagesBefore = result.messages

    await result.onAsk({ question: 'ab', topics: ['AI'] })
    result = runner.render(props)

    expect(result.state).toBe('ready')
    expect(result.messages).toEqual(messagesBefore)
    expect(result.scope.sessionId).toBe('session-1')
    expect(result.error).toEqual(expect.objectContaining({ message: 'Câu hỏi cần ít nhất 3 ký tự.' }))
    expect(qaApi.createAnswer).toHaveBeenCalledTimes(1)
  })

  it('round-trips a validated article-scoped Q&A URL and hydrates integration scope', () => {
    const articleId = article.id
    const parsed = parsePublicPath('/qa', `?articleId=${articleId}`)

    expect(parsed).toEqual({ route: 'qa', articleId })
    expect(publicRouteToPath('qa', { articleId })).toBe(`/qa?articleId=${articleId}`)
    expect(parsePublicPath('/qa', '?articleId=not-an-article-id')).toEqual({ route: 'qa', articleId: null })
    expect(publicRouteToPath('qa', { articleId: 'not-an-article-id' })).toBe('/qa')

    const api = { listChatSessions: vi.fn().mockResolvedValue(response([])) }
    const runner = createHookRunner(usePublicIntegration)
    const result = runner.render(integrationProps({ api, route: 'qa', articleId }))

    expect(result.qa.scope.articleId).toBe(articleId)
  })
  it('clears the article-scoped Q&A URL and local scope together', () => {
    const articleId = article.id
    const onNavigate = vi.fn()
    const api = { listChatSessions: vi.fn().mockResolvedValue(response([])) }
    const runner = createHookRunner(usePublicIntegration)
    const route = parsePublicPath('/qa', `?articleId=${articleId}`)
    const props = integrationProps({ api, ...route, onNavigate })

    let result = runner.render(props)
    expect(result.qa.scope.articleId).toBe(articleId)

    result.qa.handlers.onClearArticleScope()
    result = runner.render(props)

    expect(result.qa.scope.articleId).toBeUndefined()
    expect(onNavigate).toHaveBeenCalledWith('qa')
  })
  it('resets article-scoped Q&A state and rejects stale list/detail completions after route change', async () => {
    const articleA = '507f1f77bcf86cd799439011'
    const articleB = '507f1f77bcf86cd799439022'
    const staleList = deferred()
    const staleDetail = deferred()
    const api = {
      listChatSessions: vi.fn()
        .mockImplementationOnce(() => staleList.promise)
        .mockResolvedValue(response([])),
      getChatSession: vi.fn(() => staleDetail.promise),
      createGroundedAnswer: vi.fn().mockResolvedValue(response({
        id: 'answer-b',
        status: 'answered',
        chatSessionId: 'session-b',
        refusalReason: null,
        paragraphs: [{ text: 'Câu trả lời cho bài B.', citationIds: ['citation-b'] }],
        citations: [{ id: 'citation-b', articleId: articleB, sourceId: 'source-b' }],
      })),
    }
    const firstRoute = parsePublicPath('/qa', `?articleId=${articleA}`)
    const secondRoute = parsePublicPath('/qa', `?articleId=${articleB}`)
    const runner = createHookRunner(usePublicIntegration)
    const firstProps = integrationProps({ api, ...firstRoute })

    runner.render(firstProps)
    await flushMicrotasks()
    let result = runner.render(firstProps)
    const staleDetailRequest = result.qa.handlers.onSelectSession('session-a')

    const secondProps = integrationProps({ api, ...secondRoute })
    runner.render(secondProps)
    result = runner.render(secondProps)

    expect(result.qa.state).toBe('empty')
    expect(result.qa.sessions).toEqual([])
    expect(result.qa.messages).toEqual([])
    expect(result.qa.scope.articleId).toBe(articleB)
    expect(result.qa.scope.sessionId).toBeUndefined()

    staleList.resolve({ data: [{ id: 'session-a', title: 'Phiên bài A', messageCount: 1 }] })
    staleDetail.resolve({
      data: {
        id: 'session-a',
        messages: [{ id: 'old-question', role: 'user', text: 'Câu hỏi bài A' }],
        messageCount: 1,
      },
    })
    await staleDetailRequest
    await flushMicrotasks()
    result = runner.render(secondProps)

    expect(result.qa.state).toBe('empty')
    expect(result.qa.sessions).toEqual([])
    expect(result.qa.messages).toEqual([])
    expect(result.qa.scope.articleId).toBe(articleB)
    expect(result.qa.scope.sessionId).toBeUndefined()

    const answerRequest = result.qa.onAsk({ ...result.qa.scope, question: 'Câu hỏi mới cho bài B' })
    await answerRequest
    await flushMicrotasks()
    result = runner.render(secondProps)

    const answerInit = api.createGroundedAnswer.mock.calls.at(-1)[0]
    expect(JSON.parse(answerInit.body).scope.articleId).toBe(articleB)
    expect(answerInit.headers['X-CSRF-Token']).toBe('csrf-token')
    expect(answerInit.headers['Idempotency-Key']).toBeTypeOf('string')
    expect(result.qa.messages[0].text).toBe('Câu hỏi mới cho bài B')
  })

  it('keeps feed results and exposes a retryable save error', async () => {
    const saveError = new Error('save failed')
    const api = {
      listArticles: vi.fn().mockResolvedValue(response([article])),
      saveArticle: vi.fn().mockRejectedValueOnce(saveError).mockResolvedValueOnce({}),
    }
    const runner = createHookRunner(usePublicIntegration)
    const props = integrationProps({ api })

    let result = runner.render(props)
    await flushMicrotasks()
    result = runner.render(props)
    await result.feed.handlers.onSaveToggle(article, true)
    result = runner.render(props)

    expect(result.feed.state).toBe('ready')
    expect(result.feed.articles).toEqual([article])
    expect(result.feed.saveError).toBe(saveError)
    expect(result.feed.handlers.onSaveRetry).toBeTypeOf('function')

    await result.feed.handlers.onSaveRetry()
    result = runner.render(props)
    expect(result.feed.saveError).toBeNull()
    expect(api.saveArticle).toHaveBeenCalledTimes(2)
  })

  it('keeps search results and exposes a retryable save error', async () => {
    const saveError = new Error('search save failed')
    const api = {
      searchArticles: vi.fn().mockResolvedValue(response([article])),
      saveArticle: vi.fn().mockRejectedValue(saveError),
    }
    const runner = createHookRunner(usePublicIntegration)
    const props = integrationProps({ api, route: 'search', searchParams: { q: 'AI' } })

    let result = runner.render(props)
    await flushMicrotasks()
    result = runner.render(props)
    await result.search.handlers.onSaveToggle(article, true)
    result = runner.render(props)

    expect(result.search.state).toBe('ready')
    expect(result.search.results).toEqual([article])
    expect(result.search.saveError).toBe(saveError)
    expect(result.search.handlers.onSaveRetry).toBeTypeOf('function')
  })

  it('retries a failed article load for the current route article', async () => {
    const loadError = new Error('article unavailable')
    const api = { getArticle: vi.fn().mockRejectedValueOnce(loadError).mockResolvedValueOnce(response(article)) }
    const runner = createHookRunner(usePublicIntegration)
    const props = integrationProps({ api, route: 'article', articleId: article.id })

    let result = runner.render(props)
    await flushMicrotasks()
    result = runner.render(props)
    expect(result.article.state).toBe('error')

    result.article.onRetry()
    runner.render(props)
    await flushMicrotasks()
    result = runner.render(props)

    expect(result.article.state).toBe('ready')
    expect(result.article.article).toEqual(article)
    expect(api.getArticle).toHaveBeenCalledTimes(2)
  })
  it('rehydrates changed search URL parameters after the initial submit', async () => {
    const api = { searchArticles: vi.fn().mockResolvedValue(response([])) }
    const firstParams = { q: 'AI', mode: 'hybrid', topic: '', sourceId: '', publishedAfter: '', publishedBefore: '' }
    const firstProps = integrationProps({ api, route: 'search', searchParams: firstParams })
    const runner = createHookRunner(usePublicIntegration)

    runner.render(firstProps)
    await flushMicrotasks()
    runner.render(firstProps)
    expect(api.searchArticles).toHaveBeenCalledTimes(1)

    const secondParams = { ...firstParams, q: 'ML' }
    const secondProps = { ...firstProps, searchParams: secondParams }
    runner.render(secondProps)
    await flushMicrotasks()
    const result = runner.render(secondProps)

    expect(result.search.query.q).toBe('ML')
    expect(api.searchArticles).toHaveBeenCalledTimes(2)
  })

  it('blocks overlapping feed save mutations so one retry slot cannot be corrupted', async () => {
    const secondArticle = { ...article, id: '507f1f77bcf86cd799439012' }
    const firstSave = deferred()
    const api = {
      listArticles: vi.fn().mockResolvedValue(response([article, secondArticle])),
      saveArticle: vi.fn((articleId) => articleId === article.id ? firstSave.promise : Promise.resolve({})),
    }
    const runner = createHookRunner(usePublicIntegration)
    const props = integrationProps({ api })

    runner.render(props)
    await flushMicrotasks()
    let result = runner.render(props)
    const firstRequest = result.feed.handlers.onSaveToggle(article, true)
    result = runner.render(props)
    const secondRequest = result.feed.handlers.onSaveToggle(secondArticle, true)

    expect(api.saveArticle).toHaveBeenCalledTimes(1)
    firstSave.resolve({})
    await firstRequest
    await secondRequest
  })

  it('allows a failed feed save alert to be dismissed without changing results', async () => {
    const saveError = new Error('save failed')
    const api = {
      listArticles: vi.fn().mockResolvedValue(response([article])),
      saveArticle: vi.fn().mockRejectedValue(saveError),
    }
    const runner = createHookRunner(usePublicIntegration)
    const props = integrationProps({ api })

    runner.render(props)
    await flushMicrotasks()
    let result = runner.render(props)
    await result.feed.handlers.onSaveToggle(article, true)
    result = runner.render(props)
    expect(result.feed.saveError).toBe(saveError)

    result.feed.handlers.onDismissSaveError()
    result = runner.render(props)
    expect(result.feed.saveError).toBeNull()
    expect(result.feed.articles).toEqual([article])
  })

  it('keeps saved results and exposes retry for unsave failures', async () => {
    const unsaveError = new Error('unsave failed')
    const api = {
      listSavedArticles: vi.fn().mockResolvedValue(response([article])),
      unsaveArticle: vi.fn().mockRejectedValueOnce(unsaveError).mockResolvedValueOnce({}),
    }
    const runner = createHookRunner(usePublicIntegration)
    const props = integrationProps({ api, route: 'saved' })

    runner.render(props)
    await flushMicrotasks()
    let result = runner.render(props)
    await result.saved.handlers.onUnsave(article)
    result = runner.render(props)

    expect(result.saved.articles).toEqual([article])
    expect(result.saved.saveError).toBe(unsaveError)
    expect(result.saved.handlers.onSaveRetry).toBeTypeOf('function')

    await result.saved.handlers.onSaveRetry()
    result = runner.render(props)
    expect(result.saved.articles).toEqual([])
    expect(result.saved.saveError).toBeNull()
  })

  it('keeps saved dialog state and exposes retry for clear failures', async () => {
    const clearError = new Error('clear failed')
    const api = {
      listSavedArticles: vi.fn().mockResolvedValue(response([article])),
      clearSavedArticles: vi.fn().mockRejectedValueOnce(clearError).mockResolvedValueOnce({}),
    }
    const runner = createHookRunner(usePublicIntegration)
    const props = integrationProps({ api, route: 'saved' })

    runner.render(props)
    await flushMicrotasks()
    let result = runner.render(props)
    result.saved.handlers.onOpenClear()
    result = runner.render(props)
    await result.saved.handlers.onConfirmClear()
    result = runner.render(props)

    expect(result.saved.clearOpen).toBe(true)
    expect(result.saved.saveError).toBe(clearError)
    await result.saved.handlers.onSaveRetry()
    result = runner.render(props)
    expect(result.saved.clearOpen).toBe(false)
    expect(result.saved.saveError).toBeNull()
  })
})
