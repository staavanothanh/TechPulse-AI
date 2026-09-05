import { describe, expect, it, vi } from 'vitest'
import {
  QA_CLI_USAGE,
  main,
  normalizeQaRequest,
  parseQaCliArgs,
  resolveQaCliAuth,
  runQaCli,
} from '../../scripts/qa-cli.js'
import { normalizeAnswerBody } from '../../client/features/qa/qa-api.js'

const ARTICLE_ID = '507f1f77bcf86cd799439011'
const SESSION_ID = '507f1f77bcf86cd799439099'
const SESSION_TOKEN = 'session-token-abcdefghijklmnopqrstuvwxyz'
const CSRF_TOKEN = 'csrf-token-abcdefghijklmnopqrstuvwxyz-123456'
const LOGIN_CSRF_TOKEN = 'login-csrf-token-abcdefghijklmnopqrstuvwxyz-123456'

const ANSWER = {
  data: {
    id: 'answer-1',
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

function jsonResponse(body, status = 200, headers = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...headers },
  })
}

describe('local Q&A CLI', () => {
  it('parses bounded one-shot options, timeout bounds, and supports help without requiring a question', () => {
    expect(parseQaCliArgs(['--help'])).toEqual({ help: true })
    expect(QA_CLI_USAGE).toContain('scripts/qa-cli.js')
    expect(parseQaCliArgs([])).toMatchObject({ help: false, timeoutMs: undefined })
    expect(
      parseQaCliArgs([
        '--question',
        '  Bài viết kết luận gì?  ',
        '--article-id',
        ARTICLE_ID,
        '--topic=AI',
        '--topic',
        'ML',
        '--published-after=2026-08-01T00:00:00',
        '--published-before',
        '2026-08-02T00:00:00',
        '--chat-session-id',
        SESSION_ID,
        '--idempotency-key',
        'qa-cli-key-1',
        '--timeout-ms',
        '1500',
        '--base-url',
        'http://localhost:3100',
      ]),
    ).toEqual({
      help: false,
      question: '  Bài viết kết luận gì?  ',
      articleId: ARTICLE_ID,
      topics: ['AI', 'ML'],
      publishedAfter: '2026-08-01T00:00:00',
      publishedBefore: '2026-08-02T00:00:00',
      chatSessionId: SESSION_ID,
      idempotencyKey: 'qa-cli-key-1',
      baseUrl: 'http://localhost:3100',
      timeoutMs: 1500,
      sessionToken: undefined,
      sessionCookie: undefined,
      csrfToken: undefined,
      email: undefined,
      password: undefined,
    })
    expect(() => parseQaCliArgs(['--question', 'x', '--timeout-ms', '99'])).toThrow(
      /between 100 and 300000/i,
    )
    expect(() => parseQaCliArgs(['--question', 'x', '--timeout-ms', '300001'])).toThrow(
      /between 100 and 300000/i,
    )
    expect(() => parseQaCliArgs(['--question', 'x', '--timeout-ms', '1.5'])).toThrow(
      /between 100 and 300000/i,
    )
    expect(parseQaCliArgs(['--question', 'x', '--timeout-ms', '100']).timeoutMs).toBe(100)
    expect(parseQaCliArgs(['--question', 'x', '--timeout-ms', '300000']).timeoutMs).toBe(300000)
    expect(() => parseQaCliArgs(['--question', 'x', '--unknown'])).toThrow(/unknown argument/i)
    let unknownError
    try {
      parseQaCliArgs(['--question', 'x', '--unknown=secret-argv-value'])
    } catch (error) {
      unknownError = error
    }
    expect(unknownError).toMatchObject({ code: 'bad_request' })
    expect(unknownError.message).not.toContain('secret-argv-value')
    expect(() => parseQaCliArgs(['--question', 'x', '--topic'])).toThrow(/requires a value/i)
  })

  it('normalizes the same trimmed question, empty scope fields, and ISO date fields as the web API adapter', () => {
    expect(
      normalizeQaRequest({
        question: '  Bài viết kết luận gì?  ',
        scope: {
          articleId: '',
          topics: ['AI'],
          publishedAfter: '2026-08-01T00:00:00.000Z',
          publishedBefore: '2026-08-02T00:00:00.000Z',
        },
        chatSessionId: '',
      }),
    ).toEqual({
      question: 'Bài viết kết luận gì?',
      scope: {
        topics: ['AI'],
        publishedAfter: '2026-08-01T00:00:00.000Z',
        publishedBefore: '2026-08-02T00:00:00.000Z',
      },
    })
  })

  it('preserves explicit scope in the CLI and produces the same body as web normalization', async () => {
    const now = new Date('2026-09-04T15:30:00.000Z')
    const question = 'tháng 9 này có tin tức gì về các model AI mới không'
    const scope = { topics: ['AI'] }
    const cliBody = normalizeQaRequest({ question, scope, now })
    const webBody = normalizeAnswerBody({ question, scope }, { now })
    expect(cliBody).toEqual(webBody)
    expect(cliBody.scope).toEqual({
      topics: ['AI'],
    })

    const fetchImpl = vi.fn(async () => jsonResponse(ANSWER))
    await runQaCli({
      options: parseQaCliArgs(['--question', question, '--topic', 'AI', '--idempotency-key', 'temporal-cli-key']),
      environment: { QA_SESSION_TOKEN: SESSION_TOKEN, QA_CSRF_TOKEN: CSRF_TOKEN },
      fetchImpl,
      now,
    })
    expect(JSON.parse(fetchImpl.mock.calls[0][1].body)).toEqual(cliBody)
  })

  it('keeps unknown temporal phrases unchanged and rejects one-sided explicit dates', async () => {
    const now = new Date('2026-09-04T15:30:00.000Z')
    expect(normalizeQaRequest({ question: 'tháng 13 này có tin gì?', scope: { topics: ['AI'] }, now }).scope).toEqual({ topics: ['AI'] })
    const fetchImpl = vi.fn(async () => jsonResponse(ANSWER))
    await expect(runQaCli({
      options: parseQaCliArgs([
        '--question',
        'tháng 9 này có tin gì?',
        '--topic',
        'AI',
        '--published-after',
        '2026-09-01T00:00:00.000Z',
      ]),
      environment: { QA_SESSION_TOKEN: SESSION_TOKEN, QA_CSRF_TOKEN: CSRF_TOKEN },
      fetchImpl,
      now,
    })).rejects.toMatchObject({ status: 422, code: 'validation_error', details: [{ field: 'publishedBefore' }] })
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('resolves direct session credentials and prefers environment credentials over flags', () => {
    expect(
      resolveQaCliAuth({
        options: parseQaCliArgs([
          '--question',
          'Câu hỏi hợp lệ',
          '--session-token',
          SESSION_TOKEN,
          '--csrf-token',
          'flag-csrf-token-abcdefghijklmnopqrstuvwxyz-123456',
        ]),
        environment: { QA_CSRF_TOKEN: CSRF_TOKEN },
      }),
    ).toEqual({
      mode: 'session',
      cookie: `__Host-techpulse_session=${SESSION_TOKEN}`,
      csrfToken: CSRF_TOKEN,
    })

    expect(
      resolveQaCliAuth({
        options: parseQaCliArgs([
          '--question',
          'Câu hỏi hợp lệ',
          '--email',
          'flag@example.com',
          '--password',
          'flag-password',
        ]),
        environment: { QA_EMAIL: 'env@example.com', QA_PASSWORD: 'env-password' },
      }),
    ).toEqual({ mode: 'login', email: 'env@example.com', password: 'env-password' })
    expect(() =>
      resolveQaCliAuth({ options: parseQaCliArgs(['--question', 'Câu hỏi hợp lệ']) }),
    ).toThrow(/authentication/i)
  })

  it('rejects CSRF tokens outside the inclusive 32..256 boundary before any request', () => {
    const options = parseQaCliArgs([
      '--question',
      'Câu hỏi hợp lệ',
      '--session-token',
      SESSION_TOKEN,
    ])
    for (const token of ['x'.repeat(31), 'x'.repeat(257)]) {
      let error
      try {
        resolveQaCliAuth({ options, environment: { QA_CSRF_TOKEN: token } })
      } catch (caught) {
        error = caught
      }
      expect(error).toMatchObject({ status: 403, code: 'csrf_invalid' })
    }
    expect(
      resolveQaCliAuth({ options, environment: { QA_CSRF_TOKEN: 'x'.repeat(32) } }).csrfToken,
    ).toHaveLength(32)
    expect(
      resolveQaCliAuth({ options, environment: { QA_CSRF_TOKEN: 'x'.repeat(256) } }).csrfToken,
    ).toHaveLength(256)
  })

  it('posts directly to the existing answer route with session headers and returns the public response unchanged', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(ANSWER))
    const result = await runQaCli({
      options: parseQaCliArgs([
        '--question',
        '  Bài viết kết luận gì?  ',
        '--topic',
        'AI',
        '--idempotency-key',
        'qa-cli-session-1',
      ]),
      environment: {
        QA_SESSION_TOKEN: SESSION_TOKEN,
        QA_CSRF_TOKEN: CSRF_TOKEN,
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
      'X-CSRF-Token': CSRF_TOKEN,
      'Idempotency-Key': 'qa-cli-session-1',
      'Content-Type': 'application/json',
    })
    expect(init.redirect).toBe('error')
    expect(init.signal).toBeInstanceOf(globalThis.AbortSignal)
    expect(init.signal.aborted).toBe(false)
    expect(JSON.parse(init.body)).toEqual({
      question: 'Bài viết kết luận gì?',
      scope: { topics: ['AI'] },
    })
  })

  it('uses the default timeout and aborts a pending request with a safe timeout error', async () => {
    vi.useFakeTimers()
    try {
      let requestInit
      const fetchImpl = vi.fn((_url, init) => {
        requestInit = init
        return new Promise((_, reject) => {
          init.signal.addEventListener(
            'abort',
            () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })),
            { once: true },
          )
        })
      })
      const pending = runQaCli({
        options: parseQaCliArgs(['--question', 'Câu hỏi hợp lệ', '--topic', 'AI']),
        environment: { QA_SESSION_TOKEN: SESSION_TOKEN, QA_CSRF_TOKEN: CSRF_TOKEN },
        fetchImpl,
      })

      expect(fetchImpl).toHaveBeenCalledTimes(1)
      expect(requestInit.redirect).toBe('error')
      expect(requestInit.signal).toBeInstanceOf(globalThis.AbortSignal)
      expect(requestInit.signal.aborted).toBe(false)
      await vi.advanceTimersByTimeAsync(119999)
      expect(requestInit.signal.aborted).toBe(false)
      const timedOut = expect(pending).rejects.toMatchObject({
        status: 503,
        code: 'service_unavailable',
      })
      await vi.advanceTimersByTimeAsync(1)
      await timedOut
      expect(requestInit.signal.aborted).toBe(true)
    } finally {
      vi.useRealTimers()
    }
  })

  it('uses QA_TIMEOUT_MS when no timeout flag is supplied', async () => {
    vi.useFakeTimers()
    try {
      let requestInit
      const fetchImpl = vi.fn((_url, init) => {
        requestInit = init
        return new Promise((_, reject) => {
          init.signal.addEventListener(
            'abort',
            () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })),
            { once: true },
          )
        })
      })
      const pending = runQaCli({
        options: parseQaCliArgs(['--question', 'Câu hỏi hợp lệ', '--topic', 'AI']),
        environment: {
          QA_SESSION_TOKEN: SESSION_TOKEN,
          QA_CSRF_TOKEN: CSRF_TOKEN,
          QA_TIMEOUT_MS: '100',
        },
        fetchImpl,
      })

      expect(requestInit.signal).toBeInstanceOf(globalThis.AbortSignal)
      await vi.advanceTimersByTimeAsync(99)
      expect(requestInit.signal.aborted).toBe(false)
      const timedOut = expect(pending).rejects.toMatchObject({
        status: 503,
        code: 'service_unavailable',
      })
      await vi.advanceTimersByTimeAsync(1)
      await timedOut
      expect(requestInit.signal.aborted).toBe(true)
    } finally {
      vi.useRealTimers()
    }
  })

  it('rejects an oversized successful response instead of emitting provider data', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ data: ANSWER.data, providerPayload: 'oversized-provider-payload' }, 200, {
        'Content-Length': String(4 * 1024 * 1024 + 1),
      }),
    )
    await expect(
      runQaCli({
        options: parseQaCliArgs(['--question', 'Câu hỏi hợp lệ', '--topic', 'AI']),
        environment: { QA_SESSION_TOKEN: SESSION_TOKEN, QA_CSRF_TOKEN: CSRF_TOKEN },
        fetchImpl,
      }),
    ).rejects.toMatchObject({ status: 502, code: 'internal_error' })
    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })

  it('requires the repository root before making a request', async () => {
    const fetchImpl = vi.fn()
    const cwdSpy = vi.spyOn(process, 'cwd').mockReturnValue('C:\\outside-qa-cli-root')
    try {
      await expect(
        runQaCli({
          options: parseQaCliArgs(['--question', 'Câu hỏi hợp lệ', '--topic', 'AI']),
          environment: { QA_SESSION_TOKEN: SESSION_TOKEN, QA_CSRF_TOKEN: CSRF_TOKEN },
          fetchImpl,
        }),
      ).rejects.toMatchObject({ status: 400, code: 'bad_request' })
      expect(fetchImpl).not.toHaveBeenCalled()
    } finally {
      cwdSpy.mockRestore()
    }
  })

  it('logs in through the existing auth route in memory, then submits the answer without printing credentials', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse({ data: { user: { id: 'user-1' }, csrfToken: LOGIN_CSRF_TOKEN } }, 200, {
          'Set-Cookie': `__Host-techpulse_session=${encodeURIComponent(SESSION_TOKEN)}; Path=/; HttpOnly`,
        }),
      )
      .mockResolvedValueOnce(jsonResponse(ANSWER))
    const log = vi.fn()
    const errorLog = vi.fn()
    const result = await main(
      [
        '--question',
        'Câu hỏi hợp lệ',
        '--topic',
        'AI',
        '--email',
        'flag@example.com',
        '--password',
        'flag-password',
      ],
      {
        environment: { QA_EMAIL: 'env@example.com', QA_PASSWORD: 'env-password' },
        fetchImpl,
        log,
        errorLog,
      },
    )

    expect(result).toMatchObject({ ok: true, status: 200, body: ANSWER })
    expect(fetchImpl).toHaveBeenCalledTimes(2)
    const [loginUrl, loginInit] = fetchImpl.mock.calls[0]
    expect(String(loginUrl)).toBe('http://localhost:3000/api/v1/auth/login')
    expect(JSON.parse(loginInit.body)).toEqual({
      email: 'env@example.com',
      password: 'env-password',
    })
    const [, answerInit] = fetchImpl.mock.calls[1]
    expect(answerInit.headers.Cookie).toBe(`__Host-techpulse_session=${SESSION_TOKEN}`)
    expect(answerInit.headers['X-CSRF-Token']).toBe(LOGIN_CSRF_TOKEN)
    expect(log).toHaveBeenCalledWith(JSON.stringify(ANSWER))
    expect(errorLog).not.toHaveBeenCalled()
    expect(JSON.stringify(log.mock.calls)).not.toContain('env-password')
    expect(JSON.stringify(errorLog.mock.calls)).not.toContain('env-password')
  })

  it('requires a bounded login CSRF token and a session cookie before answer handoff', async () => {
    const options = parseQaCliArgs([
      '--question',
      'Câu hỏi hợp lệ',
      '--topic',
      'AI',
      '--email',
      'user@example.com',
      '--password',
      'secret',
    ])
    const environment = { QA_EMAIL: 'user@example.com', QA_PASSWORD: 'secret' }
    const cookie = `__Host-techpulse_session=${encodeURIComponent(SESSION_TOKEN)}; Path=/; HttpOnly`
    const runLogin = (body, headers = {}) => {
      const fetchImpl = vi.fn(async () => jsonResponse(body, 200, headers))
      return { fetchImpl, pending: runQaCli({ options, environment, fetchImpl }) }
    }

    for (const csrfToken of ['x'.repeat(31), 'x'.repeat(257)]) {
      const { fetchImpl, pending } = runLogin(
        { data: { user: { id: 'user-1' }, csrfToken } },
        { 'Set-Cookie': cookie },
      )
      await expect(pending).rejects.toMatchObject({ status: 502, code: 'internal_error' })
      expect(fetchImpl).toHaveBeenCalledTimes(1)
    }

    const missingCsrf = runLogin({ data: { user: { id: 'user-1' } } }, { 'Set-Cookie': cookie })
    await expect(missingCsrf.pending).rejects.toMatchObject({ status: 502, code: 'internal_error' })
    expect(missingCsrf.fetchImpl).toHaveBeenCalledTimes(1)

    const missingCookie = runLogin({
      data: { user: { id: 'user-1' }, csrfToken: LOGIN_CSRF_TOKEN },
    })
    await expect(missingCookie.pending).rejects.toMatchObject({
      status: 502,
      code: 'internal_error',
    })
    expect(missingCookie.fetchImpl).toHaveBeenCalledTimes(1)
  })

  it('fails client-side validation before any network call and preserves canonical HTTP error envelopes', async () => {
    const fetchImpl = vi.fn()
    await expect(
      runQaCli({
        options: parseQaCliArgs(['--question', 'x', '--topic', 'AI']),
        environment: { QA_SESSION_TOKEN: SESSION_TOKEN, QA_CSRF_TOKEN: CSRF_TOKEN },
        fetchImpl,
      }),
    ).rejects.toMatchObject({ status: 422, code: 'validation_error' })
    expect(fetchImpl).not.toHaveBeenCalled()

    const limited = vi.fn(async () =>
      jsonResponse(
        {
          error: {
            code: 'rate_limit_exceeded',
            message: 'Too many attempts',
            requestId: 'req-1',
            details: [{ field: 'quota' }],
          },
        },
        429,
        { 'Retry-After': '17' },
      ),
    )
    const result = await runQaCli({
      options: parseQaCliArgs(['--question', 'Câu hỏi hợp lệ', '--topic', 'AI']),
      environment: { QA_SESSION_TOKEN: SESSION_TOKEN, QA_CSRF_TOKEN: CSRF_TOKEN },
      fetchImpl: limited,
    })
    expect(result).toEqual({
      ok: false,
      status: 429,
      stage: 'answer',
      body: {
        error: {
          code: 'rate_limit_exceeded',
          message: 'Too many attempts',
          requestId: 'req-1',
          details: [{ field: 'quota' }],
        },
      },
    })
  })

  it('rejects malformed public answer output instead of emitting untrusted provider data', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({
        data: {
          id: 'answer-invalid',
          status: 'answered',
          paragraphs: [{ text: 'Leak', citationIds: ['C-missing'] }],
          citations: [],
          refusalReason: null,
          chatSessionId: SESSION_ID,
          createdAt: '2026-08-12T00:00:00.000Z',
        },
      }),
    )
    await expect(
      runQaCli({
        options: parseQaCliArgs(['--question', 'Câu hỏi hợp lệ', '--topic', 'AI']),
        environment: { QA_SESSION_TOKEN: SESSION_TOKEN, QA_CSRF_TOKEN: CSRF_TOKEN },
        fetchImpl,
      }),
    ).rejects.toMatchObject({ status: 502, code: 'internal_error' })
  })

  it('accepts valid answered/refused data and rejects bare or extra-key 2xx envelopes', async () => {
    const options = parseQaCliArgs(['--question', 'Câu hỏi hợp lệ', '--topic', 'AI'])
    const environment = { QA_SESSION_TOKEN: SESSION_TOKEN, QA_CSRF_TOKEN: CSRF_TOKEN }
    const run = (body) =>
      runQaCli({ options, environment, fetchImpl: vi.fn(async () => jsonResponse(body)) })
    await expect(run(ANSWER)).resolves.toMatchObject({ ok: true, status: 200, body: ANSWER })

    const refused = {
      data: {
        ...ANSWER.data,
        id: 'answer-refused-envelope',
        status: 'refused',
        paragraphs: [],
        citations: [],
        refusalReason: 'insufficient-evidence',
      },
    }
    await expect(run(refused)).resolves.toMatchObject({ ok: true, status: 200, body: refused })
    await expect(run(ANSWER.data)).rejects.toMatchObject({ status: 502, code: 'internal_error' })

    const providerPayload = 'provider-payload-must-not-leak'
    const errorLog = vi.fn()
    const result = await main(['--question', 'Câu hỏi hợp lệ', '--topic', 'AI'], {
      environment,
      fetchImpl: vi.fn(async () => jsonResponse({ ...ANSWER, providerPayload })),
      errorLog,
    })
    expect(result).toMatchObject({
      ok: false,
      status: 502,
      body: { error: { code: 'internal_error' } },
    })
    expect(JSON.stringify(errorLog.mock.calls)).not.toContain(providerPayload)
    process.exitCode = undefined
  })
  it('accepts a full session cookie and rejects incomplete session or login credentials without network access', () => {
    expect(
      resolveQaCliAuth({
        options: parseQaCliArgs([
          '--question',
          'Câu hỏi hợp lệ',
          '--session-cookie',
          `__Host-techpulse_session=${encodeURIComponent(SESSION_TOKEN)}; Path=/`,
          '--csrf-token',
          CSRF_TOKEN,
        ]),
      }),
    ).toEqual({
      mode: 'session',
      cookie: `__Host-techpulse_session=${SESSION_TOKEN}`,
      csrfToken: CSRF_TOKEN,
    })
    expect(() =>
      resolveQaCliAuth({
        options: parseQaCliArgs(['--question', 'Câu hỏi hợp lệ', '--session-token', SESSION_TOKEN]),
      }),
    ).toThrow(/csrf token is invalid/i)
    expect(() =>
      resolveQaCliAuth({
        options: parseQaCliArgs(['--question', 'Câu hỏi hợp lệ', '--email', 'user@example.com']),
      }),
    ).toThrow(/both email and password/i)
  })

  it('returns refused answers unchanged and leaves malformed idempotency keys to the web route', async () => {
    const refused = {
      data: {
        ...ANSWER.data,
        id: 'answer-refused',
        status: 'refused',
        paragraphs: [],
        citations: [],
        refusalReason: 'insufficient-evidence',
      },
    }
    const fetchImpl = vi.fn(async () => jsonResponse(refused))
    const result = await runQaCli({
      options: parseQaCliArgs([
        '--question',
        'Câu hỏi hợp lệ',
        '--topic',
        'AI',
        '--idempotency-key',
        'bad',
      ]),
      environment: { QA_SESSION_TOKEN: SESSION_TOKEN, QA_CSRF_TOKEN: CSRF_TOKEN },
      fetchImpl,
    })
    expect(result).toMatchObject({ ok: true, status: 200, body: refused })
    const [, init] = fetchImpl.mock.calls[0]
    expect(init.headers['Idempotency-Key']).toBe('bad')
  })

  it('maps transport and malformed login failures to safe machine-readable errors', async () => {
    await expect(
      runQaCli({
        options: parseQaCliArgs(['--question', 'Câu hỏi hợp lệ', '--topic', 'AI']),
        environment: { QA_SESSION_TOKEN: SESSION_TOKEN, QA_CSRF_TOKEN: CSRF_TOKEN },
        fetchImpl: vi.fn(async () => {
          throw new Error('network detail')
        }),
      }),
    ).rejects.toMatchObject({ status: 503, code: 'service_unavailable' })

    const loginFailure = await runQaCli({
      options: parseQaCliArgs([
        '--question',
        'Câu hỏi hợp lệ',
        '--topic',
        'AI',
        '--email',
        'user@example.com',
        '--password',
        'secret',
      ]),
      fetchImpl: vi.fn(async () =>
        jsonResponse(
          {
            error: {
              code: 'unauthorized',
              message: 'Email or password is invalid',
              requestId: 'req-login',
            },
          },
          401,
        ),
      ),
    })
    expect(loginFailure).toEqual({
      ok: false,
      status: 401,
      stage: 'login',
      body: {
        error: {
          code: 'unauthorized',
          message: 'Email or password is invalid',
          requestId: 'req-login',
        },
      },
    })

    const missingCookie = vi.fn(async () =>
      jsonResponse({ data: { user: { id: 'user-1' }, csrfToken: LOGIN_CSRF_TOKEN } }),
    )
    await expect(
      runQaCli({
        options: parseQaCliArgs([
          '--question',
          'Câu hỏi hợp lệ',
          '--topic',
          'AI',
          '--email',
          'user@example.com',
          '--password',
          'secret',
        ]),
        fetchImpl: missingCookie,
      }),
    ).rejects.toMatchObject({ status: 502, code: 'internal_error' })
    expect(missingCookie).toHaveBeenCalledTimes(1)
  })

  it('rejects an invalid base URL and reports CLI validation failures without exposing option values', async () => {
    await expect(
      runQaCli({
        options: parseQaCliArgs([
          '--question',
          'Câu hỏi hợp lệ',
          '--topic',
          'AI',
          '--base-url',
          'https://example.com',
        ]),
        environment: { QA_SESSION_TOKEN: SESSION_TOKEN, QA_CSRF_TOKEN: CSRF_TOKEN },
        fetchImpl: vi.fn(),
      }),
    ).rejects.toMatchObject({ status: 400, code: 'bad_request' })
    await expect(
      runQaCli({
        options: parseQaCliArgs([
          '--question',
          'Câu hỏi hợp lệ',
          '--topic',
          'AI',
          '--base-url',
          'https://user:password@example.com',
        ]),
        environment: { QA_SESSION_TOKEN: SESSION_TOKEN, QA_CSRF_TOKEN: CSRF_TOKEN },
        fetchImpl: vi.fn(),
      }),
    ).rejects.toMatchObject({ status: 400, code: 'bad_request' })

    const errorLog = vi.fn()
    const result = await main(
      [
        '--question',
        'x',
        '--topic',
        'AI',
        '--session-token',
        SESSION_TOKEN,
        '--csrf-token',
        CSRF_TOKEN,
      ],
      { errorLog },
    )
    expect(result).toMatchObject({
      ok: false,
      status: 422,
      body: { error: { code: 'validation_error' } },
    })
    expect(JSON.stringify(errorLog.mock.calls)).not.toContain(SESSION_TOKEN)
    process.exitCode = undefined
  })

  it('returns help through the runner without attempting authentication or HTTP', async () => {
    const fetchImpl = vi.fn()
    await expect(runQaCli({ options: { help: true }, fetchImpl })).resolves.toEqual({
      ok: true,
      help: true,
    })
    expect(fetchImpl).not.toHaveBeenCalled()
  })
  it('prints help without contacting the endpoint', async () => {
    const log = vi.fn()
    const errorLog = vi.fn()
    const result = await main(['--help'], { fetchImpl: vi.fn(), log, errorLog })
    expect(result).toEqual({ ok: true, help: true })
    expect(log).toHaveBeenCalledWith(QA_CLI_USAGE)
    expect(errorLog).not.toHaveBeenCalled()
  })

  it('prints HTTP errors to stderr while keeping the web error envelope unchanged', async () => {
    const errorLog = vi.fn()
    const result = await main(['--question', 'Câu hỏi hợp lệ', '--topic', 'AI'], {
      environment: { QA_SESSION_TOKEN: SESSION_TOKEN, QA_CSRF_TOKEN: CSRF_TOKEN },
      fetchImpl: vi.fn(async () =>
        jsonResponse(
          { error: { code: 'service_unavailable', message: 'Try later', requestId: 'req-503' } },
          503,
        ),
      ),
      errorLog,
    })
    expect(result).toMatchObject({ ok: false, status: 503, stage: 'answer' })
    expect(errorLog).toHaveBeenCalledWith(JSON.stringify(result.body))
    process.exitCode = undefined
  })

  it('redacts unexpected local exceptions to a stable internal error envelope', async () => {
    const errorLog = vi.fn()
    const secret = 'not-for-output'
    const result = await main(
      [
        '--question',
        'Câu hỏi hợp lệ',
        '--topic',
        'AI',
        '--email',
        'user@example.com',
        '--password',
        secret,
      ],
      {
        fetchImpl: vi.fn(async () => ({ ok: true, status: 200 })),
        errorLog,
      },
    )
    expect(result).toMatchObject({
      ok: false,
      status: 502,
      body: { error: { code: 'internal_error' } },
    })
    expect(JSON.stringify(errorLog.mock.calls)).not.toContain(secret)
    process.exitCode = undefined
  })
})
