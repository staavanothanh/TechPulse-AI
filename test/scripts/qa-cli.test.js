import { describe, expect, it, vi } from 'vitest'
import {
  QA_CLI_USAGE,
  main,
  normalizeQaRequest,
  parseQaCliArgs,
  resolveQaCliAuth,
  runQaCli,
} from '../../scripts/qa-cli.js'

const ARTICLE_ID = '507f1f77bcf86cd799439011'
const SESSION_ID = '507f1f77bcf86cd799439099'
const SESSION_TOKEN = 'session-token-abcdefghijklmnopqrstuvwxyz'
const ANSWER = {
  data: {
    id: 'answer-1',
    status: 'answered',
    paragraphs: [{ text: 'Kết luận có căn cứ.', citationIds: ['C1'] }],
    citations: [{
      id: 'C1',
      articleId: ARTICLE_ID,
      sourceId: '507f1f77bcf86cd799439012',
      sourceName: 'Nguồn biên tập',
      titleOriginal: 'Bài nguồn',
      originalUrl: 'https://example.com/article',
      author: null,
      publishedAt: '2026-08-10T00:00:00.000Z',
      sourceLanguage: 'vi',
    }],
    refusalReason: null,
    chatSessionId: SESSION_ID,
    createdAt: '2026-08-12T00:00:00.000Z',
  },
}

function jsonResponse(body, status = 200, headers = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...headers },
  })
}

