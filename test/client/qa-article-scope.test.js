import React from 'react'
import { describe, expect, it, vi } from 'vitest'
import { useQa, usePublicIntegration } from '../../client/app/integration/use-public-integration.js'

function deferred() {
  let resolve
  let reject
  const promise = new Promise((nextResolve, nextReject) => {
    resolve = nextResolve
    reject = nextReject
  })
  return { promise, resolve, reject }
}

function createHookRunner(hookFn) {
  let hookIdx = 0
  const hooks = []
  const effectCleanups = []
  let pendingEffects = []

  const dispatcher = {
    useState(initial) {
      const idx = hookIdx++
      if (hooks[idx] === undefined) {
        hooks[idx] = typeof initial === 'function' ? initial() : initial
      }
      const setState = (next) => {
        const val = typeof next === 'function' ? next(hooks[idx]) : next
        hooks[idx] = val
        render()
      }
      return [hooks[idx], setState]
    },
    useRef(initial) {
      const idx = hookIdx++
      if (hooks[idx] === undefined) {
        hooks[idx] = { current: initial }
      }
      return hooks[idx]
    },
    useCallback(fn, deps) {
      const idx = hookIdx++
      const prev = hooks[idx]
      if (prev && deps && prev.deps.every((d, i) => Object.is(d, deps[i]))) {
        return prev.fn
      }
      hooks[idx] = { fn, deps }
      return fn
    },
    useMemo(fn, deps) {
      const idx = hookIdx++
      const prev = hooks[idx]
      if (prev && deps && prev.deps.every((d, i) => Object.is(d, deps[i]))) {
        return prev.val
      }
      const val = fn()
      hooks[idx] = { val, deps }
      return val
    },
    useEffect(effect, deps) {
      const idx = hookIdx++
      const prev = hooks[idx]
      let hasChanged = true
      if (prev && deps && prev.deps && prev.deps.every((d, i) => Object.is(d, deps[i]))) {
        hasChanged = false
      }
      hooks[idx] = { effect, deps }
      if (hasChanged) {
        pendingEffects.push({ idx, effect })
      }
    },
  }

  let currentProps
  let latestResult

  function render(props = currentProps) {
    currentProps = props
    hookIdx = 0
    pendingEffects = []
    const prevH = React.__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE.H
    React.__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE.H = dispatcher
    try {
      latestResult = hookFn(props)
    } finally {
      React.__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE.H = prevH
    }
    for (const { idx, effect } of pendingEffects) {
      if (typeof effectCleanups[idx] === 'function') {
        effectCleanups[idx]()
      }
      const cleanup = effect()
      effectCleanups[idx] = typeof cleanup === 'function' ? cleanup : undefined
    }
    return latestResult
  }

  function unmount() {
    for (const cleanup of effectCleanups) {
      if (typeof cleanup === 'function') cleanup()
    }
  }

  return {
    render,
    get current() {
      return latestResult
    },
    unmount,
  }
}

describe('Q&A article scope from article detail', () => {
  it('onScopeArticleId sets articleId into Q&A scope', async () => {
    const qaApi = { listSessions: vi.fn(async () => ({ data: [] })) }
    const expire = vi.fn()
    const runner = createHookRunner(useQa)
    runner.render({ csrfToken: 'csrf-1', enabled: true, expire, qaApi, user: { topicPreferences: ['AI'] } })

    expect(runner.current.scope.articleId).toBeUndefined()
    runner.current.handlers.onScopeArticleId('abc123def456abc123def456')
    expect(runner.current.scope.articleId).toBe('abc123def456abc123def456')
    // topics được giữ nguyên
    expect(runner.current.scope.topics).toEqual(['AI'])
  })

  it('onScopeArticleId replaces a previously selected article id', async () => {
    const qaApi = { listSessions: vi.fn(async () => ({ data: [] })) }
    const expire = vi.fn()
    const runner = createHookRunner(useQa)
    runner.render({ csrfToken: 'csrf-1', enabled: true, expire, qaApi, user: { topicPreferences: [] } })

    runner.current.handlers.onScopeArticleId('aaa111aaa111aaa111aaa111')
    runner.current.handlers.onScopeArticleId('bbb222bbb222bbb222bbb222')
    expect(runner.current.scope.articleId).toBe('bbb222bbb222bbb222bbb222')
  })

  it('onAskAboutArticle navigates to qa and presets the article id in Q&A scope', async () => {
    const qaApi = { listSessions: vi.fn(async () => ({ data: [] })) }
    const expire = vi.fn()
    const onNavigate = vi.fn()
    const runner = createHookRunner(usePublicIntegration)
    runner.render({
      api: {},
      csrfToken: 'csrf-1',
      user: { id: 'u1', topicPreferences: ['AI'] },
      route: 'article',
      articleId: 'abc123def456abc123def456',
      searchParams: null,
      onNavigate,
      onSessionExpired: vi.fn(),
      accountActions: {},
      sessionNotice: null,
    })

    runner.current.article.onAskAboutArticle?.({ id: 'abc123def456abc123def456', titleOriginal: 'Bài test' })
    expect(onNavigate).toHaveBeenCalledWith('qa', expect.anything())
    expect(runner.current.qa.scope.articleId).toBe('abc123def456abc123def456')
  })

  it('onAskAboutArticle ignores missing article id', async () => {
    const qaApi = { listSessions: vi.fn(async () => ({ data: [] })) }
    const expire = vi.fn()
    const onNavigate = vi.fn()
    const runner = createHookRunner(usePublicIntegration)
    runner.render({
      api: {},
      csrfToken: 'csrf-1',
      user: { id: 'u1', topicPreferences: [] },
      route: 'article',
      articleId: null,
      searchParams: null,
      onNavigate,
      onSessionExpired: vi.fn(),
      accountActions: {},
      sessionNotice: null,
    })

    runner.current.article.onAskAboutArticle?.({ titleOriginal: 'Không có id' })
    expect(onNavigate).not.toHaveBeenCalled()
    expect(runner.current.qa.scope.articleId).toBeUndefined()
  })

  it('onClearArticleScope removes articleId from Q&A scope', async () => {
    const qaApi = { listSessions: vi.fn(async () => ({ data: [] })) }
    const expire = vi.fn()
    const runner = createHookRunner(useQa)
    runner.render({ csrfToken: 'csrf-1', enabled: true, expire, qaApi, user: { topicPreferences: ['AI'] } })

    runner.current.handlers.onScopeArticleId('abc123def456abc123def456')
    expect(runner.current.scope.articleId).toBe('abc123def456abc123def456')
    runner.current.handlers.onClearArticleScope()
    expect(runner.current.scope.articleId).toBeUndefined()
    expect(runner.current.scope.topics).toEqual(['AI'])
  })
})
