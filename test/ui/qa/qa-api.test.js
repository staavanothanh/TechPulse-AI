import { describe, expect, it, vi } from 'vitest'
import { createQaApi, normalizeAnswerBody } from '../../../client/features/qa/qa-api.js'

function response(payload, status = 200, headers = {}) {
  return new Response(payload === undefined ? null : JSON.stringify(payload), { status, headers: { 'Content-Type': 'application/json', ...headers } })
}

describe('Step 10 Q&A API adapter', () => {
  it('uses exactly the five generated operations and keeps cursor/idempotency opaque', async () => {
    const fetchImpl = vi.fn(async (input) => {
      const url = new URL(input)
      if (url.pathname === '/api/v1/chat-sessions') return response({ data: [], meta: { hasNext: false, nextCursor: 'opaque-next' } })
      if (url.pathname === '/api/v1/answers') return response({ data: { id: 'a1', status: 'refused', paragraphs: [], citations: [], refusalReason: 'insufficient-evidence', chatSessionId: 's1', createdAt: '2026-08-12T00:00:00.000Z' } })
      return response(undefined, 204)
    })
    const generated = { listChatSessions: vi.fn((init) => init.fetchImpl('/api/v1/chat-sessions', init)), getChatSession: vi.fn((init) => init.fetchImpl('/api/v1/chat-sessions/s1', init)), createGroundedAnswer: vi.fn((init) => init.fetchImpl('/api/v1/answers', init)), deleteChatSession: vi.fn((init) => init.fetchImpl('/api/v1/chat-sessions/s1', init)), clearChatSessions: vi.fn((init) => init.fetchImpl('/api/v1/chat-sessions', init)) }
    const api = createQaApi(generated, fetchImpl)
    await api.listSessions({ cursor: 'opaque-cursor', limit: 20 })
    await api.createAnswer({ question: 'Câu hỏi hợp lệ', scope: { topics: ['AI'] } }, { csrfToken: 'csrf', idempotencyKey: 'hidden-key' })
    await api.deleteSession('s1', 'csrf')
    await api.clearSessions('csrf')
    const listUrl = new URL(fetchImpl.mock.calls[0][0])
    expect(listUrl.searchParams.get('cursor')).toBe('opaque-cursor')
    expect(listUrl.searchParams.get('limit')).toBe('20')
    const answerInit = fetchImpl.mock.calls[1][1]
    expect(answerInit.headers['X-CSRF-Token']).toBe('csrf')
    expect(answerInit.headers['Idempotency-Key']).toBe('hidden-key')
    expect(answerInit.body).toContain('Câu hỏi hợp lệ')
  })

  it('normalizes article-only and datetime-local scopes before transport', async () => {
    const fetchImpl = vi.fn(async () => response({ data: { status: 'refused', paragraphs: [], citations: [], refusalReason: 'insufficient-evidence' } }))
    const generated = {
      createGroundedAnswer: ({ fetchImpl: managedFetch, body, headers }) => managedFetch('/api/v1/answers', { body, headers }),
    }
    const api = createQaApi(generated, fetchImpl)
    await api.createAnswer({
      question: 'Câu hỏi article scope',
      scope: { articleId: '507f1f77bcf86cd799439011', topics: [] },
    })
    await api.createAnswer({
      question: 'Câu hỏi date scope',
      scope: { topics: [], publishedAfter: '2026-08-01T00:00', publishedBefore: '2026-08-02T00:00' },
    })
    await api.createAnswer({
      question: 'Câu hỏi topic scope',
      scope: { articleId: '', topics: ['AI'], publishedAfter: '', publishedBefore: '' },
    })
    const topicBody = JSON.parse(fetchImpl.mock.calls[2][1].body)
    expect(topicBody.scope).toEqual({ topics: ['AI'] })

    const articleBody = JSON.parse(fetchImpl.mock.calls[0][1].body)
    expect(articleBody.scope).toEqual({ articleId: '507f1f77bcf86cd799439011' })
    const dateBody = JSON.parse(fetchImpl.mock.calls[1][1].body)
    expect(dateBody.scope).toEqual({
      publishedAfter: new Date('2026-08-01T00:00').toISOString(),
      publishedBefore: new Date('2026-08-02T00:00').toISOString(),
    })
  })

  it('preserves explicit scope before transport while leaving temporal interpretation to the server', async () => {
    const now = new Date('2026-09-04T15:30:00.000Z')
    const body = { question: 'tháng 9 này có tin tức gì về các model AI mới không', scope: { topics: ['AI'] } }
    const fetchImpl = vi.fn(async () => response({ data: { status: 'refused', paragraphs: [], citations: [], refusalReason: 'insufficient-evidence' } }))
    const generated = {
      createGroundedAnswer: ({ fetchImpl: managedFetch, body: requestBody, headers }) => managedFetch('/api/v1/answers', { body: requestBody, headers }),
    }
    const api = createQaApi(generated, fetchImpl, { now })

    await api.createAnswer(body)

    const requestBody = JSON.parse(fetchImpl.mock.calls[0][1].body)
    expect(requestBody).toEqual(normalizeAnswerBody(body, { now }))
    expect(requestBody.scope).toEqual({ topics: ['AI'] })
  })

  it('preserves bounded Retry-After and canonical API error metadata', async () => {
    const fetchImpl = vi.fn(async () => response({ error: { code: 'rate_limit_exceeded', message: 'Rate limited', requestId: 'req-1' } }, 429, { 'Retry-After': '17' }))
    const generated = { listChatSessions: (init) => init.fetchImpl('/api/v1/chat-sessions', init) }
    await expect(createQaApi(generated, fetchImpl).listSessions()).rejects.toMatchObject({ status: 429, retryAfter: 17, code: 'rate_limit_exceeded', requestId: 'req-1' })
  })

  it('maps safe 422 detail paths to Q&A form fields', async () => {
    const fetchImpl = vi.fn(async () => response({ error: { code: 'validation_error', message: 'Invalid request', requestId: 'req-422', details: [{ field: '/question' }, { field: '/scope/publishedBefore' }, { field: '/scope/topics' }] } }, 422))
    const generated = { createGroundedAnswer: ({ fetchImpl: managedFetch }) => managedFetch('/api/v1/answers') }
    await expect(createQaApi(generated, fetchImpl).createAnswer({ question: 'abc', scope: { topics: ['AI'] } })).rejects.toMatchObject({
      status: 422,
      fieldErrors: {
        question: 'Câu hỏi chưa hợp lệ.',
        publishedBefore: 'Mốc kết thúc chưa hợp lệ.',
        topics: 'Danh sách chủ đề chưa hợp lệ.',
      },
    })
  })

  it('keeps Retry-After isolated per overlapping invocation', async () => {
    let releaseSlow
    const slow = new Promise((resolve) => { releaseSlow = resolve })
    const fetchImpl = vi.fn(async (input) => {
      if (new URL(input).pathname.includes('slow')) {
        await slow
        return response({ error: { code: 'rate_limit_exceeded', message: 'Rate limited' } }, 429, { 'Retry-After': '19' })
      }
      return response({ error: { code: 'service_unavailable', message: 'Unavailable' } }, 503)
    })
    const generated = {
      listChatSessions: ({ fetchImpl: managedFetch }) => managedFetch('/slow'),
      getChatSession: ({ fetchImpl: managedFetch }) => managedFetch('/fast'),
    }
    const api = createQaApi(generated, fetchImpl)
    const slowRequest = api.listSessions()
    const fastRequest = api.getSession('s1')
    releaseSlow()
    await expect(slowRequest).rejects.toMatchObject({ status: 429, retryAfter: 19 })
    await expect(fastRequest).rejects.toMatchObject({ status: 503 })
    await expect(fastRequest).rejects.not.toMatchObject({ retryAfter: 19 })
  })
})
