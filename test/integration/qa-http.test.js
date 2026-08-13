import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createApp } from '../../server/app.js'

const TOKEN = 'qa-http-session-token'
const COOKIE = `__Host-techpulse_session=${TOKEN}`
const CHAT_ID = '507f1f77bcf86cd799439099'
const ARTICLE_ID = '507f1f77bcf86cd799439011'
const AUTH = {
  async authenticate() { return { user: { id: 'user-1', status: 'active' }, session: { version: 1 } } },
  async verifyCsrf({ token }) { if (token !== 'csrf') throw Object.assign(new Error('invalid csrf'), { status: 403, code: 'csrf_invalid' }) },
}

describe('Step 10 Q&A HTTP boundary', () => {
  let server
  let origin
  const calls = []
  const qaService = {
    async createAnswer(input) {
      calls.push(['createAnswer', input])
      if (input.question === 'Xung đột idempotency') throw Object.assign(new Error('Idempotency mismatch'), { status: 409, code: 'idempotency_mismatch' })
      if (input.question === 'Câu trả lời có citation lỗi') return { answer: { id: 'answer-invalid', status: 'answered', paragraphs: [{ text: 'Không được công khai.', citationIds: ['C-missing'] }], citations: [], refusalReason: null, chatSessionId: CHAT_ID, createdAt: '2026-08-12T00:00:00.000Z' } }
      return { answer: { id: 'answer-1', status: 'refused', paragraphs: [], citations: [], refusalReason: 'insufficient-evidence', chatSessionId: CHAT_ID, createdAt: '2026-08-12T00:00:00.000Z' } }
    },
    async listChatSessions() { calls.push(['listChatSessions']); return { sessions: [{ id: CHAT_ID, title: null, updatedAt: '2026-08-12T00:00:00.000Z' }], hasNext: false, nextCursor: null } },
    async getChatSession({ chatSessionId }) { calls.push(['getChatSession', chatSessionId]); return { session: { id: chatSessionId, title: null, scope: { articleId: ARTICLE_ID }, messageCount: 0, messages: [], createdAt: '2026-08-12T00:00:00.000Z', updatedAt: '2026-08-12T00:00:00.000Z' } } },
    async deleteChatSession({ chatSessionId }) { calls.push(['deleteChatSession', chatSessionId]) },
    async clearChatSessions() { calls.push(['clearChatSessions']) },
  }

  beforeAll(async () => {
    server = createApp({ authService: AUTH, qaService }).listen(0)
    await new Promise((resolve) => server.once('listening', resolve))
    origin = `http://127.0.0.1:${server.address().port}`
  })

  afterAll(async () => { await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())) })

  const headers = (extra = {}) => ({ Cookie: COOKIE, ...extra })

  it('dispatches all five canonical operations through one service boundary', async () => {
    const list = await fetch(`${origin}/api/v1/chat-sessions`, { headers: headers() })
    expect(list.status).toBe(200)
    expect(await list.json()).toMatchObject({ data: [{ id: CHAT_ID, title: null }], meta: { hasNext: false, nextCursor: null } })

    const detail = await fetch(`${origin}/api/v1/chat-sessions/${CHAT_ID}`, { headers: headers() })
    expect(detail.status).toBe(200)
    expect((await detail.json()).data.id).toBe(CHAT_ID)

    const answer = await fetch(`${origin}/api/v1/answers`, {
      method: 'POST',
      headers: headers({ Origin: 'http://localhost:3000', 'X-CSRF-Token': 'csrf', 'Idempotency-Key': 'qa-http-key-1', 'Content-Type': 'application/json' }),
      body: JSON.stringify({ question: 'Tìm bài viết về AI', scope: { articleId: ARTICLE_ID } }),
    })
    expect(answer.status).toBe(200)
    expect((await answer.json()).data.status).toBe('refused')

    const deleted = await fetch(`${origin}/api/v1/chat-sessions/${CHAT_ID}`, { method: 'DELETE', headers: headers({ Origin: 'http://localhost:3000', 'X-CSRF-Token': 'csrf' }) })
    expect(deleted.status).toBe(204)
    const cleared = await fetch(`${origin}/api/v1/chat-sessions`, { method: 'DELETE', headers: headers({ Origin: 'http://localhost:3000', 'X-CSRF-Token': 'csrf' }) })
    expect(cleared.status).toBe(204)
    expect(calls.map(([name]) => name)).toEqual(['listChatSessions', 'getChatSession', 'createAnswer', 'deleteChatSession', 'clearChatSessions'])
  })

  it('rejects unauthenticated and invalid answer transport before the service', async () => {
    const unauthenticated = await fetch(`${origin}/api/v1/chat-sessions`)
    expect(unauthenticated.status).toBe(401)
    const invalid = await fetch(`${origin}/api/v1/answers`, {
      method: 'POST',
      headers: headers({ Origin: 'http://localhost:3000', 'X-CSRF-Token': 'csrf', 'Idempotency-Key': 'qa-http-key-2', 'Content-Type': 'application/json' }),
      body: JSON.stringify({ question: 'x', scope: {} }),
    })
    expect(invalid.status).toBe(422)
    expect((await invalid.json()).error.code).toBe('validation_error')
    expect(calls.map(([name]) => name)).not.toContain('createAnswer-invalid')

    const missingKey = await fetch(`${origin}/api/v1/answers`, {
      method: 'POST',
      headers: headers({ Origin: 'http://localhost:3000', 'X-CSRF-Token': 'csrf', 'Content-Type': 'application/json' }),
      body: JSON.stringify({ question: 'Câu hỏi hợp lệ', scope: { articleId: ARTICLE_ID } }),
    })
    expect(missingKey.status).toBe(400)
    expect((await missingKey.json()).error.code).toBe('bad_request')
  })

  it('rejects a non-canonical chat session path before repository dispatch', async () => {
    const before = calls.length
    const detail = await fetch(`${origin}/api/v1/chat-sessions/chat-1`, { headers: headers() })
    const deleted = await fetch(`${origin}/api/v1/chat-sessions/chat-1`, { method: 'DELETE', headers: headers({ Origin: 'http://localhost:3000', 'X-CSRF-Token': 'csrf' }) })
    expect(detail.status).toBe(400)
    expect(deleted.status).toBe(400)
    expect((await detail.json()).error.code).toBe('bad_request')
    expect(calls).toHaveLength(before)
  })

  it('rejects a non-canonical article scope before service dispatch', async () => {
    const before = calls.length
    const response = await fetch(`${origin}/api/v1/answers`, {
      method: 'POST',
      headers: headers({ Origin: 'http://localhost:3000', 'X-CSRF-Token': 'csrf', 'Idempotency-Key': 'qa-http-scope-key', 'Content-Type': 'application/json' }),
      body: JSON.stringify({ question: 'Câu hỏi hợp lệ', scope: { articleId: 'article-1' } }),
    })
    expect(response.status).toBe(422)
    expect((await response.json()).error.code).toBe('validation_error')
    expect(calls).toHaveLength(before)
  })

  it('fails closed when a service result has an unresolved public citation ID', async () => {
    const response = await fetch(`${origin}/api/v1/answers`, {
      method: 'POST',
      headers: headers({ Origin: 'http://localhost:3000', 'X-CSRF-Token': 'csrf', 'Idempotency-Key': 'qa-http-public-answer', 'Content-Type': 'application/json' }),
      body: JSON.stringify({ question: 'Câu trả lời có citation lỗi', scope: { topics: ['ai'] } }),
    })
    expect(response.status).toBe(500)
    expect(await response.json()).toMatchObject({ error: { code: 'internal_error' } })
  })

  it('preserves the canonical idempotency mismatch code through HTTP', async () => {
    const response = await fetch(`${origin}/api/v1/answers`, {
      method: 'POST',
      headers: headers({ Origin: 'http://localhost:3000', 'X-CSRF-Token': 'csrf', 'Idempotency-Key': 'qa-http-mismatch-key', 'Content-Type': 'application/json' }),
      body: JSON.stringify({ question: 'Xung đột idempotency', scope: { topics: ['ai'] } }),
    })
    expect(response.status).toBe(409)
    expect((await response.json()).error.code).toBe('idempotency_mismatch')
  })
})
