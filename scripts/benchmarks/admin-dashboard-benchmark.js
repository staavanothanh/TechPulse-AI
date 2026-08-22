import { performance } from 'node:perf_hooks'
import { pathToFileURL } from 'node:url'
import { MongoClient } from 'mongodb'

const SESSION_COOKIE_NAME = '__Host-techpulse_session'
const DEFAULT_ITERATIONS = 30
const DEFAULT_COLD_ITERATIONS = 1
const DEFAULT_TIMEOUT_MS = 10_000
const MAX_ITERATIONS = 1_000
const MAX_COLD_ITERATIONS = 100
const MAX_TIMEOUT_MS = 120_000
const MAX_RESPONSE_BYTES = 8 * 1024 * 1024
const MAX_PROTECTION_HEADERS = 20
const ALLOWED_PROTECTION_HEADERS = new Set([
  'authorization',
  'x-vercel-protection-bypass',
  'x-vercel-set-bypass-cookie',
])
const FORBIDDEN_PROTECTION_HEADERS = new Set([
  'cookie',
  'content-length',
  'host',
  'origin',
  'referer',
  'set-cookie',
])

export const ADMIN_DASHBOARD_ENDPOINTS = Object.freeze([
  Object.freeze({ id: 'overview', path: '/api/v1/admin/overview', expectedStatus: 200 }),
  Object.freeze({ id: 'jobs-ingestion', path: '/api/v1/admin/ingestion-jobs', expectedStatus: 200 }),
  Object.freeze({ id: 'jobs-indexing', path: '/api/v1/admin/indexing-jobs', expectedStatus: 200 }),
  Object.freeze({ id: 'jobs-sources', path: '/api/v1/admin/sources', expectedStatus: 200 }),
  Object.freeze({ id: 'articles', path: '/api/v1/admin/articles', expectedStatus: 200 }),
  Object.freeze({ id: 'audit', path: '/api/v1/admin/audit-logs', expectedStatus: 200 }),
])

const WATERFALL_PHASES = Object.freeze([
  Object.freeze({ id: 'overview', endpointIds: Object.freeze(['overview']) }),
  Object.freeze({ id: 'jobs-ingestion', endpointIds: Object.freeze(['jobs-ingestion', 'jobs-sources']) }),
  Object.freeze({ id: 'jobs-indexing', endpointIds: Object.freeze(['jobs-indexing']) }),
  Object.freeze({ id: 'articles', endpointIds: Object.freeze(['articles']) }),
  Object.freeze({ id: 'audit', endpointIds: Object.freeze(['audit']) }),
])

const MONGO_PLAN_PROBES = Object.freeze([
  Object.freeze({
    id: 'articles',
    collection: 'articles',
    filter: {},
    sort: Object.freeze({ updatedAt: -1, _id: -1 }),
  }),
  Object.freeze({
    id: 'ingestion-jobs',
    collection: 'ingestionJobs',
    filter: {},
    sort: Object.freeze({ createdAt: -1, _id: -1 }),
  }),
  Object.freeze({
    id: 'indexing-jobs',
    collection: 'indexingJobs',
    filter: {},
    sort: Object.freeze({ createdAt: -1, _id: -1 }),
  }),
  Object.freeze({
    id: 'sources',
    collection: 'sources',
    filter: {},
    sort: Object.freeze({ createdAt: -1, _id: -1 }),
  }),
  Object.freeze({
    id: 'audit',
    collection: 'adminAuditLogs',
    filter: {},
    sort: Object.freeze({ createdAt: -1, _id: -1 }),
  }),
])

export class AdminDashboardBenchmarkConfigurationError extends Error {}

function requiredString(value, name) {
  if (typeof value !== 'string' || value.trim() === '')
    throw new AdminDashboardBenchmarkConfigurationError(`${name} is required`)
  return value.trim()
}

function boundedInteger(value, name, { minimum = 1, maximum } = {}) {
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum)
    throw new AdminDashboardBenchmarkConfigurationError(
      `${name} must be an integer from ${minimum} to ${maximum}`,
    )
  return parsed
}

function parseTarget(value) {
  if (!['local', 'preview'].includes(value))
    throw new AdminDashboardBenchmarkConfigurationError(
      'ADMIN_BENCHMARK_TARGET must be local or preview',
    )
  return value
}

