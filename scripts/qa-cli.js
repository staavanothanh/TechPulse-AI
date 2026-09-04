import { randomUUID as generateRandomUUID } from 'node:crypto'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { normalizeAnswerBody } from '../client/features/qa/qa-api.js'
import { validateQuestionScope } from '../client/features/qa/qa-validation.js'
import { COOKIE_NAME, parseSessionCookie } from '../server/http/cookies.js'

const DEFAULT_BASE_URL = 'http://localhost:3000'
const REPOSITORY_ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)))
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '::1'])
const DEFAULT_TIMEOUT_MS = 120_000
const MIN_TIMEOUT_MS = 100
const MAX_TIMEOUT_MS = 300_000
const CSRF_MIN_LENGTH = 32
const CSRF_MAX_LENGTH = 256
const MAX_RESPONSE_BYTES = 4 * 1024 * 1024
const RESPONSE_TOO_LARGE_CODE = 'response_too_large'

const OPTION_NAMES = new Set([
  '--question',
  '--article-id',
  '--topic',
  '--topics',
  '--published-after',
  '--published-before',
  '--chat-session-id',
  '--idempotency-key',
  '--timeout-ms',
  '--base-url',
  '--session-token',
  '--session-cookie',
  '--csrf-token',
  '--email',
  '--password',
])

export const QA_CLI_USAGE = `Usage:
  node --env-file-if-exists=.env scripts/qa-cli.js --question=<question> (--article-id=<24-hex-id> | --topic=<topic>... | --published-after=<ISO> --published-before=<ISO>) [options]
  Run from the repository root so the checked-in API contract is loaded consistently.

Required authentication (choose one; environment values take precedence over flags):
  QA_SESSION_TOKEN + QA_CSRF_TOKEN (or --session-token + --csrf-token)
  QA_SESSION_COOKIE + QA_CSRF_TOKEN (or --session-cookie + --csrf-token)
  QA_EMAIL + QA_PASSWORD (or --email + --password)
  Prefer environment variables: command-line arguments can be visible in process listings; flags are never logged.

Options:
  --timeout-ms=<100..300000>        Abort each HTTP request after this bound (default: 120000; QA_TIMEOUT_MS also supported)
  --article-id=<24-hex-id>          Restrict retrieval to one article
  --topic=<topic>                   Restrict retrieval to a topic; may be repeated
  --topics=<topic,topic>            Provide comma-separated topics
  --published-after=<ISO>           Inclusive time-range start
  --published-before=<ISO>          Inclusive time-range end
  --chat-session-id=<24-hex-id>     Continue an existing chat session
  --idempotency-key=<key>           Reuse a request key for safe replay
  --base-url=<origin>               Loopback API origin only (default: http://localhost:3000; QA_BASE_URL also supported)
  --session-token=<token>           Existing session token (prefer QA_SESSION_TOKEN)
  --session-cookie=<cookie>         Existing Cookie header (prefer QA_SESSION_COOKIE)
  --csrf-token=<token>              Existing CSRF token (prefer QA_CSRF_TOKEN)
  --email=<email>                   Login email (prefer QA_EMAIL)
  --password=<password>             Login password (prefer QA_PASSWORD)
  -h, --help                        Show this help

Output:
  Success and HTTP errors are emitted as one JSON object. Success mirrors the web API {"data": ...} envelope.
  Credentials, session cookies, prompts, and provider payloads are never printed.`

export class QaCliError extends Error {
  constructor(status, code, message, details) {
    super(message)
    this.name = 'QaCliError'
    this.status = status
    this.code = code
    this.details = details
  }
}
function assertRepositoryRoot() {
  if (path.resolve(process.cwd()) !== REPOSITORY_ROOT)
    throw new QaCliError(400, 'bad_request', 'Run the Q&A CLI from the repository root')
}

function valueFromEnvironment(environment, name, { trim = false } = {}) {
  const value = environment?.[name]
  if (typeof value !== 'string' || value.length === 0) return undefined
  return trim ? value.trim() : value
}

function argumentValue(argv, index, argument, option) {
  const prefix = `${option}=`
  if (argument.startsWith(prefix)) {
    const value = argument.slice(prefix.length)
    if (value.length === 0) throw new QaCliError(400, 'bad_request', `${option} requires a value`)
    return { value, nextIndex: index }
  }
  if (argument !== option) return undefined
  const value = argv[index + 1]
  if (value === undefined || value.startsWith('--'))
    throw new QaCliError(400, 'bad_request', `${option} requires a value`)
  return { value, nextIndex: index + 1 }
}

