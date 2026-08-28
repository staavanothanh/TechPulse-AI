import { describe, expect, it, vi } from 'vitest'

const hookRuntime = vi.hoisted(() => {
  const slots = []
  let cursor = 0
  let pendingEffects = []

  function takeSlot(initializer, kind) {
    const index = cursor
    cursor += 1
    if (!slots[index]) slots[index] = { kind, value: initializer() }
    return slots[index]
  }

  function useState(initialValue) {
    const slot = takeSlot(
      () => ({ current: typeof initialValue === 'function' ? initialValue() : initialValue }),
      'state',
    )
    return [slot.value.current, (nextValue) => {
      slot.value.current = typeof nextValue === 'function' ? nextValue(slot.value.current) : nextValue
    }]
  }

  function useRef(initialValue) {
    const slot = takeSlot(() => ({ current: initialValue }), 'ref')
    return slot.value
  }

  function useMemo(factory) {
    cursor += 1
    return factory()
  }

  function useCallback(callback) {
    cursor += 1
    return callback
  }

  function useEffect(effect) {
    cursor += 1
    pendingEffects.push(effect)
  }

  async function runEffects() {
    const effects = pendingEffects
    pendingEffects = []
    effects.forEach((effect) => effect())
    for (let index = 0; index < 8; index += 1) await Promise.resolve()
  }

  return {
    react: { useCallback, useEffect, useMemo, useRef, useState },
    reset() {
      slots.length = 0
      cursor = 0
      pendingEffects = []
    },
    render(hook, args) {
      cursor = 0
      pendingEffects = []
      return hook(args)
    },
    runEffects,
  }
})

vi.mock('react', () => hookRuntime.react)

const { usePublicIntegration, useQa } = await import('../../client/app/integration/use-public-integration.js')

const article = {
  id: 'article-1',
  titleVi: 'Bài viết kiểm thử',
  titleOriginal: 'Test article',
  topics: ['AI'],
}

const answered = (chatSessionId) => ({
  status: 'answered',
  chatSessionId,
  refusalReason: null,
  paragraphs: [{ text: 'Câu trả lời có nguồn.', citationIds: ['citation-1'] }],
  citations: [{ id: 'citation-1', articleId: article.id, sourceId: 'source-1' }],
})

const refused = (chatSessionId) => ({
  status: 'refused',
  chatSessionId,
  refusalReason: 'insufficient-evidence',
  paragraphs: [],
  citations: [],
})