function parseUrl(value, name) {
  let url
  try {
    url = new URL(requiredString(value, name))
  } catch {
    throw new AdminDashboardBenchmarkConfigurationError(`${name} must be a valid URL`)
  }
  if (!['http:', 'https:'].includes(url.protocol))
    throw new AdminDashboardBenchmarkConfigurationError(`${name} must use HTTP or HTTPS`)
  if (url.username || url.password)
    throw new AdminDashboardBenchmarkConfigurationError(`${name} must not contain credentials`)
  if (url.search || url.hash || url.pathname !== '/')
    throw new AdminDashboardBenchmarkConfigurationError(`${name} must be an origin URL without a path, query, or fragment`)
  return url
}

function sameOrigin(left, right) {
  return left.origin === right.origin
}

function parseProtectionHeaders(raw) {
  if (!raw) return Object.freeze({})
  let parsed
  try {
    parsed = JSON.parse(raw)
  } catch {
    throw new AdminDashboardBenchmarkConfigurationError(
      'ADMIN_BENCHMARK_PROTECTION_HEADERS_JSON must be a JSON object',
    )
  }
  if (!parsed || Array.isArray(parsed) || typeof parsed !== 'object')
    throw new AdminDashboardBenchmarkConfigurationError(
      'ADMIN_BENCHMARK_PROTECTION_HEADERS_JSON must be a JSON object',
    )
  const entries = Object.entries(parsed)
  if (entries.length > MAX_PROTECTION_HEADERS)
    throw new AdminDashboardBenchmarkConfigurationError(
      `ADMIN_BENCHMARK_PROTECTION_HEADERS_JSON must contain at most ${MAX_PROTECTION_HEADERS} headers`,
    )
  const headers = {}
  for (const [name, value] of entries) {
    const normalized = name.toLowerCase()
    if (!/^[a-z0-9-]+$/i.test(name) || typeof value !== 'string' || value.trim() === '')
      throw new AdminDashboardBenchmarkConfigurationError(
        'ADMIN_BENCHMARK_PROTECTION_HEADERS_JSON contains an invalid header',
      )
    if (FORBIDDEN_PROTECTION_HEADERS.has(normalized))
      throw new AdminDashboardBenchmarkConfigurationError(
        `ADMIN_BENCHMARK_PROTECTION_HEADERS_JSON must not set ${name}`,
      )
    if (!ALLOWED_PROTECTION_HEADERS.has(normalized))
      throw new AdminDashboardBenchmarkConfigurationError(
        `ADMIN_BENCHMARK_PROTECTION_HEADERS_JSON does not allow ${name}`,
      )
    headers[name] = value
  }
  return Object.freeze(headers)
}

function redactHeaderNames(headers) {
  return Object.freeze(Object.keys(headers).map((header) => header.toLowerCase()).sort())
}

function redactPath(path) {
  const parsed = new URL(path, 'http://admin-benchmark.invalid')
  return parsed.pathname
}

function responseCookie(response) {
  const values = typeof response?.headers?.getSetCookie === 'function'
    ? response.headers.getSetCookie()
    : [response?.headers?.get?.('set-cookie')]
  for (const value of values) {
    if (typeof value !== 'string') continue
    const pair = value.split(';', 1)[0]
    if (pair.startsWith(`${SESSION_COOKIE_NAME}=`) && !pair.endsWith('=')) return pair
  }
  return null
}

function headersForRequest({ protectionHeaders, cookie, mode }) {
  const headers = new globalThis.Headers({ Accept: 'application/json', ...protectionHeaders })
  headers.set('Cache-Control', 'no-cache')
  if (cookie) headers.set('Cookie', cookie)
  if (mode === 'cold') headers.set('Connection', 'close')
  return headers
}