function setOnce(options, field, value, option) {
  if (options[field] !== undefined)
    throw new QaCliError(400, 'bad_request', `${option} is duplicated`)
  return { ...options, [field]: value }
}

function topicValues(value, option) {
  const values = value.split(',').map((topic) => topic.trim())
  if (values.length === 0 || values.some((topic) => topic.length === 0))
    throw new QaCliError(400, 'bad_request', `${option} contains an empty topic`)
  return values
}
function boundedTimeout(value) {
  const timeoutMs = Number(value)
  if (
    !Number.isSafeInteger(timeoutMs) ||
    timeoutMs < MIN_TIMEOUT_MS ||
    timeoutMs > MAX_TIMEOUT_MS
  ) {
    throw new QaCliError(
      400,
      'bad_request',
      `--timeout-ms must be an integer between ${MIN_TIMEOUT_MS} and ${MAX_TIMEOUT_MS}`,
    )
  }
  return timeoutMs
}

export function parseQaCliArgs(argv = []) {
  if (!Array.isArray(argv)) throw new QaCliError(400, 'bad_request', 'arguments must be an array')
  let options = {
    help: false,
    question: undefined,
    articleId: undefined,
    topics: [],
    publishedAfter: undefined,
    publishedBefore: undefined,
    chatSessionId: undefined,
    idempotencyKey: undefined,
    baseUrl: undefined,
    timeoutMs: undefined,
    sessionToken: undefined,
    sessionCookie: undefined,
    csrfToken: undefined,
    email: undefined,
    password: undefined,
  }
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]
    if (argument === '--help' || argument === '-h') return Object.freeze({ help: true })
    if (typeof argument !== 'string')
      throw new QaCliError(400, 'bad_request', 'arguments are invalid')
    const option = argument.split('=', 1)[0]
    if (!OPTION_NAMES.has(option)) throw new QaCliError(400, 'bad_request', 'unknown argument')
    if (option === '--topic' || option === '--topics') {
      const selected = argumentValue(argv, index, argument, option)
      options = { ...options, topics: [...options.topics, ...topicValues(selected.value, option)] }
      index = selected.nextIndex
      continue
    }

    const field = {
      '--question': 'question',
      '--article-id': 'articleId',
      '--published-after': 'publishedAfter',
      '--published-before': 'publishedBefore',
      '--timeout-ms': 'timeoutMs',
      '--chat-session-id': 'chatSessionId',
      '--idempotency-key': 'idempotencyKey',
      '--base-url': 'baseUrl',
      '--session-token': 'sessionToken',
      '--session-cookie': 'sessionCookie',
      '--csrf-token': 'csrfToken',
      '--email': 'email',
      '--password': 'password',
    }[option]
    const selected = argumentValue(argv, index, argument, option)
    const parsedValue = field === 'timeoutMs' ? boundedTimeout(selected.value) : selected.value
    options = setOnce(options, field, parsedValue, option)
    index = selected.nextIndex
  }
  return Object.freeze({ ...options, topics: Object.freeze([...options.topics]) })
}

export function normalizeQaRequest({ question, scope = {}, chatSessionId } = {}) {
  const normalizedScope =
    scope && typeof scope === 'object' && !Array.isArray(scope) ? { ...scope } : scope
  return normalizeAnswerBody({
    question: typeof question === 'string' ? question.trim() : question,
    scope: normalizedScope,
    ...(chatSessionId ? { chatSessionId } : {}),
  })
}

function sessionCookieFromValue(value) {
  const raw = typeof value === 'string' ? value : ''
  const token = parseSessionCookie(raw.includes('=') ? raw : `${COOKIE_NAME}=${raw}`)
  if (!token) throw new QaCliError(401, 'unauthorized', 'Session credentials are invalid')
  return `${COOKIE_NAME}=${encodeURIComponent(token)}`
}

function assertCsrfToken(value) {
  if (
    typeof value !== 'string' ||
    value.length < CSRF_MIN_LENGTH ||
    value.length > CSRF_MAX_LENGTH
  ) {
    throw new QaCliError(403, 'csrf_invalid', 'CSRF token is invalid')
  }
  return value
}