async function flushMicrotasks(count = 8) {
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

function response(data, meta = { hasNext: false }) {
  return { data, meta }
}

describe('public integration hooks', () => {
  it('drives feed, search, article, saved, and account state through real handlers', async () => {
    hookRuntime.reset()
    const api = {
      listArticles: vi.fn().mockResolvedValue(response([article], { hasNext: true, nextCursor: 'feed-next', totalItems: 20 })),
      searchArticles: vi.fn().mockResolvedValue(response([article], { hasNext: true, nextCursor: 'search-next', totalItems: 20 })),
      listSavedArticles: vi.fn().mockResolvedValue(response([article])),
      getArticle: vi.fn().mockResolvedValue(response(article)),
      saveArticle: vi.fn().mockResolvedValue({}),
      unsaveArticle: vi.fn().mockResolvedValue({}),
      clearSavedArticles: vi.fn().mockResolvedValue({}),
      listChatSessions: vi.fn().mockResolvedValue(response([])),
      getChatSession: vi.fn(),
      createGroundedAnswer: vi.fn(),
      clearChatSessions: vi.fn(),
    }
    const onNavigate = vi.fn()
    const onSessionExpired = vi.fn()
    const accountActions = {
      updatePreferences: vi.fn().mockResolvedValue({}),
      requestDeletion: vi.fn().mockResolvedValue({}),
      logout: vi.fn().mockResolvedValue({}),
    }
    const baseProps = {
      api,
      csrfToken: 'csrf-token',
      user: { id: 'user-1', topicPreferences: ['AI'] },
      route: 'feed',
      onNavigate,
      onSessionExpired,
      accountActions,
      sessionNotice: 'Session ready',
    }

    let result = hookRuntime.render(usePublicIntegration, baseProps)
    await hookRuntime.runEffects()
    result = hookRuntime.render(usePublicIntegration, baseProps)
    expect(result.feed.state).toBe('ready')
    expect(api.listArticles).toHaveBeenCalledWith(expect.objectContaining({ credentials: 'same-origin', fetchImpl: expect.any(Function) }))

    result.feed.handlers.onFilterChange('topic', 'x'.repeat(65))
    result = hookRuntime.render(usePublicIntegration, baseProps)
    result.feed.handlers.onSubmit({ preventDefault: vi.fn() })
    result = hookRuntime.render(usePublicIntegration, baseProps)
    expect(result.feed.errors.topic).toContain('64')

    result.feed.handlers.onFilterChange('topic', 'AI')
    result = hookRuntime.render(usePublicIntegration, baseProps)
    result.feed.handlers.onSubmit({ preventDefault: vi.fn() })
    await flushMicrotasks()
    result = hookRuntime.render(usePublicIntegration, baseProps)
    expect(result.feed.state).toBe('ready')
    expect(api.listArticles).toHaveBeenCalledTimes(2)

    await result.feed.handlers.onNextPage()
    result = hookRuntime.render(usePublicIntegration, baseProps)
    expect(result.feed.page).toBe(2)
    expect(api.listArticles).toHaveBeenCalledTimes(3)
    await result.feed.handlers.onPreviousPage()
    result = hookRuntime.render(usePublicIntegration, baseProps)
    expect(result.feed.page).toBe(1)
    await result.feed.handlers.onLastPage()
    result = hookRuntime.render(usePublicIntegration, baseProps)
    expect(result.feed.page).toBe(2)
    await result.feed.handlers.onFirstPage()
    result = hookRuntime.render(usePublicIntegration, baseProps)
    expect(result.feed.page).toBe(1)

    await result.feed.handlers.onSaveToggle(article, true)
    await result.feed.handlers.onSaveToggle(article, false)
    expect(api.saveArticle).toHaveBeenCalledWith(expect.objectContaining({ pathParams: { articleId: article.id }, headers: { 'X-CSRF-Token': 'csrf-token' }, credentials: 'same-origin', fetchImpl: expect.any(Function) }))
    expect(api.unsaveArticle).toHaveBeenCalledWith(expect.objectContaining({ pathParams: { articleId: article.id }, headers: { 'X-CSRF-Token': 'csrf-token' }, credentials: 'same-origin', fetchImpl: expect.any(Function) }))
    result.feed.handlers.onOpenSearch()
    result.feed.handlers.onOpenArticle(article.id)
    expect(onNavigate).toHaveBeenCalledWith('search')
    expect(onNavigate).toHaveBeenCalledWith('article', { articleId: article.id })

    result.search.handlers.onQueryChange('q', 'AI')
    result = hookRuntime.render(usePublicIntegration, baseProps)
    result.search.handlers.onSubmit({ preventDefault: vi.fn() })
    await flushMicrotasks()
    result = hookRuntime.render(usePublicIntegration, baseProps)
    expect(result.search.state).toBe('ready')
    expect(api.searchArticles).toHaveBeenCalledTimes(1)
    await result.search.handlers.onNextPage()
    result = hookRuntime.render(usePublicIntegration, baseProps)
    expect(api.searchArticles).toHaveBeenCalledTimes(2)
    await result.search.handlers.onPreviousPage()
    result = hookRuntime.render(usePublicIntegration, baseProps)
    await result.search.handlers.onRetry()

    const articleProps = { ...baseProps, route: 'article' }
    result = hookRuntime.render(usePublicIntegration, articleProps)
    await hookRuntime.runEffects()
    result = hookRuntime.render(usePublicIntegration, articleProps)
    expect(result.article.state).toBe('ready')
    expect(result.article.article).toEqual(article)
    expect(api.getArticle).toHaveBeenCalledTimes(1)
    result.article.onBack()
    expect(onNavigate).toHaveBeenCalledWith('feed', { back: true })

    // Re-visiting cached article resolves instantly without additional API call
    result = hookRuntime.render(usePublicIntegration, { ...baseProps, route: 'feed' })
    await hookRuntime.runEffects()
    result = hookRuntime.render(usePublicIntegration, articleProps)
    await hookRuntime.runEffects()
    expect(result.article.state).toBe('ready')
    expect(api.getArticle).toHaveBeenCalledTimes(1)
    const savedProps = { ...baseProps, route: 'saved' }
    result = hookRuntime.render(usePublicIntegration, savedProps)
    await hookRuntime.runEffects()
    result = hookRuntime.render(usePublicIntegration, savedProps)
    expect(result.saved.state).toBe('ready')
    await result.saved.handlers.onUnsave(article)
    result = hookRuntime.render(usePublicIntegration, savedProps)
    expect(result.saved.articles).toEqual([])

    await result.saved.handlers.onConfirmClear()
    result = hookRuntime.render(usePublicIntegration, savedProps)
    expect(result.saved.state).toBe('ready')
    expect(api.clearSavedArticles).toHaveBeenCalledWith(expect.objectContaining({ headers: { 'X-CSRF-Token': 'csrf-token' }, credentials: 'same-origin', fetchImpl: expect.any(Function) }))
    result.saved.handlers.onOpenClear()
    result.saved.handlers.onCancelClear()
    result.saved.handlers.onOpenFeed()
    expect(onNavigate).toHaveBeenCalledWith('feed')

    result.account.onToggleTopic('AI')
    result.account.onToggleTopic('Robotics')
    result = hookRuntime.render(usePublicIntegration, savedProps)
    await result.account.onSavePreferences()
    result = hookRuntime.render(usePublicIntegration, savedProps)
    expect(result.account.notice).toBe('Đã lưu chủ đề quan tâm.')
    await result.account.onRequestDeletion()
    await result.account.onLogout()
    expect(accountActions.updatePreferences).toHaveBeenCalledWith(['Robotics'])
    expect(accountActions.requestDeletion).toHaveBeenCalled()
    expect(accountActions.logout).toHaveBeenCalled()
    result = hookRuntime.render(usePublicIntegration, savedProps)
    expect(result.account.notice).toBeNull()
    hookRuntime.reset()
    const aliasProps = { ...baseProps, user: { id: 'user-legacy', topicPreferences: ['Robot'] } }
    result = hookRuntime.render(usePublicIntegration, aliasProps)
    result.account.onToggleTopic('Robotics')
    result = hookRuntime.render(usePublicIntegration, aliasProps)
    expect(result.account.user.topicPreferences).toEqual([])
  })

  it('handles integration request failures and no-credential guards', async () => {
    hookRuntime.reset()
    const expired = vi.fn()
    const api = {
      listArticles: vi.fn().mockRejectedValue(Object.assign(new Error('expired'), { status: 401 })),
      searchArticles: vi.fn().mockRejectedValue(Object.assign(new Error('search failed'), { status: 500 })),
      listSavedArticles: vi.fn().mockRejectedValue(new Error('saved failed')),
      getArticle: vi.fn().mockRejectedValue(new Error('article failed')),
      saveArticle: vi.fn(),
      unsaveArticle: vi.fn(),
      clearSavedArticles: vi.fn(),
      listChatSessions: vi.fn(),
      getChatSession: vi.fn(),
      createGroundedAnswer: vi.fn(),
      clearChatSessions: vi.fn(),
    }
    const accountActions = {
      updatePreferences: vi.fn().mockRejectedValue(Object.assign(new Error('expired'), { status: 401 })),
      requestDeletion: vi.fn(),
      logout: vi.fn(),
    }
    const props = {
      api,
      csrfToken: null,
      user: { id: 'user-1', topicPreferences: [] },
      route: 'feed',
      onSessionExpired: expired,
      accountActions,
    }
    let result = hookRuntime.render(usePublicIntegration, props)
    await hookRuntime.runEffects()
    result = hookRuntime.render(usePublicIntegration, props)
    expect(result.feed.state).toBe('error')
    expect(expired).toHaveBeenCalled()
    expect(await result.feed.handlers.onSaveToggle(article, true)).toBeUndefined()

    result.search.handlers.onQueryChange('q', 'AI')
    result = hookRuntime.render(usePublicIntegration, props)
    result.search.handlers.onSubmit({ preventDefault: vi.fn() })
    await flushMicrotasks()
    result = hookRuntime.render(usePublicIntegration, props)
    expect(result.search.state).toBe('error')

    const savedProps = { ...props, route: 'saved' }
    result = hookRuntime.render(usePublicIntegration, savedProps)
    await hookRuntime.runEffects()
    result = hookRuntime.render(usePublicIntegration, savedProps)
    expect(result.saved.state).toBe('error')
    expect(await result.saved.handlers.onUnsave(article)).toBeUndefined()
    expect(await result.saved.handlers.onConfirmClear()).toBeUndefined()

    result.feed.handlers.onOpenArticle(article.id)
    const articleProps = { ...props, route: 'article' }
    result = hookRuntime.render(usePublicIntegration, articleProps)
    await hookRuntime.runEffects()
    result = hookRuntime.render(usePublicIntegration, articleProps)
    expect(result.article.state).toBe('error')

    await result.account.onSavePreferences()
    result = hookRuntime.render(usePublicIntegration, articleProps)
    expect(result.account.error).toBeTruthy()
    expect(expired).toHaveBeenCalledTimes(2)
  })

  it('does not apply an account response after the session identity changes', async () => {
    hookRuntime.reset()
    const update = deferred()
    const expired = vi.fn()
    const accountActions = {
      updatePreferences: vi.fn(() => update.promise),
      requestDeletion: vi.fn(),
      logout: vi.fn(),
    }
    const base = {
      api: {},
      csrfToken: 'csrf-old',
      user: { id: 'user-old', topicPreferences: ['AI'] },
      route: 'account',
      onSessionExpired: expired,
      accountActions,
    }

    let result = hookRuntime.render(usePublicIntegration, base)
    const pending = result.account.onSavePreferences()
    const next = { ...base, csrfToken: 'csrf-new', user: { id: 'user-new', topicPreferences: ['Robotics'] } }
    result = hookRuntime.render(usePublicIntegration, next)
    expect(result.account.user.topicPreferences).toEqual(['Robotics'])
    await hookRuntime.runEffects()

    update.resolve({ data: { id: 'user-old', topicPreferences: ['AI'] } })
    await pending
    result = hookRuntime.render(usePublicIntegration, next)

    expect(result.account.user).toMatchObject({ id: 'user-new', topicPreferences: ['Robotics'] })
    expect(expired).not.toHaveBeenCalled()
  })

  it('triggers exactly one API call when submitting a feed filter', async () => {
    hookRuntime.reset()
    const api = {
      listArticles: vi.fn().mockResolvedValue(response([article])),
      listSavedArticles: vi.fn().mockResolvedValue(response([])),
    }
    const props = {
      api,
      csrfToken: 'csrf-token',
      user: { id: 'user-1', topicPreferences: [] },
      route: 'feed',
    }
    let result = hookRuntime.render(usePublicIntegration, props)
    await hookRuntime.runEffects()
    expect(api.listArticles).toHaveBeenCalledTimes(1)

    result.feed.handlers.onFilterChange('topic', 'AI')
    result = hookRuntime.render(usePublicIntegration, props)
    result.feed.handlers.onSubmit({ preventDefault: vi.fn() })
    await flushMicrotasks()
    await hookRuntime.runEffects()

    expect(api.listArticles).toHaveBeenCalledTimes(2)
  })

  it('preserves feed and does not refetch on back-navigation even when feed is empty', async () => {
    hookRuntime.reset()
    const api = {
      listArticles: vi.fn().mockResolvedValue(response([])),
      listSavedArticles: vi.fn().mockResolvedValue(response([])),
      getArticle: vi.fn().mockResolvedValue(response(article)),
    }
    const props = {
      api,
      csrfToken: 'csrf-token',
      user: { id: 'user-1', topicPreferences: [] },
      route: 'feed',
    }
    let result = hookRuntime.render(usePublicIntegration, props)
    await hookRuntime.runEffects()
    expect(api.listArticles).toHaveBeenCalledTimes(1)
    expect(result.feed.articles).toEqual([])

    const articleProps = { ...props, route: 'article' }
    result = hookRuntime.render(usePublicIntegration, articleProps)
    await hookRuntime.runEffects()

    const returnFeedProps = { ...props, route: 'feed' }
    result = hookRuntime.render(usePublicIntegration, returnFeedProps)
    await hookRuntime.runEffects()

    expect(api.listArticles).toHaveBeenCalledTimes(1)
  })

  it('hydrates search from searchParams and updates URL on search submit', async () => {
    hookRuntime.reset()
    const api = {
      searchArticles: vi.fn().mockResolvedValue(response([article])),
      listArticles: vi.fn().mockResolvedValue(response([])),
      listSavedArticles: vi.fn().mockResolvedValue(response([])),
    }
    const onNavigate = vi.fn()
    const props = {
      api,
      csrfToken: 'csrf-token',
      user: { id: 'user-1', topicPreferences: [] },
      route: 'search',
      searchParams: { q: 'AI', topic: 'NLP', mode: 'hybrid' },
      onNavigate,
    }

    let result = hookRuntime.render(usePublicIntegration, props)
    await hookRuntime.runEffects()
    result = hookRuntime.render(usePublicIntegration, props)

    expect(result.search.query.q).toBe('AI')
    expect(result.search.query.topic).toBe('NLP')
    expect(api.searchArticles).toHaveBeenCalledWith(
      expect.objectContaining({ credentials: 'same-origin', fetchImpl: expect.any(Function) }),
    )
    expect(result.search.state).toBe('ready')

    result.search.handlers.onQueryChange('q', 'Robotics')
    result = hookRuntime.render(usePublicIntegration, props)
    result.search.handlers.onSubmit({ preventDefault: vi.fn() })
    await flushMicrotasks()

    expect(onNavigate).toHaveBeenCalledWith('search', {
      searchParams: expect.objectContaining({ q: 'Robotics' }),
    })
  })
})

describe('Q&A session integration queue', () => {
  it('serializes answers and forwards answer or refusal session IDs', async () => {
    hookRuntime.reset()
    const first = deferred()
    const second = deferred()
    const third = deferred()
    const fourth = deferred()
    const qaApi = {
      listSessions: vi.fn().mockResolvedValue(response([])),
      getSession: vi.fn(),
      createAnswer: vi.fn()
        .mockImplementationOnce(() => first.promise)
        .mockImplementationOnce(() => second.promise)
        .mockImplementationOnce(() => third.promise)
        .mockImplementationOnce(() => fourth.promise),
      clearSessions: vi.fn().mockResolvedValue({}),
    }
    const expire = vi.fn()
    const args = {
      csrfToken: 'csrf-token',
      enabled: false,
      expire,
      qaApi,
      user: { topicPreferences: ['AI'] },
    }
    let result = hookRuntime.render(useQa, args)
    const firstAsk = result.onAsk({ question: 'Câu hỏi đầu tiên', topics: ['AI'] })
    const secondAsk = result.onAsk({ question: 'Câu hỏi thứ hai', topics: ['AI'] })
    expect(qaApi.createAnswer).toHaveBeenCalledTimes(1)

    first.resolve(answered('session-1'))
    await firstAsk
    await flushMicrotasks()
    expect(qaApi.createAnswer).toHaveBeenCalledTimes(2)
    expect(qaApi.createAnswer.mock.calls[1][1]).toEqual(expect.objectContaining({ chatSessionId: 'session-1' }))

    second.resolve(answered('session-2'))
    await secondAsk

    const thirdAsk = result.onAsk({ question: 'Câu hỏi từ chối', topics: ['AI'] })
    third.resolve(refused('session-refused'))
    await thirdAsk
    const fourthAsk = result.onAsk({ question: 'Câu hỏi sau từ chối', topics: ['AI'] })
    fourth.resolve(answered('session-4'))
    await fourthAsk
    expect(qaApi.createAnswer.mock.calls[3][1]).toEqual(expect.objectContaining({ chatSessionId: 'session-refused' }))

    result = hookRuntime.render(useQa, args)
    expect(result.state).toBe('ready')
    expect(result.messages).toHaveLength(8)
  })

  it('drops stale session results and prevents a late answer from recreating cleared history', async () => {
    hookRuntime.reset()
    const selectA = deferred()
    const selectB = deferred()
    const pendingAnswer = deferred()
    const qaApi = {
      listSessions: vi.fn().mockResolvedValue(response([])),
      getSession: vi.fn((id) => id === 'session-a' ? selectA.promise : selectB.promise),
      createAnswer: vi.fn().mockImplementationOnce(() => pendingAnswer.promise),
      clearSessions: vi.fn().mockResolvedValue({}),
    }
    const expire = vi.fn()
    const args = {
      csrfToken: 'csrf-token',
      enabled: false,
      expire,
      qaApi,
      user: { topicPreferences: ['AI'] },
    }
    let result = hookRuntime.render(useQa, args)

    const loadA = result.handlers.onSelectSession('session-a')
    const loadB = result.handlers.onSelectSession('session-b')
    selectB.resolve({ data: { messageCount: 1, messages: [{ id: 'user-b', role: 'user', text: 'B' }] } })
    await loadB
    selectA.resolve({ data: { messageCount: 1, messages: [{ id: 'user-a', role: 'user', text: 'A' }] } })
    await loadA
    result = hookRuntime.render(useQa, args)
    expect(result.scope.sessionId).toBe('session-b')
    expect(result.messages[0].text).toBe('B')

    const pending = result.onAsk({ question: 'Câu hỏi đang chạy', topics: ['AI'] })
    const clear = result.handlers.onClearSessions()
    expect(qaApi.clearSessions).not.toHaveBeenCalled()
    pendingAnswer.resolve(answered('stale-session'))
    await pending
    await clear
    expect(qaApi.clearSessions).toHaveBeenCalledWith('csrf-token')
    expect(qaApi.clearSessions.mock.invocationCallOrder[0]).toBeGreaterThan(
      qaApi.createAnswer.mock.invocationCallOrder[0],
    )

    qaApi.createAnswer.mockResolvedValueOnce(answered('fresh-session'))
    result = hookRuntime.render(useQa, args)
    const fresh = result.onAsk({ question: 'Câu hỏi mới', topics: ['AI'] })
    await fresh
    expect(qaApi.createAnswer.mock.calls.at(-1)[1].chatSessionId).toBeUndefined()
    result = hookRuntime.render(useQa, args)
    expect(result.state).toBe('ready')

    result.handlers.onNewSession()
    result.handlers.onToggleTopic('AI')
    result.handlers.onToggleTopic('Robotics')
    result.handlers.onScopeChange('sessionId', 'manual-session')
    result = hookRuntime.render(useQa, args)
    expect(result.scope.topics).toEqual(['Robotics'])
    expect(result.scope.sessionId).toBe('manual-session')
  })

  it('clears visible Q&A state and invalidates in-flight work when identity changes', async () => {
    hookRuntime.reset()
    const pending = deferred()
    const qaApi = {
      listSessions: vi.fn().mockResolvedValue(response([])),
      getSession: vi.fn(),
      createAnswer: vi.fn()
        .mockImplementationOnce(() => pending.promise)
        .mockResolvedValueOnce(answered('new-session')),
      clearSessions: vi.fn().mockResolvedValue({}),
    }
    const expire = vi.fn()
    const oldArgs = { csrfToken: 'csrf-old', enabled: false, expire, qaApi, user: { id: 'user-old', topicPreferences: ['AI'] } }
    const newArgs = { ...oldArgs, csrfToken: 'csrf-new', user: { id: 'user-new', topicPreferences: ['Robotics'] } }
    let result = hookRuntime.render(useQa, oldArgs)
    const oldAsk = result.onAsk({ question: 'Câu hỏi cũ', topics: ['AI'] })
    result = hookRuntime.render(useQa, newArgs)
    expect(result.state).toBe('empty')
    expect(result.sessions).toEqual([])
    expect(result.messages).toEqual([])
    expect(result.scope.topics).toEqual(['Robotics'])

    pending.resolve(answered('old-session'))
    await oldAsk
    result = hookRuntime.render(useQa, newArgs)
    expect(result.messages).toEqual([])
    const newAsk = result.onAsk({ question: 'Câu hỏi mới', topics: ['Robotics'] })
    await newAsk
    expect(qaApi.createAnswer.mock.calls.at(-1)[1].chatSessionId).toBeUndefined()
  })

  it('reports validation, list, and detail errors through the public state', async () => {
    hookRuntime.reset()
    const qaApi = {
      listSessions: vi.fn().mockRejectedValue(Object.assign(new Error('list failed'), { status: 401 })),
      getSession: vi.fn().mockResolvedValue({ messageCount: 1, messages: [{ id: 'bad', role: 'assistant' }] }),
      createAnswer: vi.fn(),
      clearSessions: vi.fn(),
    }
    const expire = vi.fn()
    const args = { csrfToken: 'csrf-token', enabled: false, expire, qaApi, user: null }
    let result = hookRuntime.render(useQa, args)
    result.onAsk({ question: 'x', topics: [] })
    result = hookRuntime.render(useQa, args)
    expect(result.state).toBe('error')
    await result.handlers.onRetry()
    result = hookRuntime.render(useQa, args)
    expect(result.state).toBe('error')
    expect(expire).toHaveBeenCalledWith(expect.objectContaining({ status: 401 }))

    await result.handlers.onSelectSession('bad-session')
    result = hookRuntime.render(useQa, args)
    expect(result.state).toBe('error')
    expect(result.error).toBeTruthy()
  })
})