async function responseBytes(response) {
  if (response?.body && typeof response.body.getReader === 'function') {
    const reader = response.body.getReader()
    let bytes = 0
    try {
      while (true) {
        const chunk = await reader.read()
        if (chunk.done) return { bytes, responseTooLarge: false }
        bytes += Number.isSafeInteger(chunk.value?.byteLength) ? chunk.value.byteLength : 0
        if (bytes > MAX_RESPONSE_BYTES) {
          try { await reader.cancel() } catch { /* The stream already exceeded the limit. */ }
          return { bytes: MAX_RESPONSE_BYTES, responseTooLarge: true }
        }
      }
    } finally {
      reader.releaseLock?.()
    }
  }
  if (typeof response?.arrayBuffer !== 'function') return { bytes: 0, responseTooLarge: true }
  const body = await response.arrayBuffer()
  const bytes = Number.isSafeInteger(body?.byteLength) ? body.byteLength : 0
  return { bytes: Math.min(bytes, MAX_RESPONSE_BYTES), responseTooLarge: bytes > MAX_RESPONSE_BYTES }
}

async function measuredRequest({ url, expectedStatus, mode, configuration, cookie, fetchImpl }) {
  const controller = new globalThis.AbortController()
  const startedAt = performance.now()
  const timeout = setTimeout(() => controller.abort(), configuration.timeoutMs)
  try {
    const response = await fetchImpl(url, {
      method: 'GET',
      headers: headersForRequest({ protectionHeaders: configuration.protectionHeaders, cookie, mode }),
      redirect: 'manual',
      signal: controller.signal,
    })
    const body = await responseBytes(response)
    const status = Number.isInteger(response?.status) ? response.status : null
    return {
      durationMs: performance.now() - startedAt,
      status,
      bytes: body.bytes,
      expectedStatus,
      ok: status === expectedStatus && !body.responseTooLarge,
      timedOut: false,
      failed: status !== expectedStatus || body.responseTooLarge,
      responseTooLarge: body.responseTooLarge,
    }
  } catch (error) {
    return {
      durationMs: performance.now() - startedAt,
      status: null,
      bytes: 0,
      expectedStatus,
      ok: false,
      timedOut: controller.signal.aborted || error?.name === 'AbortError',
      failed: true,
      responseTooLarge: false,
    }
  } finally {
    globalThis.clearTimeout(timeout)
  }
}

function percentile(values, percentage) {
  if (values.length === 0) return null
  return values[Math.max(1, Math.ceil((percentage / 100) * values.length)) - 1]
}

export function summarizeAdminDashboardSamples(samples = []) {
  const durations = samples.map(({ durationMs }) => durationMs).sort((left, right) => left - right)
  const statusCounts = {}
  for (const sample of samples) {
    const key = sample.status === null ? 'error' : String(sample.status)
    statusCounts[key] = (statusCounts[key] ?? 0) + 1
  }
  return {
    requests: samples.length,
    p50Ms: percentile(durations, 50),
    p95Ms: percentile(durations, 95),
    minMs: durations.at(0) ?? null,
    maxMs: durations.at(-1) ?? null,
    statusCounts,
    passed: samples.every(({ ok }) => ok),
    timeouts: samples.filter(({ timedOut }) => timedOut).length,
    errors: samples.filter(({ failed, timedOut }) => failed && !timedOut).length,
    responseTooLarge: samples.filter(({ responseTooLarge }) => responseTooLarge).length,
    bytes: samples.reduce((total, sample) => total + sample.bytes, 0),
  }
}

async function login({ configuration, fetchImpl }) {
  const controller = new globalThis.AbortController()
  const startedAt = performance.now()
  const timeout = setTimeout(() => controller.abort(), configuration.timeoutMs)
  try {
    const headers = new globalThis.Headers({
      Accept: 'application/json',
      'Content-Type': 'application/json',
      Origin: configuration.origin,
      ...configuration.protectionHeaders,
    })
    const response = await fetchImpl(new URL('/api/v1/auth/login', configuration.baseUrl), {
      method: 'POST',
      headers,
      body: JSON.stringify({ email: configuration.email, password: configuration.password }),
      redirect: 'manual',
      signal: controller.signal,
    })
    const body = await responseBytes(response)
    const cookie = responseCookie(response)
    const status = Number.isInteger(response?.status) ? response.status : null
    if (status !== 200 || !cookie || body.responseTooLarge)
      throw new Error('Admin benchmark login did not return an active session')
    return { cookie, status, durationMs: performance.now() - startedAt, bytes: body.bytes }
  } catch {
    throw new Error('Admin benchmark authentication failed without exposing login details')
  } finally {
    globalThis.clearTimeout(timeout)
  }
}