export function resolveQaCliAuth({ options = {}, environment = process.env } = {}) {
  const sessionCookieValue =
    valueFromEnvironment(environment, 'QA_SESSION_COOKIE') ??
    (typeof options.sessionCookie === 'string' && options.sessionCookie.length > 0
      ? options.sessionCookie
      : undefined)
  const sessionTokenValue =
    sessionCookieValue === undefined
      ? (valueFromEnvironment(environment, 'QA_SESSION_TOKEN') ??
        (typeof options.sessionToken === 'string' && options.sessionToken.length > 0
          ? options.sessionToken
          : undefined))
      : undefined
  const csrfToken =
    valueFromEnvironment(environment, 'QA_CSRF_TOKEN', { trim: true }) ??
    (typeof options.csrfToken === 'string' ? options.csrfToken.trim() : undefined)
  const email =
    valueFromEnvironment(environment, 'QA_EMAIL') ??
    (typeof options.email === 'string' && options.email.length > 0 ? options.email : undefined)
  const password =
    valueFromEnvironment(environment, 'QA_PASSWORD') ??
    (typeof options.password === 'string' && options.password.length > 0
      ? options.password
      : undefined)
  const hasSessionCredential = sessionCookieValue !== undefined || sessionTokenValue !== undefined
  const hasLoginInput = email !== undefined || password !== undefined
  if (hasSessionCredential || (!hasLoginInput && csrfToken !== undefined)) {
    if (!hasSessionCredential)
      throw new QaCliError(
        401,
        'unauthorized',
        'Session authentication requires a session credential and CSRF token',
      )
    return Object.freeze({
      mode: 'session',
      cookie: sessionCookieFromValue(sessionCookieValue ?? sessionTokenValue),
      csrfToken: assertCsrfToken(csrfToken),
    })
  }
  if (hasLoginInput) {
    if (email === undefined || password === undefined)
      throw new QaCliError(
        401,
        'unauthorized',
        'Login authentication requires both email and password',
      )
    return Object.freeze({ mode: 'login', email, password })
  }
  throw new QaCliError(
    401,
    'unauthorized',
    'Authentication is required; provide session credentials or login credentials',
  )
}

function answerScope(options) {
  return {
    ...(options.articleId !== undefined ? { articleId: options.articleId } : {}),
    ...(options.topics.length > 0 ? { topics: [...options.topics] } : {}),
    ...(options.publishedAfter !== undefined ? { publishedAfter: options.publishedAfter } : {}),
    ...(options.publishedBefore !== undefined ? { publishedBefore: options.publishedBefore } : {}),
  }
}

function answerRequest(options) {
  const scope = answerScope(options)
  const validation = validateQuestionScope(options.question, scope)
  if (!validation.valid) {
    throw new QaCliError(422, 'validation_error', validation.message, [
      {
        field: validation.firstInvalid,
        message: validation.message,
        code: 'invalid_cli_input',
      },
    ])
  }
  return normalizeQaRequest({
    question: options.question,
    scope,
    chatSessionId: options.chatSessionId,
  })
}

function baseOrigin(value) {
  let parsed
  try {
    parsed = new URL(value)
  } catch {
    throw new QaCliError(400, 'bad_request', 'Base URL must be a valid HTTP(S) origin')
  }
  if (
    !['http:', 'https:'].includes(parsed.protocol) ||
    parsed.username ||
    parsed.password ||
    (parsed.pathname !== '' && parsed.pathname !== '/') ||
    parsed.search ||
    parsed.hash
  ) {
    throw new QaCliError(
      400,
      'bad_request',
      'Base URL must be an HTTP(S) origin without credentials or a path',
    )
  }
  const hostname = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, '')
  if (!LOOPBACK_HOSTS.has(hostname))
    throw new QaCliError(400, 'bad_request', 'Base URL must target a loopback host')
  return parsed.origin
}

function responseTooLargeError() {
  return Object.assign(new Error('response body is too large'), { code: RESPONSE_TOO_LARGE_CODE })
}

async function responseText(response) {
  const declaredValue = response?.headers?.get?.('Content-Length')
  const declaredLength = Number(declaredValue)
  if (
    declaredValue !== null &&
    declaredValue !== undefined &&
    !Number.isNaN(declaredLength) &&
    declaredLength > MAX_RESPONSE_BYTES
  )
    throw responseTooLargeError()
  if (response?.body?.getReader) {
    const reader = response.body.getReader()
    const decoder = new globalThis.TextDecoder()
    let text = ''
    let bytes = 0
    try {
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        bytes += value.byteLength
        if (bytes > MAX_RESPONSE_BYTES) {
          try {
            await reader.cancel()
          } catch {
            /* The stream already exceeded the limit. */
          }
          throw responseTooLargeError()
        }
        text += decoder.decode(value, { stream: true })
      }
      return text + decoder.decode()
    } finally {
      reader.releaseLock?.()
    }
  }
  if (typeof response?.text === 'function') {
    const text = await response.text()
    if (new globalThis.TextEncoder().encode(text).byteLength > MAX_RESPONSE_BYTES)
      throw responseTooLargeError()
    return text
  }
  return undefined
}

