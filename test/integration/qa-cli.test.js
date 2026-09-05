import { createServer } from 'node:http'
import { describe, expect, it } from 'vitest'
import { createApp } from '../../server/app.js'
import { parseQaCliArgs, runQaCli } from '../../scripts/qa-cli.js'

const SESSION_TOKEN = 'session-token-abcdefghijklmnopqrstuvwxyz'
const CSRF_TOKEN = 'csrf-token-abcdefghijklmnopqrstuvwxyz-123456'
const SESSION_ID = '507f1f77bcf86cd799439099'
const ARTICLE_ID = '507f1f77bcf86cd799439011'

const ANSWER = {
  data: {
    id: 'answer-integration-1',
    status: 'answered',
    paragraphs: [{ text: 'Kết luận có căn cứ.', citationIds: ['C1'] }],
    citations: [
      {
        id: 'C1',
        articleId: ARTICLE_ID,
        sourceId: '507f1f77bcf86cd799439012',
        sourceName: 'Nguồn biên tập',
        titleOriginal: 'Bài nguồn',
        originalUrl: 'https://example.com/article',
        author: null,
        publishedAt: '2026-08-10T00:00:00.000Z',
        sourceLanguage: 'vi',
      },
    ],
    refusalReason: null,
    chatSessionId: SESSION_ID,
    createdAt: '2026-08-12T00:00:00.000Z',
  },
}

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject)
      resolve()
    })
  })
}

function close(server) {
  return new Promise((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  )
}

describe('local Q&A CLI HTTP integration', () => {
  it('runs the real authenticated answer route and preserves the public envelope', async () => {
    const calls = []
    const csrfTokens = []
    const authService = {
      async authenticate() {
        return { user: { id: 'user-1', status: 'active' }, session: { version: 1 } }
      },
      async verifyCsrf({ token }) {
        csrfTokens.push(token)
        if (token !== CSRF_TOKEN)
          throw Object.assign(new Error('invalid csrf'), { status: 403, code: 'csrf_invalid' })
      },
    }
    const qaService = {
      async createAnswer(input) {
        calls.push(input)
        return { answer: ANSWER.data }
      },
    }
    const server = createServer()
    await listen(server)
    const origin = `http://127.0.0.1:${server.address().port}`
    server.on('request', createApp({ authService, qaService, allowedOrigins: origin }))

    try {
      const result = await runQaCli({
        options: parseQaCliArgs([
          '--question',
          '  Bài viết kết luận gì?  ',
          '--topic',
          'AI',
          '--chat-session-id',
          SESSION_ID,
          '--idempotency-key',
          'qa-cli-integration-1',
          '--base-url',
          origin,
        ]),
        environment: { QA_SESSION_TOKEN: SESSION_TOKEN, QA_CSRF_TOKEN: CSRF_TOKEN },
        fetchImpl: globalThis.fetch,
      })

      expect(result).toMatchObject({ ok: true, status: 200, body: ANSWER })
      expect(calls).toHaveLength(1)
      expect(csrfTokens).toEqual([CSRF_TOKEN])
      expect(calls[0]).toMatchObject({
        question: 'Bài viết kết luận gì?',
        scope: { topics: ['AI'] },
        chatSessionId: SESSION_ID,
        idempotencyKey: 'qa-cli-integration-1',
      })
    } finally {
      await close(server)
    }
  })
})