describe('local Q&A CLI', () => {
  it('parses bounded one-shot options and supports help without requiring a question', () => {
    expect(parseQaCliArgs(['--help'])).toEqual({ help: true })
    expect(QA_CLI_USAGE).toContain('scripts/qa-cli.js')
    expect(parseQaCliArgs([
      '--question', '  Bài viết kết luận gì?  ',
      '--article-id', ARTICLE_ID,
      '--topic=AI',
      '--topic', 'ML',
      '--published-after=2026-08-01T00:00:00',
      '--published-before', '2026-08-02T00:00:00',
      '--chat-session-id', SESSION_ID,
      '--idempotency-key', 'qa-cli-key-1',
      '--base-url', 'http://localhost:3100',
    ])).toEqual({
      help: false,
      question: '  Bài viết kết luận gì?  ',
      articleId: ARTICLE_ID,
      topics: ['AI', 'ML'],
      publishedAfter: '2026-08-01T00:00:00',
      publishedBefore: '2026-08-02T00:00:00',
      chatSessionId: SESSION_ID,
      idempotencyKey: 'qa-cli-key-1',
      baseUrl: 'http://localhost:3100',
      sessionToken: undefined,
      sessionCookie: undefined,
      csrfToken: undefined,
      email: undefined,
      password: undefined,
    })
    expect(() => parseQaCliArgs(['--question', 'x', '--unknown'])).toThrow(/unknown argument/i)
    expect(() => parseQaCliArgs(['--question', 'x', '--topic'])).toThrow(/requires a value/i)
  })

  it('normalizes the same trimmed question, empty scope fields, and ISO date fields as the web API adapter', () => {
    expect(normalizeQaRequest({
      question: '  Bài viết kết luận gì?  ',
      scope: {
        articleId: '',
        topics: ['AI'],
        publishedAfter: '2026-08-01T00:00:00.000Z',
        publishedBefore: '2026-08-02T00:00:00.000Z',
      },
      chatSessionId: '',
    })).toEqual({
      question: 'Bài viết kết luận gì?',
      scope: {
        topics: ['AI'],
        publishedAfter: '2026-08-01T00:00:00.000Z',
        publishedBefore: '2026-08-02T00:00:00.000Z',
      },
    })
  })

  it('resolves direct session credentials and prefers environment credentials over flags', () => {
    expect(resolveQaCliAuth({
      options: parseQaCliArgs(['--question', 'Câu hỏi hợp lệ', '--session-token', SESSION_TOKEN, '--csrf-token', 'flag-csrf']),
      environment: { QA_CSRF_TOKEN: 'env-csrf' },
    })).toEqual({
      mode: 'session',
      cookie: `__Host-techpulse_session=${SESSION_TOKEN}`,
      csrfToken: 'env-csrf',
    })

    expect(resolveQaCliAuth({
      options: parseQaCliArgs(['--question', 'Câu hỏi hợp lệ', '--email', 'flag@example.com', '--password', 'flag-password']),
      environment: { QA_EMAIL: 'env@example.com', QA_PASSWORD: 'env-password' },
    })).toEqual({ mode: 'login', email: 'env@example.com', password: 'env-password' })
    expect(() => resolveQaCliAuth({ options: parseQaCliArgs(['--question', 'Câu hỏi hợp lệ']) })).toThrow(/authentication/i)
  })

  it('posts directly to the existing answer route with session headers and returns the public response unchanged', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(ANSWER))
    const result = await runQaCli({
      options: parseQaCliArgs(['--question', '  Bài viết kết luận gì?  ', '--topic', 'AI', '--idempotency-key', 'qa-cli-session-1']),
      environment: {
        QA_SESSION_TOKEN: SESSION_TOKEN,
        QA_CSRF_TOKEN: 'csrf-token',
      },
      fetchImpl,
    })

    expect(result).toMatchObject({ ok: true, status: 200, body: ANSWER })
    expect(fetchImpl).toHaveBeenCalledTimes(1)
    const [url, init] = fetchImpl.mock.calls[0]
    expect(String(url)).toBe('http://localhost:3000/api/v1/answers')
    expect(init.method).toBe('POST')
    expect(init.headers).toMatchObject({
      Origin: 'http://localhost:3000',
      Cookie: `__Host-techpulse_session=${SESSION_TOKEN}`,
      'X-CSRF-Token': 'csrf-token',
      'Idempotency-Key': 'qa-cli-session-1',
      'Content-Type': 'application/json',
    })
    expect(JSON.parse(init.body)).toEqual({ question: 'Bài viết kết luận gì?', scope: { topics: ['AI'] } })
  })

  it('logs in through the existing auth route in memory, then submits the answer without printing credentials', async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ data: { user: { id: 'user-1' }, csrfToken: 'login-csrf' } }, 200, {
        'Set-Cookie': `__Host-techpulse_session=${encodeURIComponent(SESSION_TOKEN)}; Path=/; HttpOnly`,
      }))
      .mockResolvedValueOnce(jsonResponse(ANSWER))
    const log = vi.fn()
    const errorLog = vi.fn()
    const result = await main([
      '--question', 'Câu hỏi hợp lệ', '--topic', 'AI', '--email', 'flag@example.com', '--password', 'flag-password',
    ], {
      environment: { QA_EMAIL: 'env@example.com', QA_PASSWORD: 'env-password' },
      fetchImpl,
      log,
      errorLog,
    })

    expect(result).toMatchObject({ ok: true, status: 200, body: ANSWER })
    expect(fetchImpl).toHaveBeenCalledTimes(2)
    const [loginUrl, loginInit] = fetchImpl.mock.calls[0]
    expect(String(loginUrl)).toBe('http://localhost:3000/api/v1/auth/login')
    expect(JSON.parse(loginInit.body)).toEqual({ email: 'env@example.com', password: 'env-password' })
    const [, answerInit] = fetchImpl.mock.calls[1]
    expect(answerInit.headers.Cookie).toBe(`__Host-techpulse_session=${SESSION_TOKEN}`)
    expect(answerInit.headers['X-CSRF-Token']).toBe('login-csrf')
    expect(log).toHaveBeenCalledWith(JSON.stringify(ANSWER))
    expect(errorLog).not.toHaveBeenCalled()
    expect(JSON.stringify(log.mock.calls)).not.toContain('env-password')
    expect(JSON.stringify(errorLog.mock.calls)).not.toContain('env-password')
  })

  it('fails client-side validation before any network call and preserves canonical HTTP error envelopes', async () => {
    const fetchImpl = vi.fn()
    await expect(runQaCli({
      options: parseQaCliArgs(['--question', 'x', '--topic', 'AI']),
      environment: { QA_SESSION_TOKEN: SESSION_TOKEN, QA_CSRF_TOKEN: 'csrf-token' },
      fetchImpl,
    })).rejects.toMatchObject({ status: 422, code: 'validation_error' })
    expect(fetchImpl).not.toHaveBeenCalled()

    const limited = vi.fn(async () => jsonResponse({ error: {
      code: 'rate_limit_exceeded', message: 'Too many attempts', requestId: 'req-1', details: [{ field: 'quota' }],
    } }, 429, { 'Retry-After': '17' }))
    const result = await runQaCli({
      options: parseQaCliArgs(['--question', 'Câu hỏi hợp lệ', '--topic', 'AI']),
      environment: { QA_SESSION_TOKEN: SESSION_TOKEN, QA_CSRF_TOKEN: 'csrf-token' },
      fetchImpl: limited,
    })
    expect(result).toEqual({ ok: false, status: 429, stage: 'answer', body: { error: {
      code: 'rate_limit_exceeded', message: 'Too many attempts', requestId: 'req-1', details: [{ field: 'quota' }],
    } } })
  })

  it('rejects malformed public answer output instead of emitting untrusted provider data', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ data: {
      id: 'answer-invalid', status: 'answered', paragraphs: [{ text: 'Leak', citationIds: ['C-missing'] }], citations: [], refusalReason: null, chatSessionId: SESSION_ID, createdAt: '2026-08-12T00:00:00.000Z',
    }}))
    await expect(runQaCli({
      options: parseQaCliArgs(['--question', 'Câu hỏi hợp lệ', '--topic', 'AI']),
      environment: { QA_SESSION_TOKEN: SESSION_TOKEN, QA_CSRF_TOKEN: 'csrf-token' },
      fetchImpl,
    })).rejects.toMatchObject({ status: 502, code: 'internal_error' })
  })
})