function endpointUrl(configuration, endpoint) {
  return new URL(endpoint.path, configuration.baseUrl)
}

async function runEndpoint({ configuration, endpoint, cookie, fetchImpl }) {
  const coldSamples = []
  for (let index = 0; index < configuration.coldIterations; index += 1) {
    coldSamples.push(
      await measuredRequest({
        url: endpointUrl(configuration, endpoint),
        expectedStatus: endpoint.expectedStatus,
        mode: 'cold',
        configuration,
        cookie,
        fetchImpl,
      }),
    )
  }
  const warmSamples = []
  for (let index = 0; index < configuration.iterations; index += 1) {
    warmSamples.push(
      await measuredRequest({
        url: endpointUrl(configuration, endpoint),
        expectedStatus: endpoint.expectedStatus,
        mode: 'warm',
        configuration,
        cookie,
        fetchImpl,
      }),
    )
  }
  return Object.freeze({ id: endpoint.id, path: redactPath(endpoint.path), cold: summarizeAdminDashboardSamples(coldSamples), warm: summarizeAdminDashboardSamples(warmSamples) })
}

async function runWaterfall({ configuration, cookie, fetchImpl }) {
  const byId = new Map(ADMIN_DASHBOARD_ENDPOINTS.map((endpoint) => [endpoint.id, endpoint]))
  const phases = []
  let offsetMs = 0
  for (const phase of WATERFALL_PHASES) {
    const requests = []
    const phaseStartedAt = performance.now()
    await Promise.all(
      phase.endpointIds.map(async (endpointId) => {
        const endpoint = byId.get(endpointId)
        const startedAt = performance.now()
        const sample = await measuredRequest({
          url: endpointUrl(configuration, endpoint),
          expectedStatus: endpoint.expectedStatus,
          mode: 'warm',
          configuration,
          cookie,
          fetchImpl,
        })
        requests.push({
          id: endpoint.id,
          path: redactPath(endpoint.path),
          startOffsetMs: startedAt - phaseStartedAt + offsetMs,
          durationMs: sample.durationMs,
          status: sample.status,
          passed: sample.ok,
        })
      }),
    )
    requests.sort((left, right) => left.id.localeCompare(right.id))
    const durationMs = performance.now() - phaseStartedAt
    phases.push({
      id: phase.id,
      requestCount: requests.length,
      durationMs,
      passed: requests.every(({ passed }) => passed),
      requests,
    })
    offsetMs += durationMs
  }
  return {
    semantics: 'The waterfall is the expected API request sequence after authenticated admin navigation. It measures API timing only; it does not assert browser rendering or a serverless cold start.',
    phases,
    totalRequestCount: phases.reduce((total, phase) => total + phase.requestCount, 0),
    passed: phases.every(({ passed }) => passed),
  }
}