async function responseBody(response) {
  const text = await responseText(response)
  if (text !== undefined) {
    try {
      return JSON.parse(text)
    } catch (error) {
      if (error?.name === 'AbortError') throw error
      return undefined
    }
  }
  if (typeof response?.json !== 'function') return undefined
  try {
    return await response.json()
  } catch (error) {
    if (error?.name === 'AbortError') throw error
    return undefined
  }
}

function fallbackErrorBody(status) {
  const code =
    status === 401
      ? 'unauthorized'
      : status === 403
        ? 'forbidden'
        : status === 404
          ? 'not_found'
          : status === 409
            ? 'conflict'
            : status === 422
              ? 'validation_error'
              : status === 429
                ? 'rate_limit_exceeded'
                : status >= 500
                  ? 'service_unavailable'
                  : 'bad_request'
  return { error: { code, message: 'Request could not be completed' } }
}
function isPlainObject(value) {
  return (
    value !== null && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype
  )
}

function hasOnlyData(body) {
  return (
    isPlainObject(body) &&
    Object.keys(body).length === 1 &&
    Object.prototype.hasOwnProperty.call(body, 'data')
  )
}

async function validatePublicAnswerEnvelope(body) {
  if (!hasOnlyData(body)) throw new Error('Public AnswerResponse envelope is invalid')
  assertRepositoryRoot()
  const { validatePublicAnswerResponse } = await import('../server/http/answers/router.js')
  validatePublicAnswerResponse(body.data)
  return body
}

function resolveTimeoutMs(options, environment) {
  const value = options.timeoutMs ?? valueFromEnvironment(environment, 'QA_TIMEOUT_MS')
  return value === undefined ? DEFAULT_TIMEOUT_MS : boundedTimeout(value)
}

async function requestJson({ fetchImpl, url, init, stage, timeoutMs }) {
  if (typeof fetchImpl !== 'function')
    throw new QaCliError(503, 'service_unavailable', 'Fetch is unavailable')
  const controller = new globalThis.AbortController()
  let timedOut = false
  let timeoutId
  const timeoutMarker = {}
  const timeoutPromise = new Promise((_, reject) => {
    timeoutId = globalThis.setTimeout(() => {
      timedOut = true
      controller.abort()
      reject(timeoutMarker)
    }, timeoutMs)
  })
  const requestPromise = (async () => {
    const response = await fetchImpl(url, { ...init, signal: controller.signal, redirect: 'error' })
    let parsed
    try {
      parsed = await responseBody(response)
    } catch (error) {
      if (error?.code === RESPONSE_TOO_LARGE_CODE && !response.ok)
        return Object.freeze({
          ok: false,
          status: response.status,
          stage,
          body: fallbackErrorBody(response.status),
        })
      throw error
    }
    const body = parsed && typeof parsed === 'object' ? parsed : fallbackErrorBody(response.status)
    if (!response.ok) return Object.freeze({ ok: false, status: response.status, stage, body })
    return Object.freeze({ ok: true, status: response.status, stage, body, response })
  })()
  try {
    return await Promise.race([requestPromise, timeoutPromise])
  } catch (error) {
    if (timedOut || error === timeoutMarker || error?.name === 'AbortError')
      throw new QaCliError(503, 'service_unavailable', 'Local Q&A request timed out')
    if (error?.code === RESPONSE_TOO_LARGE_CODE)
      throw new QaCliError(502, 'internal_error', 'Local Q&A response exceeded the safe size limit')
    throw new QaCliError(503, 'service_unavailable', 'Local Q&A endpoint is unavailable')
  } finally {
    globalThis.clearTimeout(timeoutId)
  }
}

function setCookieValues(headers) {
  if (typeof headers?.getSetCookie === 'function') {
    try {
      const values = headers.getSetCookie()
      if (Array.isArray(values)) return values
    } catch {
      // Fall through to the portable single-header API.
    }
  }
  const value = headers?.get?.('set-cookie')
  return typeof value === 'string' && value.length > 0 ? [value] : []
}

