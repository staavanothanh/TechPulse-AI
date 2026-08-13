import { describe, expect, it, vi } from 'vitest'
import { createQaApi } from '../../../client/features/qa/qa-api.js'

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
})
