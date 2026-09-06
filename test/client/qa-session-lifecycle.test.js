import React from 'react'
import { describe, expect, it, vi } from 'vitest'
import { useQa } from '../../client/app/integration/use-public-integration.js'

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

describe('useQa session lifecycle and race safety', () => {

  it('persists the derived temporal scope and reuses it for a follow-up request', async () => {
    const createAnswerCalls = []
    const fixedNow = new Date('2026-09-04T15:30:00.000Z')
    const qaApi = {
      listSessions: vi.fn(async () => ({ data: [] })),
      createAnswer: vi.fn(async (body, headers) => {
        createAnswerCalls.push({ body, headers })
        return {
          data: {
            id: `answer-${createAnswerCalls.length}`,
            status: 'answered',
            paragraphs: [{ text: 'Có căn cứ.', citationIds: ['C1'] }],
            citations: [{ id: 'C1', articleId: '507f1f77bcf86cd799439011', sourceId: '507f1f77bcf86cd799439012' }],
            refusalReason: null,
            chatSessionId: 'session-temporal-1',
            createdAt: '2026-09-04T15:31:00.000Z',
          },
        }
      }),
    }
    const runner = createHookRunner(useQa)
    runner.render({ csrfToken: 'csrf-1', enabled: true, expire: vi.fn(), qaApi, now: fixedNow, user: { topicPreferences: ['AI'] } })

    await runner.current.onAsk({ question: 'tháng 9 này có tin tức gì mới không', topics: ['AI'] })

    const effectiveScope = {
      topics: ['AI'],
      publishedAfter: '2026-09-01T00:00:00.000Z',
      publishedBefore: '2026-09-30T23:59:59.999Z',
    }
    expect(createAnswerCalls[0].body.scope).toEqual(effectiveScope)
    expect(runner.current.scope).toMatchObject({ ...effectiveScope, sessionId: 'session-temporal-1' })

    await runner.current.onAsk({ ...runner.current.scope, question: 'Cập nhật thêm thông tin trong tháng này' })

    expect(createAnswerCalls[1].body.scope).toEqual(effectiveScope)
    expect(createAnswerCalls[1].headers.chatSessionId).toBe('session-temporal-1')
  })
  it('serializes overlapping asks and passes the first canonical chatSessionId to the second ask', async () => {
    const ask1Deferred = deferred()
    const ask2Deferred = deferred()
    const createAnswerCalls = []

    const qaApi = {
      listSessions: vi.fn(async () => ({ data: [] })),
      createAnswer: vi.fn(async (body, headers) => {
        createAnswerCalls.push({ body, headers })
        if (createAnswerCalls.length === 1) return ask1Deferred.promise
        return ask2Deferred.promise
      }),
    }
    const expire = vi.fn()
    const runner = createHookRunner(useQa)
    runner.render({ csrfToken: 'csrf-1', enabled: true, expire, qaApi, user: { topicPreferences: ['AI'] } })

    const p1 = runner.current.onAsk({ question: 'Câu hỏi 1', topics: ['AI'] })
    const p2 = runner.current.onAsk({ question: 'Câu hỏi 2', topics: ['AI'] })

    // Without queue serialization, both are called immediately or out-of-order without chatSessionId
    expect(createAnswerCalls).toHaveLength(1)
    expect(createAnswerCalls[0].headers.chatSessionId).toBeUndefined()
    expect(createAnswerCalls[0].body.question).toBe('Câu hỏi 1')

    ask1Deferred.resolve({
      data: {
        id: 'ans-1',
        status: 'answered',
        paragraphs: [{ text: 'Đoạn 1', citationIds: ['C1'] }],
        citations: [{ id: 'C1', articleId: '507f1f77bcf86cd799439011', sourceId: '507f1f77bcf86cd799439012' }],
        refusalReason: null,
        chatSessionId: 'session-canonical-42',
        createdAt: '2026-08-20T00:00:00.000Z',
      },
    })
    await p1
    await new Promise((r) => setTimeout(r, 0))

    expect(createAnswerCalls).toHaveLength(2)
    expect(createAnswerCalls[1].headers.chatSessionId).toBe('session-canonical-42')
    expect(createAnswerCalls[1].body.question).toBe('Câu hỏi 2')

    ask2Deferred.resolve({
      data: {
        id: 'ans-2',
        status: 'answered',
        paragraphs: [{ text: 'Đoạn 2', citationIds: ['C1'] }],
        citations: [{ id: 'C1', articleId: '507f1f77bcf86cd799439011', sourceId: '507f1f77bcf86cd799439012' }],
        refusalReason: null,
        chatSessionId: 'session-canonical-42',
        createdAt: '2026-08-20T00:01:00.000Z',
      },
    })
    await p2

    expect(runner.current.state).toBe('ready')
    expect(runner.current.scope.sessionId).toBe('session-canonical-42')
    expect(runner.current.messages).toHaveLength(4)
    expect(runner.current.messages[0].text).toBe('Câu hỏi 1')
    expect(runner.current.messages[1].id).toBe('ans-1')
    expect(runner.current.messages[2].text).toBe('Câu hỏi 2')
    expect(runner.current.messages[3].id).toBe('ans-2')
  })

  it('hands canonical chatSessionId to the next queued ask after a sensitive refusal', async () => {
    const ask1Deferred = deferred()
    const ask2Deferred = deferred()
    const createAnswerCalls = []

    const qaApi = {
      listSessions: vi.fn(async () => ({ data: [] })),
      createAnswer: vi.fn(async (body, headers) => {
        createAnswerCalls.push({ body, headers })
        if (createAnswerCalls.length === 1) return ask1Deferred.promise
        return ask2Deferred.promise
      }),
    }
    const expire = vi.fn()
    const runner = createHookRunner(useQa)
    runner.render({ csrfToken: 'csrf-1', enabled: true, expire, qaApi, user: { topicPreferences: ['AI'] } })

    const p1 = runner.current.onAsk({ question: 'Câu hỏi nhạy cảm', topics: ['AI'] })
    const p2 = runner.current.onAsk({ question: 'Câu hỏi tiếp theo', topics: ['AI'] })

    expect(createAnswerCalls).toHaveLength(1)
    expect(createAnswerCalls[0].headers.chatSessionId).toBeUndefined()

    ask1Deferred.resolve({
      data: {
        id: 'refusal-1',
        status: 'refused',
        paragraphs: [],
        citations: [],
        refusalReason: 'sensitive-input',
        chatSessionId: 'session-refusal-88',
        createdAt: '2026-08-20T00:00:00.000Z',
      },
    })
    await p1
    await new Promise((r) => setTimeout(r, 0))

    expect(createAnswerCalls).toHaveLength(2)
    expect(createAnswerCalls[1].headers.chatSessionId).toBe('session-refusal-88')

    ask2Deferred.resolve({
      data: {
        id: 'ans-2',
        status: 'answered',
        paragraphs: [{ text: 'Đoạn trả lời bình thường', citationIds: ['C1'] }],
        citations: [{ id: 'C1', articleId: '507f1f77bcf86cd799439011', sourceId: '507f1f77bcf86cd799439012' }],
        refusalReason: null,
        chatSessionId: 'session-refusal-88',
        createdAt: '2026-08-20T00:01:00.000Z',
      },
    })
    await p2

    expect(runner.current.state).toBe('ready')
    expect(runner.current.scope.sessionId).toBe('session-refusal-88')
    expect(runner.current.messages).toHaveLength(4)
    expect(runner.current.messages[1].status).toBe('refused')
    expect(runner.current.messages[1].refusalReason).toBe('sensitive-input')
    expect(runner.current.messages[3].status).toBe('answered')
  })

  it('prevents stale completion of an in-flight ask from repopulating UI after onNewSession', async () => {
    const askDeferred = deferred()
    const qaApi = {
      listSessions: vi.fn(async () => ({ data: [] })),
      createAnswer: vi.fn(async () => askDeferred.promise),
    }
    const expire = vi.fn()
    const runner = createHookRunner(useQa)
    runner.render({ csrfToken: 'csrf-1', enabled: true, expire, qaApi, user: { topicPreferences: ['AI'] } })

    const p = runner.current.onAsk({ question: 'Câu hỏi phiên cũ', topics: ['AI'] })
    expect(runner.current.state).toBe('loading')

    runner.current.handlers.onNewSession()
    expect(runner.current.state).toBe('empty')
    expect(runner.current.messages).toEqual([])
    expect(runner.current.scope.sessionId).toBeUndefined()

    askDeferred.resolve({
      data: {
        id: 'ans-old',
        status: 'answered',
        paragraphs: [{ text: 'Trả lời muộn', citationIds: ['C1'] }],
        citations: [{ id: 'C1', articleId: '507f1f77bcf86cd799439011', sourceId: '507f1f77bcf86cd799439012' }],
        refusalReason: null,
        chatSessionId: 'session-old-99',
        createdAt: '2026-08-20T00:00:00.000Z',
      },
    })
    await p

    expect(runner.current.state).toBe('empty')
    expect(runner.current.messages).toEqual([])
    expect(runner.current.scope.sessionId).toBeUndefined()

    const newAskDeferred = deferred()
    qaApi.createAnswer.mockImplementation(async () => newAskDeferred.promise)
    runner.current.onAsk({ question: 'Câu hỏi mới hoàn toàn', topics: ['AI'] })

    expect(qaApi.createAnswer).toHaveBeenLastCalledWith(
      expect.any(Object),
      expect.objectContaining({ chatSessionId: undefined }),
    )
  })

  it('ignores a slow getSession response if a newer session is selected in the meantime', async () => {
    const session1Deferred = deferred()
    const session2Deferred = deferred()

    const qaApi = {
      listSessions: vi.fn(async () => ({ data: [] })),
      getSession: vi.fn(async (id) => {
        if (id === 's1') return session1Deferred.promise
        return session2Deferred.promise
      }),
    }
    const expire = vi.fn()
    const runner = createHookRunner(useQa)
    runner.render({ csrfToken: 'csrf-1', enabled: true, expire, qaApi, user: { topicPreferences: ['AI'] } })

    const p1 = runner.current.handlers.onSelectSession('s1')
    expect(runner.current.state).toBe('loading')

    const p2 = runner.current.handlers.onSelectSession('s2')

    session2Deferred.resolve({
      data: {
        id: 's2',
        messages: [{ id: 'q2', role: 'user', text: 'Q2' }],
        messageCount: 1,
      },
    })
    await p2

    expect(runner.current.state).toBe('ready')
    expect(runner.current.scope.sessionId).toBe('s2')
    expect(runner.current.messages).toEqual([{ id: 'q2', role: 'user', text: 'Q2' }])

    session1Deferred.resolve({
      data: {
        id: 's1',
        messages: [{ id: 'q1', role: 'user', text: 'Q1' }],
        messageCount: 1,
      },
    })
    await p1

    expect(runner.current.state).toBe('ready')
    expect(runner.current.scope.sessionId).toBe('s2')
    expect(runner.current.messages).toEqual([{ id: 'q2', role: 'user', text: 'Q2' }])
  })

  it('waits for the ask queue to drain before calling clearSessions and prevents post-clear appends', async () => {
    const askDeferred = deferred()
    const clearDeferred = deferred()
    let askFinished = false
    let clearCalled = false

    const qaApi = {
      listSessions: vi.fn(async () => ({ data: [] })),
      createAnswer: vi.fn(async () => {
        const res = await askDeferred.promise
        askFinished = true
        return res
      }),
      clearSessions: vi.fn(async () => {
        clearCalled = true
        expect(askFinished).toBe(true)
        return clearDeferred.promise
      }),
    }
    const expire = vi.fn()
    const runner = createHookRunner(useQa)
    runner.render({ csrfToken: 'csrf-1', enabled: true, expire, qaApi, user: { topicPreferences: ['AI'] } })

    const pAsk = runner.current.onAsk({ question: 'Câu hỏi chuẩn bị xóa', topics: ['AI'] })
    const pClear = runner.current.handlers.onClearSessions()

    expect(clearCalled).toBe(false)

    askDeferred.resolve({
      data: {
        id: 'ans-pending',
        status: 'answered',
        paragraphs: [{ text: 'Trả lời', citationIds: ['C1'] }],
        citations: [{ id: 'C1', articleId: '507f1f77bcf86cd799439011', sourceId: '507f1f77bcf86cd799439012' }],
        refusalReason: null,
        chatSessionId: 'session-to-be-cleared',
        createdAt: '2026-08-20T00:00:00.000Z',
      },
    })
    await pAsk
    await new Promise((r) => setTimeout(r, 0))

    expect(qaApi.clearSessions).toHaveBeenCalledWith('csrf-1')

    clearDeferred.resolve({})
    await pClear

    expect(runner.current.state).toBe('empty')
    expect(runner.current.sessions).toEqual([])
    expect(runner.current.messages).toEqual([])
    expect(runner.current.scope.sessionId).toBeUndefined()
  })

  it('ignores a stale listSessions resolution after clearSessions has emptied the list', async () => {
    const listDeferred = deferred()
    const qaApi = {
      listSessions: vi.fn(async () => listDeferred.promise),
      clearSessions: vi.fn(async () => ({})),
    }
    const expire = vi.fn()
    const runner = createHookRunner(useQa)
    runner.render({ csrfToken: 'csrf-1', enabled: true, expire, qaApi, user: { topicPreferences: ['AI'] } })
    await new Promise((r) => setTimeout(r, 0))
    expect(qaApi.listSessions).toHaveBeenCalled()
    await runner.current.handlers.onClearSessions()
    expect(runner.current.sessions).toEqual([])

    listDeferred.resolve({
      data: [{ id: 'stale-s1', title: 'Phiên cũ', messageCount: 2, updatedAt: '2026-08-20T00:00:00.000Z' }],
    })
    await new Promise((r) => setTimeout(r, 10))

    expect(runner.current.sessions).toEqual([])
  })

  it('recovers queue after an ask fails and executes subsequent queued asks', async () => {
    const ask1Deferred = deferred()
    const ask2Deferred = deferred()
    const createAnswerCalls = []

    const qaApi = {
      listSessions: vi.fn(async () => ({ data: [] })),
      createAnswer: vi.fn(async (body, headers) => {
        createAnswerCalls.push({ body, headers })
        if (createAnswerCalls.length === 1) return ask1Deferred.promise
        return ask2Deferred.promise
      }),
    }
    const expire = vi.fn()
    const runner = createHookRunner(useQa)
    runner.render({ csrfToken: 'csrf-1', enabled: true, expire, qaApi, user: { topicPreferences: ['AI'] } })

    const p1 = runner.current.onAsk({ question: 'Câu hỏi 1 lỗi', topics: ['AI'] })
    const p2 = runner.current.onAsk({ question: 'Câu hỏi 2 thành công', topics: ['AI'] })

    expect(createAnswerCalls).toHaveLength(1)

    ask1Deferred.reject(new Error('Mạng bị gián đoạn'))
    await p1
    await new Promise((r) => setTimeout(r, 0))

    expect(runner.current.state).toBe('loading')
    expect(createAnswerCalls).toHaveLength(2)

    ask2Deferred.resolve({
      data: {
        id: 'ans-2',
        status: 'answered',
        paragraphs: [{ text: 'Trả lời thành công', citationIds: ['C1'] }],
        citations: [{ id: 'C1', articleId: '507f1f77bcf86cd799439011', sourceId: '507f1f77bcf86cd799439012' }],
        refusalReason: null,
        chatSessionId: 'session-new-1',
        createdAt: '2026-08-20T00:01:00.000Z',
      },
    })
    await p2

    expect(runner.current.state).toBe('ready')
    expect(runner.current.scope.sessionId).toBe('session-new-1')
    expect(runner.current.messages).toHaveLength(2)
    expect(runner.current.messages[0].text).toBe('Câu hỏi 2 thành công')
  })

  it('sets error state when a single ask fails', async () => {
    const askDeferred = deferred()
    const qaApi = {
      listSessions: vi.fn(async () => ({ data: [] })),
      createAnswer: vi.fn(async () => askDeferred.promise),
    }
    const expire = vi.fn()
    const runner = createHookRunner(useQa)
    runner.render({ csrfToken: 'csrf-1', enabled: true, expire, qaApi, user: { topicPreferences: ['AI'] } })

    const p = runner.current.onAsk({ question: 'Câu hỏi lỗi', topics: ['AI'] })
    expect(runner.current.state).toBe('loading')

    const failure = new Error('Lỗi máy chủ')
    askDeferred.reject(failure)
    await p

    expect(runner.current.state).toBe('error')
    expect(runner.current.error).toBe(failure)
  })

  it('deletes an inactive chat session and removes it from the sessions list', async () => {
    const listDeferred = deferred()
    const deleteDeferred = deferred()
    const qaApi = {
      listSessions: vi.fn(async () => listDeferred.promise),
      deleteSession: vi.fn(async () => deleteDeferred.promise),
    }
    const expire = vi.fn()
    const runner = createHookRunner(useQa)
    runner.render({ csrfToken: 'csrf-token-1', enabled: true, expire, qaApi, user: { topicPreferences: ['AI'] } })
    await new Promise((r) => setTimeout(r, 0))

    listDeferred.resolve({
      data: [
        { id: 'session-1', title: 'Phiên 1', messageCount: 2 },
        { id: 'session-2', title: 'Phiên 2', messageCount: 3 },
      ],
    })
    await new Promise((r) => setTimeout(r, 10))
    expect(runner.current.sessions).toHaveLength(2)

    const pDelete = runner.current.handlers.onDeleteSession('session-1')
    expect(qaApi.deleteSession).toHaveBeenCalledWith('session-1', 'csrf-token-1')

    deleteDeferred.resolve({})
    await pDelete

    expect(runner.current.sessions).toEqual([
      { id: 'session-2', title: 'Phiên 2', messageCount: 3 },
    ])
  })

  it('deletes the currently active chat session and resets thread state to empty', async () => {
    const listDeferred = deferred()
    const getDeferred = deferred()
    const deleteDeferred = deferred()
    const qaApi = {
      listSessions: vi.fn(async () => listDeferred.promise),
      getSession: vi.fn(async () => getDeferred.promise),
      deleteSession: vi.fn(async () => deleteDeferred.promise),
    }
    const expire = vi.fn()
    const runner = createHookRunner(useQa)
    runner.render({ csrfToken: 'csrf-token-1', enabled: true, expire, qaApi, user: { topicPreferences: ['AI'] } })
    await new Promise((r) => setTimeout(r, 0))

    listDeferred.resolve({
      data: [
        { id: 'session-active', title: 'Phiên đang xem', messageCount: 1 },
      ],
    })
    await new Promise((r) => setTimeout(r, 10))

    const pSelect = runner.current.handlers.onSelectSession('session-active')
    getDeferred.resolve({
      data: {
        id: 'session-active',
        messages: [{ id: 'm1', role: 'user', text: 'Chào bot' }],
        messageCount: 1,
      },
    })
    await pSelect

    expect(runner.current.state).toBe('ready')
    expect(runner.current.scope.sessionId).toBe('session-active')
    expect(runner.current.messages).toHaveLength(1)

    const pDelete = runner.current.handlers.onDeleteSession('session-active')
    expect(qaApi.deleteSession).toHaveBeenCalledWith('session-active', 'csrf-token-1')

    deleteDeferred.resolve({})
    await pDelete

    expect(runner.current.sessions).toEqual([])
    expect(runner.current.messages).toEqual([])
    expect(runner.current.state).toBe('empty')
    expect(runner.current.scope.sessionId).toBeUndefined()
  })

  it('does not reintroduce a deleted session when an in-flight list response lands after delete', async () => {
    const staleList = deferred()
    const deleteDeferred = deferred()
    let listCalls = 0
    const qaApi = {
      listSessions: vi.fn(async () => {
        listCalls += 1
        if (listCalls === 1) {
          return {
            data: [
              { id: 'session-1', title: 'Phiên 1', messageCount: 2 },
              { id: 'session-2', title: 'Phiên 2', messageCount: 3 },
            ],
          }
        }
        return staleList.promise
      }),
      deleteSession: vi.fn(async () => deleteDeferred.promise),
    }
    const expire = vi.fn()
    const runner = createHookRunner(useQa)
    runner.render({ csrfToken: 'csrf-token-1', enabled: true, expire, qaApi, user: { topicPreferences: ['AI'] } })
    await new Promise((r) => setTimeout(r, 10))
    expect(runner.current.sessions).toHaveLength(2)

    const stalePromise = runner.current.handlers.onRetry()
    await new Promise((r) => setTimeout(r, 0))
    expect(qaApi.listSessions).toHaveBeenCalledTimes(2)

    const pDelete = runner.current.handlers.onDeleteSession('session-1')
    expect(qaApi.deleteSession).toHaveBeenCalledWith('session-1', 'csrf-token-1')

    deleteDeferred.resolve({})
    await pDelete
    expect(runner.current.sessions).toEqual([
      { id: 'session-2', title: 'Phiên 2', messageCount: 3 },
    ])

    staleList.resolve({
      data: [
        { id: 'session-1', title: 'Phiên 1', messageCount: 2 },
        { id: 'session-2', title: 'Phiên 2', messageCount: 3 },
      ],
    })
    await stalePromise
    await new Promise((r) => setTimeout(r, 10))

    expect(runner.current.sessions).toEqual([
      { id: 'session-2', title: 'Phiên 2', messageCount: 3 },
    ])
  })

  it('does not reintroduce a deleted session when a list starts while delete is pending', async () => {
    const deleteDeferred = deferred()
    const pendingList = deferred()
    let listCalls = 0
    const qaApi = {
      listSessions: vi.fn(async () => {
        listCalls += 1
        if (listCalls === 1) {
          return {
            data: [
              { id: 'session-1', title: 'Phiên 1', messageCount: 2 },
              { id: 'session-2', title: 'Phiên 2', messageCount: 3 },
            ],
          }
        }
        return pendingList.promise
      }),
      deleteSession: vi.fn(async () => deleteDeferred.promise),
    }
    const expire = vi.fn()
    const runner = createHookRunner(useQa)
    runner.render({ csrfToken: 'csrf-token-1', enabled: true, expire, qaApi, user: { topicPreferences: ['AI'] } })
    await new Promise((r) => setTimeout(r, 10))
    expect(runner.current.sessions).toHaveLength(2)

    const pDelete = runner.current.handlers.onDeleteSession('session-1')
    expect(qaApi.deleteSession).toHaveBeenCalledWith('session-1', 'csrf-token-1')

    const pendingPromise = runner.current.handlers.onRetry()
    await new Promise((r) => setTimeout(r, 0))
    expect(qaApi.listSessions).toHaveBeenCalledTimes(2)

    deleteDeferred.resolve({})
    await pDelete
    expect(runner.current.sessions).toEqual([
      { id: 'session-2', title: 'Phiên 2', messageCount: 3 },
    ])

    pendingList.resolve({
      data: [
        { id: 'session-1', title: 'Phiên 1', messageCount: 2 },
        { id: 'session-2', title: 'Phiên 2', messageCount: 3 },
      ],
    })
    await pendingPromise
    await new Promise((r) => setTimeout(r, 10))

    expect(runner.current.sessions).toEqual([
      { id: 'session-2', title: 'Phiên 2', messageCount: 3 },
    ])
  })

  it('ignores a stale delete completion after the session identity changes', async () => {
    const oldList = deferred()
    const newList = deferred()
    const deleteDeferred = deferred()
    let listCalls = 0
    const qaApi = {
      listSessions: vi.fn(async () => {
        listCalls += 1
        if (listCalls === 1) return oldList.promise
        return newList.promise
      }),
      deleteSession: vi.fn(async () => deleteDeferred.promise),
    }
    const expire = vi.fn()
    const runner = createHookRunner(useQa)
    runner.render({ csrfToken: 'csrf-old', enabled: true, expire, qaApi, user: { id: 'user-old', topicPreferences: ['AI'] } })
    await new Promise((r) => setTimeout(r, 0))

    oldList.resolve({ data: [{ id: 'old-1', title: 'Phiên cũ', messageCount: 2 }] })
    await new Promise((r) => setTimeout(r, 10))
    expect(runner.current.sessions).toHaveLength(1)

    const pDelete = runner.current.handlers.onDeleteSession('old-1')
    expect(qaApi.deleteSession).toHaveBeenCalledWith('old-1', 'csrf-old')

    runner.render({ csrfToken: 'csrf-new', enabled: true, expire, qaApi, user: { id: 'user-new', topicPreferences: ['AI'] } })
    expect(runner.current.sessions).toEqual([])

    const pReload = runner.current.handlers.onRetry()
    await new Promise((r) => setTimeout(r, 0))
    expect(qaApi.listSessions).toHaveBeenCalledTimes(2)

    deleteDeferred.resolve({})
    await pDelete
    await new Promise((r) => setTimeout(r, 0))
    expect(runner.current.sessions).toEqual([])

    newList.resolve({ data: [{ id: 'new-1', title: 'Phiên mới', messageCount: 1 }] })
    await pReload
    await new Promise((r) => setTimeout(r, 0))
    expect(runner.current.sessions).toEqual([
      { id: 'new-1', title: 'Phiên mới', messageCount: 1 },
    ])
    expect(expire).not.toHaveBeenCalled()
  })

  it('keeps sessions and messages intact when deleting the active session fails', async () => {
    const listDeferred = deferred()
    const getDeferred = deferred()
    const deleteDeferred = deferred()
    const qaApi = {
      listSessions: vi.fn(async () => listDeferred.promise),
      getSession: vi.fn(async () => getDeferred.promise),
      deleteSession: vi.fn(async () => deleteDeferred.promise),
    }
    const expire = vi.fn()
    const runner = createHookRunner(useQa)
    runner.render({ csrfToken: 'csrf-token-1', enabled: true, expire, qaApi, user: { topicPreferences: ['AI'] } })
    await new Promise((r) => setTimeout(r, 0))

    listDeferred.resolve({
      data: [
        { id: 'session-active', title: 'Phiên đang xem', messageCount: 1 },
        { id: 'session-other', title: 'Phiên khác', messageCount: 2 },
      ],
    })
    await new Promise((r) => setTimeout(r, 10))

    const pSelect = runner.current.handlers.onSelectSession('session-active')
    getDeferred.resolve({
      data: {
        id: 'session-active',
        messages: [{ id: 'm1', role: 'user', text: 'Chào bot' }],
        messageCount: 1,
      },
    })
    await pSelect
    expect(runner.current.messages).toHaveLength(1)

    const pDelete = runner.current.handlers.onDeleteSession('session-active')
    const failure = new Error('Xóa phiên thất bại')
    deleteDeferred.reject(failure)
    await pDelete

    expect(runner.current.sessions).toHaveLength(2)
    expect(runner.current.messages).toEqual([{ id: 'm1', role: 'user', text: 'Chào bot' }])
    expect(runner.current.scope.sessionId).toBe('session-active')
    expect(runner.current.state).toBe('error')
    expect(runner.current.error).toBe(failure)
    expect(expire).toHaveBeenCalledWith(failure)
  })

  it('ignores delete calls with missing session ids without calling the API', async () => {
    const qaApi = {
      listSessions: vi.fn(async () => ({
        data: [
          { id: 'session-1', title: 'Phiên 1', messageCount: 2 },
          { id: 'session-2', title: 'Phiên 2', messageCount: 3 },
        ],
      })),
      deleteSession: vi.fn(async () => ({})),
    }
    const expire = vi.fn()
    const runner = createHookRunner(useQa)
    runner.render({ csrfToken: 'csrf-token-1', enabled: true, expire, qaApi, user: { topicPreferences: ['AI'] } })
    await new Promise((r) => setTimeout(r, 10))
    expect(runner.current.sessions).toHaveLength(2)

    await runner.current.handlers.onDeleteSession(undefined)
    await runner.current.handlers.onDeleteSession('')
    await runner.current.handlers.onDeleteSession(null)

    expect(qaApi.deleteSession).not.toHaveBeenCalled()
    expect(runner.current.sessions).toHaveLength(2)
    expect(expire).not.toHaveBeenCalled()
  })

  it('treats repeated and unknown session deletes as idempotent', async () => {
    const qaApi = {
      listSessions: vi.fn(async () => ({
        data: [
          { id: 'session-target', title: 'Phiên xóa', messageCount: 1 },
          { id: 'session-other', title: 'Phiên giữ lại', messageCount: 4 },
        ],
      })),
      deleteSession: vi.fn(async () => ({})),
    }
    const expire = vi.fn()
    const runner = createHookRunner(useQa)
    runner.render({ csrfToken: 'csrf-token-1', enabled: true, expire, qaApi, user: { topicPreferences: ['AI'] } })
    await new Promise((r) => setTimeout(r, 10))

    await runner.current.handlers.onDeleteSession('session-target')
    expect(runner.current.sessions).toEqual([
      { id: 'session-other', title: 'Phiên giữ lại', messageCount: 4 },
    ])

    await runner.current.handlers.onDeleteSession('session-target')
    expect(runner.current.sessions).toEqual([
      { id: 'session-other', title: 'Phiên giữ lại', messageCount: 4 },
    ])

    await runner.current.handlers.onDeleteSession('session-missing')
    expect(runner.current.sessions).toEqual([
      { id: 'session-other', title: 'Phiên giữ lại', messageCount: 4 },
    ])
    expect(qaApi.deleteSession).toHaveBeenCalledTimes(3)
  })

  it('preserves the active thread when deleting an inactive session', async () => {
    const listDeferred = deferred()
    const getDeferred = deferred()
    const deleteDeferred = deferred()
    const qaApi = {
      listSessions: vi.fn(async () => listDeferred.promise),
      getSession: vi.fn(async () => getDeferred.promise),
      deleteSession: vi.fn(async () => deleteDeferred.promise),
    }
    const expire = vi.fn()
    const runner = createHookRunner(useQa)
    runner.render({ csrfToken: 'csrf-token-1', enabled: true, expire, qaApi, user: { topicPreferences: ['AI'] } })
    await new Promise((r) => setTimeout(r, 0))

    listDeferred.resolve({
      data: [
        { id: 'session-active', title: 'Phiên đang xem', messageCount: 1 },
        { id: 'session-inactive', title: 'Phiên nền', messageCount: 2 },
      ],
    })
    await new Promise((r) => setTimeout(r, 10))

    const pSelect = runner.current.handlers.onSelectSession('session-active')
    getDeferred.resolve({
      data: {
        id: 'session-active',
        messages: [{ id: 'm1', role: 'user', text: 'Chào bot' }],
        messageCount: 1,
      },
    })
    await pSelect
    expect(runner.current.scope.sessionId).toBe('session-active')

    const pDelete = runner.current.handlers.onDeleteSession('session-inactive')
    expect(qaApi.deleteSession).toHaveBeenCalledWith('session-inactive', 'csrf-token-1')

    deleteDeferred.resolve({})
    await pDelete

    expect(runner.current.sessions).toEqual([
      { id: 'session-active', title: 'Phiên đang xem', messageCount: 1 },
    ])
    expect(runner.current.messages).toEqual([{ id: 'm1', role: 'user', text: 'Chào bot' }])
    expect(runner.current.scope.sessionId).toBe('session-active')
    expect(runner.current.state).toBe('ready')
    expect(expire).not.toHaveBeenCalled()
  })
})