function sessionCookieFromLogin(response) {
  for (const value of setCookieValues(response.headers)) {
    const token = parseSessionCookie(String(value).split(';', 1)[0])
    if (token) return `${COOKIE_NAME}=${encodeURIComponent(token)}`
  }
  throw new QaCliError(
    502,
    'internal_error',
    'Authentication response did not contain a session cookie',
  )
}

function loginSession(loginResult) {
  const body = loginResult.body
  const data = body?.data
  const csrfToken = data?.csrfToken
  if (
    !hasOnlyData(body) ||
    !isPlainObject(data) ||
    !isPlainObject(data.user) ||
    typeof csrfToken !== 'string' ||
    csrfToken.length < CSRF_MIN_LENGTH ||
    csrfToken.length > CSRF_MAX_LENGTH
  ) {
    throw new QaCliError(
      502,
      'internal_error',
      'Authentication response failed its public contract',
    )
  }
  return Object.freeze({ cookie: sessionCookieFromLogin(loginResult.response), csrfToken })
}

function idempotencyKey(options, environment, randomUuid) {
  const value =
    valueFromEnvironment(environment, 'QA_IDEMPOTENCY_KEY') ??
    options.idempotencyKey ??
    randomUuid()
  if (typeof value !== 'string' || value.length === 0)
    throw new QaCliError(400, 'bad_request', 'Idempotency-Key is invalid')
  return value
}

function answerHeaders({ origin, auth, key }) {
  return {
    Origin: origin,
    Cookie: auth.cookie,
    'X-CSRF-Token': auth.csrfToken,
    'Idempotency-Key': key,
    'Content-Type': 'application/json',
  }
}

export async function runQaCli({
  options,
  environment = process.env,
  fetchImpl = globalThis.fetch,
  randomUuid = generateRandomUUID,
} = {}) {
  if (!options || options.help) return Object.freeze({ ok: true, help: true })
  assertRepositoryRoot()
  const body = answerRequest(options)
  const origin = baseOrigin(
    options.baseUrl ?? valueFromEnvironment(environment, 'QA_BASE_URL') ?? DEFAULT_BASE_URL,
  )
  const timeoutMs = resolveTimeoutMs(options, environment)
  const auth = resolveQaCliAuth({ options, environment })
  const key = idempotencyKey(options, environment, randomUuid)
  let answerAuth = auth
  if (auth.mode === 'login') {
    const loginResult = await requestJson({
      fetchImpl,
      url: `${origin}/api/v1/auth/login`,
      init: {
        method: 'POST',
        headers: { Origin: origin, 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: auth.email, password: auth.password }),
      },
      stage: 'login',
      timeoutMs,
    })
    if (!loginResult.ok) return loginResult
    answerAuth = Object.freeze({ mode: 'session', ...loginSession(loginResult) })
  }

  const result = await requestJson({
    fetchImpl,
    url: `${origin}/api/v1/answers`,
    init: {
      method: 'POST',
      headers: answerHeaders({ origin, auth: answerAuth, key }),
      body: JSON.stringify(body),
    },
    stage: 'answer',
    timeoutMs,
  })
  if (!result.ok) return result
  try {
    await validatePublicAnswerEnvelope(result.body)
  } catch {
    throw new QaCliError(502, 'internal_error', 'Q&A response failed public contract validation')
  }
  return result
}

function errorBody(error) {
  if (error instanceof QaCliError) {
    return {
      error: {
        code: error.code,
        message: error.message,
        ...(error.details !== undefined ? { details: error.details } : {}),
      },
    }
  }
  return { error: { code: 'internal_error', message: 'Local Q&A CLI failed' } }
}

export async function main(
  argv = process.argv.slice(2),
  {
    environment = process.env,
    fetchImpl = globalThis.fetch,
    randomUuid = generateRandomUUID,
    log = console.log,
    errorLog = console.error,
  } = {},
) {
  try {
    const options = parseQaCliArgs(argv)
    if (options.help) {
      log(QA_CLI_USAGE)
      return Object.freeze({ ok: true, help: true })
    }
    const result = await runQaCli({ options, environment, fetchImpl, randomUuid })
    if (result.ok) log(JSON.stringify(result.body))
    else {
      errorLog(JSON.stringify(result.body))
      process.exitCode = 1
    }
    return result
  } catch (error) {
    const body = errorBody(error)
    errorLog(JSON.stringify(body))
    process.exitCode = 1
    return Object.freeze({ ok: false, status: error?.status ?? 1, stage: 'cli', body })
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main()