export function parseAdminDashboardBenchmarkEnvironment(environment = process.env) {
  if (environment.ADMIN_BENCHMARK_ENABLED !== 'true')
    throw new AdminDashboardBenchmarkConfigurationError(
      'Admin dashboard benchmark is disabled. Set ADMIN_BENCHMARK_ENABLED=true to run it.',
    )
  const target = parseTarget(requiredString(environment.ADMIN_BENCHMARK_TARGET, 'ADMIN_BENCHMARK_TARGET'))
  const baseUrl = parseUrl(environment.ADMIN_BENCHMARK_BASE_URL, 'ADMIN_BENCHMARK_BASE_URL')
  const origin = parseUrl(environment.ADMIN_BENCHMARK_ORIGIN ?? baseUrl.origin, 'ADMIN_BENCHMARK_ORIGIN')
  if (!sameOrigin(baseUrl, origin))
    throw new AdminDashboardBenchmarkConfigurationError(
      'ADMIN_BENCHMARK_ORIGIN must match ADMIN_BENCHMARK_BASE_URL',
    )
  if (target === 'local' && (baseUrl.protocol !== 'http:' || baseUrl.hostname !== 'localhost'))
    throw new AdminDashboardBenchmarkConfigurationError(
      'Local admin benchmark requires ADMIN_BENCHMARK_BASE_URL=http://localhost[:port]',
    )
  if (target === 'preview' && baseUrl.protocol !== 'https:')
    throw new AdminDashboardBenchmarkConfigurationError(
      'Preview admin benchmark requires an HTTPS ADMIN_BENCHMARK_BASE_URL',
    )
  return Object.freeze({
    target,
    baseUrl: baseUrl.origin,
    origin: origin.origin,
    email: requiredString(environment.ADMIN_BENCHMARK_EMAIL, 'ADMIN_BENCHMARK_EMAIL'),
    password: requiredString(environment.ADMIN_BENCHMARK_PASSWORD, 'ADMIN_BENCHMARK_PASSWORD'),
    iterations: boundedInteger(environment.ADMIN_BENCHMARK_ITERATIONS ?? DEFAULT_ITERATIONS, 'ADMIN_BENCHMARK_ITERATIONS', { maximum: MAX_ITERATIONS }),
    coldIterations: boundedInteger(environment.ADMIN_BENCHMARK_COLD_ITERATIONS ?? DEFAULT_COLD_ITERATIONS, 'ADMIN_BENCHMARK_COLD_ITERATIONS', { maximum: MAX_COLD_ITERATIONS }),
    timeoutMs: boundedInteger(environment.ADMIN_BENCHMARK_TIMEOUT_MS ?? DEFAULT_TIMEOUT_MS, 'ADMIN_BENCHMARK_TIMEOUT_MS', { maximum: MAX_TIMEOUT_MS }),
    protectionHeaders: parseProtectionHeaders(environment.ADMIN_BENCHMARK_PROTECTION_HEADERS_JSON),
  })
}

export async function runAdminDashboardBenchmark({ configuration, fetchImpl = globalThis.fetch } = {}) {
  if (!configuration || typeof fetchImpl !== 'function') throw new Error('Admin dashboard benchmark configuration and fetch are required')
  const authenticated = await login({ configuration, fetchImpl })
  const endpoints = []
  for (const endpoint of ADMIN_DASHBOARD_ENDPOINTS)
    endpoints.push(await runEndpoint({ configuration, endpoint, cookie: authenticated.cookie, fetchImpl }))
  const waterfall = await runWaterfall({ configuration, cookie: authenticated.cookie, fetchImpl })
  return {
    schemaVersion: 1,
    measurement: 'Authenticated admin API latency, response size, and expected dashboard request waterfall',
    coldSemantics: 'cold sends Cache-Control: no-cache and Connection: close. It is a client-side cold probe and cannot prove a fresh Vercel or serverless instance.',
    configuration: {
      target: configuration.target,
      iterations: configuration.iterations,
      coldIterations: configuration.coldIterations,
      timeoutMs: configuration.timeoutMs,
      protectionHeaderNames: redactHeaderNames(configuration.protectionHeaders),
      endpoints: ADMIN_DASHBOARD_ENDPOINTS.map(({ id }) => id),
    },
    authentication: { status: authenticated.status, durationMs: authenticated.durationMs, bytes: authenticated.bytes },
    endpoints,
    waterfall,
    passed: endpoints.every(({ cold, warm }) => cold.passed && warm.passed) && waterfall.passed,
  }
}

function stagesFromPlan(plan) {
  const stages = new Set()
  const visit = (value) => {
    if (!value || typeof value !== 'object') return
    if (typeof value.stage === 'string') stages.add(value.stage)
    for (const child of Object.values(value)) visit(child)
  }
  visit(plan?.queryPlanner?.winningPlan)
  visit(plan?.executionStats?.executionStages)
  return [...stages].sort()
}

function assertMongoEnvironment(environment) {
  const uriEnvironmentName = requiredString(environment.MONGODB_URI_ENV, 'MONGODB_URI_ENV')
  if (!/^[A-Z][A-Z0-9_]{1,127}$/.test(uriEnvironmentName))
    throw new AdminDashboardBenchmarkConfigurationError('MONGODB_URI_ENV is invalid')
  const uri = requiredString(environment[uriEnvironmentName], 'Referenced MongoDB URI')
  const database = requiredString(environment.MONGODB_DATABASE, 'MONGODB_DATABASE')
  if (!/^[A-Za-z0-9_-]{1,63}$/.test(database))
    throw new AdminDashboardBenchmarkConfigurationError('MONGODB_DATABASE is invalid')
  return { uri, database }
}

export async function explainAdminDashboardMongoPlans({ environment = process.env, createMongoClient = (uri) => new MongoClient(uri) } = {}) {
  const { uri, database } = assertMongoEnvironment(environment)
  const client = createMongoClient(uri)
  try {
    await client.connect()
    const db = client.db(database)
    const plans = []
    for (const probe of MONGO_PLAN_PROBES) {
      const explain = await db.collection(probe.collection).find(probe.filter).sort(probe.sort).limit(21).explain('executionStats')
      const stages = stagesFromPlan(explain)
      plans.push({
        id: probe.id,
        collection: probe.collection,
        filter: 'unfiltered-list',
        sort: probe.sort,
        stages,
        executionTimeMillis: Number.isFinite(explain?.executionStats?.executionTimeMillis) ? explain.executionStats.executionTimeMillis : null,
        totalKeysExamined: Number.isFinite(explain?.executionStats?.totalKeysExamined) ? explain.executionStats.totalKeysExamined : null,
        totalDocsExamined: Number.isFinite(explain?.executionStats?.totalDocsExamined) ? explain.executionStats.totalDocsExamined : null,
        nReturned: Number.isFinite(explain?.executionStats?.nReturned) ? explain.executionStats.nReturned : null,
        requiresAttention: stages.includes('COLLSCAN') || stages.includes('SORT'),
      })
    }
    return { schemaVersion: 1, measurement: 'MongoDB executionStats explain for admin list reads', status: 'ok', plans }
  } catch {
    return { schemaVersion: 1, measurement: 'MongoDB executionStats explain for admin list reads', status: 'unavailable', plans: [] }
  } finally {
    try { await client?.close?.() } catch { /* Close failure must not disclose connection details. */ }
  }
}

export const CLI_USAGE = `Usage:
  node scripts/benchmarks/admin-dashboard-benchmark.js [--with-mongo-explain]

Required environment:
  ADMIN_BENCHMARK_ENABLED=true
  ADMIN_BENCHMARK_TARGET=local|preview
  ADMIN_BENCHMARK_BASE_URL=http://localhost:3000|https://preview.example.test
  ADMIN_BENCHMARK_ORIGIN=<same origin>
  ADMIN_BENCHMARK_EMAIL=<dedicated admin account>
  ADMIN_BENCHMARK_PASSWORD=<dedicated admin password>

Optional environment:
  ADMIN_BENCHMARK_ITERATIONS=30
  ADMIN_BENCHMARK_COLD_ITERATIONS=1
  ADMIN_BENCHMARK_TIMEOUT_MS=10000
  ADMIN_BENCHMARK_PROTECTION_HEADERS_JSON=<allowlisted Preview protection headers>

--with-mongo-explain requires MONGODB_URI_ENV, its referenced URI environment variable,
and MONGODB_DATABASE. It runs read-only executionStats explain probes. The command does
not load .env files and does not report URLs, credentials, cookies, headers, or response bodies.`

function isMainModule() {
  return process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href
}

if (isMainModule()) {
  try {
    const argumentsList = process.argv.slice(2)
    if (argumentsList.includes('--help') || argumentsList.includes('-h')) console.log(CLI_USAGE)
    else if (argumentsList.some((argument) => argument !== '--with-mongo-explain'))
      throw new AdminDashboardBenchmarkConfigurationError(`Unknown option: ${argumentsList.find((argument) => argument !== '--with-mongo-explain')}`)
    else {
      const configuration = parseAdminDashboardBenchmarkEnvironment()
      const report = await runAdminDashboardBenchmark({ configuration })
      if (argumentsList.includes('--with-mongo-explain')) report.mongoExplain = await explainAdminDashboardMongoPlans()
      console.log(JSON.stringify(report, null, 2))
      if (!report.passed || report.mongoExplain?.plans?.some(({ requiresAttention }) => requiresAttention)) process.exitCode = 1
    }
  } catch (error) {
    console.error(
      `Admin dashboard benchmark failed: ${error instanceof AdminDashboardBenchmarkConfigurationError ? error.message : 'request execution failed'}`,
    )
    process.exitCode = 1
  }
}
