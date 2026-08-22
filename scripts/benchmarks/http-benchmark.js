import { performance } from 'node:perf_hooks'
import { pathToFileURL } from 'node:url'

const DEFAULT_BASE_URL = 'http://127.0.0.1:3000'
const DEFAULT_ENDPOINTS = ['/api/v1/health']
const DEFAULT_ITERATIONS = 30
const DEFAULT_COLD_ITERATIONS = 1
const DEFAULT_CONCURRENCY = 4
const DEFAULT_TIMEOUT_MS = 10_000
const DEFAULT_COLD_GAP_MS = 0
const MAX_ITERATIONS = 1_000
const MAX_COLD_ITERATIONS = 100
const MAX_CONCURRENCY = 100
const MAX_ENDPOINTS = 20
const MAX_TIMEOUT_MS = 120_000
const MAX_COLD_GAP_MS = 300_000
const MAX_RESPONSE_BYTES = 8 * 1024 * 1024
const SENSITIVE_PATH_SEGMENT_PATTERN =
  /(?:secret|token|password|passwd|credential|session|api[-_]?key)/i
const OPAQUE_PATH_SEGMENT_PATTERN = /^(?:[0-9a-f]{24,}|[0-9a-f-]{24,}|[A-Za-z0-9_-]{32,})$/i

export const BENCHMARK_MODES = Object.freeze(['all', 'cold', 'warm', 'concurrency'])
export const BENCHMARK_LIMITS = Object.freeze({
  iterations: MAX_ITERATIONS,
  coldIterations: MAX_COLD_ITERATIONS,
  concurrency: MAX_CONCURRENCY,
  endpoints: MAX_ENDPOINTS,
  timeoutMs: MAX_TIMEOUT_MS,
  coldGapMs: MAX_COLD_GAP_MS,
  responseBytes: MAX_RESPONSE_BYTES,
})

export class BenchmarkUsageError extends Error {}
class ResponseTooLargeError extends Error {
  constructor(bytes) {
    super('response body exceeds the benchmark limit')
    this.bytes = bytes
  }
}

function positiveInteger(value, name, { allowZero = false, max = Number.MAX_SAFE_INTEGER } = {}) {
  const parsed = Number(value)
  const minimum = allowZero ? 0 : 1
  if (!Number.isSafeInteger(parsed) || parsed < minimum) {
    throw new BenchmarkUsageError(
      `${name} must be an integer ${allowZero ? 'greater than or equal to 0' : 'greater than 0'}`,
    )
  }
  if (parsed > max) throw new BenchmarkUsageError(`${name} must be less than or equal to ${max}`)
  return parsed
}

function validateBaseUrl(value) {
  let parsed
  try {
    parsed = new URL(value)
  } catch {
    throw new BenchmarkUsageError('--url must be a valid http or https URL')
  }

  if (!['http:', 'https:'].includes(parsed.protocol)) {
    throw new BenchmarkUsageError('--url must use http or https')
  }
  if (parsed.username || parsed.password) {
    throw new BenchmarkUsageError('--url must not contain credentials')
  }
  if (parsed.hash) {
    throw new BenchmarkUsageError('--url must not contain a fragment')
  }
  return parsed
}

function normalizeEndpointPath(value) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new BenchmarkUsageError('--endpoint must be a non-empty path')
  }

  const endpoint = value.trim()
  if (!endpoint.startsWith('/') || endpoint.startsWith('//')) {
    throw new BenchmarkUsageError('--endpoint must be a path that starts with /')
  }

  let parsed
  try {
    parsed = new URL(endpoint, 'http://benchmark.invalid')
  } catch {
    throw new BenchmarkUsageError('--endpoint must be a valid URL path')
  }
  if (parsed.hash) {
    throw new BenchmarkUsageError('--endpoint must not contain a fragment')
  }

  return `${parsed.pathname}${parsed.search}`
}

function validateEndpointCount(endpointPaths) {
  if (!Array.isArray(endpointPaths)) {
    throw new BenchmarkUsageError('endpointPaths must be an array')
  }
  if (endpointPaths.length > MAX_ENDPOINTS) {
    throw new BenchmarkUsageError(`endpoint count must be less than or equal to ${MAX_ENDPOINTS}`)
  }
  return endpointPaths
}

function decodedPathSegment(segment) {
  try {
    return decodeURIComponent(segment)
  } catch {
    return segment
  }
}

function redactPathSegment(segment) {
  const decoded = decodedPathSegment(segment)
  if (SENSITIVE_PATH_SEGMENT_PATTERN.test(decoded) || OPAQUE_PATH_SEGMENT_PATTERN.test(decoded)) {
    return '[redacted]'
  }
  return segment
}

function redactEndpointPath(endpointPath) {
  const parsed = new URL(endpointPath, 'http://benchmark.invalid')
  const pathname = parsed.pathname.split('/').map(redactPathSegment).join('/')
  const keys = [...new Set([...parsed.searchParams.keys()])]
  for (const key of keys) parsed.searchParams.set(key, '[redacted]')
  return `${pathname}${parsed.search}`
}

function parseMode(value) {
  if (!BENCHMARK_MODES.includes(value)) {
    throw new BenchmarkUsageError(`--mode must be one of: ${BENCHMARK_MODES.join(', ')}`)
  }
  return value
}

function readOptionValue(argv, index, name) {
  const value = argv[index + 1]
  if (value === undefined || value.startsWith('--')) {
    throw new BenchmarkUsageError(`${name} requires a value`)
  }
  return value
}

export function parseCliArguments(argv = []) {
  const options = {
    baseUrl: DEFAULT_BASE_URL,
    endpointPaths: [],
    iterations: DEFAULT_ITERATIONS,
    coldIterations: DEFAULT_COLD_ITERATIONS,
    concurrency: DEFAULT_CONCURRENCY,
    timeoutMs: DEFAULT_TIMEOUT_MS,
    coldGapMs: DEFAULT_COLD_GAP_MS,
    mode: 'all',
    explicitUrl: false,
    help: false,
  }

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]
    if (argument === '--help' || argument === '-h') {
      options.help = true
      continue
    }
    if (argument === '--url') {
      const value = readOptionValue(argv, index, '--url')
      options.baseUrl = validateBaseUrl(value).href
      options.explicitUrl = true
      index += 1
      continue
    }
    if (argument === '--endpoint') {
      options.endpointPaths.push(normalizeEndpointPath(readOptionValue(argv, index, '--endpoint')))
      index += 1
      continue
    }
    if (argument === '--iterations') {
      options.iterations = positiveInteger(
        readOptionValue(argv, index, '--iterations'),
        '--iterations',
        { max: MAX_ITERATIONS },
      )
      index += 1
      continue
    }
    if (argument === '--cold-iterations') {
      options.coldIterations = positiveInteger(
        readOptionValue(argv, index, '--cold-iterations'),
        '--cold-iterations',
        { max: MAX_COLD_ITERATIONS },
      )
      index += 1
      continue
    }
    if (argument === '--concurrency') {
      options.concurrency = positiveInteger(
        readOptionValue(argv, index, '--concurrency'),
        '--concurrency',
        { max: MAX_CONCURRENCY },
      )
      index += 1
      continue
    }
    if (argument === '--timeout-ms') {
      options.timeoutMs = positiveInteger(
        readOptionValue(argv, index, '--timeout-ms'),
        '--timeout-ms',
        { max: MAX_TIMEOUT_MS },
      )
      index += 1
      continue
    }
    if (argument === '--cold-gap-ms') {
      options.coldGapMs = positiveInteger(
        readOptionValue(argv, index, '--cold-gap-ms'),
        '--cold-gap-ms',
        { allowZero: true, max: MAX_COLD_GAP_MS },
      )
      index += 1
      continue
    }
    if (argument === '--mode') {
      options.mode = parseMode(readOptionValue(argv, index, '--mode'))
      index += 1
      continue
    }
    throw new BenchmarkUsageError(`unknown option: ${argument}`)
  }

  options.endpointPaths =
    options.endpointPaths.length > 0 ? options.endpointPaths : [...DEFAULT_ENDPOINTS]
  validateEndpointCount(options.endpointPaths)
  if (!options.help && !options.explicitUrl && !isLoopbackUrl(options.baseUrl)) {
    throw new BenchmarkUsageError('an explicit --url is required for a non-local target')
  }
  return options
}

function isLoopbackUrl(value) {
  const parsed = new URL(value)
  return (
    parsed.hostname === '127.0.0.1' ||
    parsed.hostname === 'localhost' ||
    parsed.hostname === '[::1]'
  )
}

function sleep(milliseconds) {
  if (milliseconds === 0) return Promise.resolve()
  return new Promise((resolve) => setTimeout(resolve, milliseconds))
}

function requestHeaders(mode) {
  const headers = { 'cache-control': 'no-cache' }
  if (mode === 'cold') headers.connection = 'close'
  return headers
}

function validateBenchmarkOptions({
  iterations,
  coldIterations,
  concurrency,
  timeoutMs,
  coldGapMs,
  mode,
}) {
  return {
    iterations: positiveInteger(iterations, 'iterations', { max: MAX_ITERATIONS }),
    coldIterations: positiveInteger(coldIterations, 'coldIterations', { max: MAX_COLD_ITERATIONS }),
    concurrency: positiveInteger(concurrency, 'concurrency', { max: MAX_CONCURRENCY }),
    timeoutMs: positiveInteger(timeoutMs, 'timeoutMs', { max: MAX_TIMEOUT_MS }),
    coldGapMs: positiveInteger(coldGapMs, 'coldGapMs', { allowZero: true, max: MAX_COLD_GAP_MS }),
    mode: parseMode(mode),
  }
}

async function responseBytes(response) {
  if (response.body && typeof response.body.getReader === 'function') {
    const reader = response.body.getReader()
    let bytes = 0
    try {
      while (true) {
        const chunk = await reader.read()
        if (chunk.done) return bytes
        bytes += Number.isSafeInteger(chunk.value?.byteLength) ? chunk.value.byteLength : 0
        if (bytes > MAX_RESPONSE_BYTES) {
          try {
            await reader.cancel()
          } catch {
            // The response is already over the safety limit.
          }
          throw new ResponseTooLargeError(MAX_RESPONSE_BYTES)
        }
      }
    } finally {
      reader.releaseLock?.()
    }
  }

  if (typeof response.arrayBuffer !== 'function') throw new Error('response body is not readable')
  const body = await response.arrayBuffer()
  const bytes = Number.isSafeInteger(body?.byteLength) ? body.byteLength : 0
  if (bytes > MAX_RESPONSE_BYTES) throw new ResponseTooLargeError(MAX_RESPONSE_BYTES)
  return bytes
}

export async function measureRequest(
  url,
  { fetchImpl = globalThis.fetch, timeoutMs = DEFAULT_TIMEOUT_MS, mode = 'warm' } = {},
) {
  if (typeof fetchImpl !== 'function') throw new Error('fetch is not available')

  const controller = new globalThis.AbortController()
  const startedAt = performance.now()
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs)
  let status = null
  let bytes = 0

  try {
    const response = await fetchImpl(url, {
      method: 'GET',
      redirect: 'manual',
      headers: requestHeaders(mode),
      signal: controller.signal,
    })
    status = Number.isInteger(response?.status) ? response.status : null
    if (!response) throw new Error('response body is not readable')
    bytes = await responseBytes(response)
    return {
      durationMs: performance.now() - startedAt,
      status,
      bytes,
      timedOut: false,
      failed: false,
      responseTooLarge: false,
    }
  } catch (error) {
    const responseTooLarge = error instanceof ResponseTooLargeError
    if (responseTooLarge) bytes = error.bytes
    return {
      durationMs: performance.now() - startedAt,
      status,
      bytes,
      timedOut: controller.signal.aborted || error?.name === 'AbortError',
      failed: true,
      responseTooLarge,
    }
  } finally {
    globalThis.clearTimeout(timeoutId)
  }
}

function percentile(sortedValues, percentileValue) {
  if (sortedValues.length === 0) return null
  const rank = Math.max(1, Math.ceil((percentileValue / 100) * sortedValues.length))
  return sortedValues[rank - 1]
}

export function summarizeSamples(samples) {
  const latencies = samples.map((sample) => sample.durationMs).sort((left, right) => left - right)
  const byteValues = samples.map((sample) => sample.bytes).sort((left, right) => left - right)
  const statusCounts = {}
  for (const sample of samples) {
    const key = sample.status === null ? 'error' : String(sample.status)
    statusCounts[key] = (statusCounts[key] ?? 0) + 1
  }

  const totalBytes = byteValues.reduce((total, value) => total + value, 0)
  const totalDuration = latencies.reduce((total, value) => total + value, 0)
  return {
    requests: samples.length,
    p50Ms: percentile(latencies, 50),
    p95Ms: percentile(latencies, 95),
    p99Ms: percentile(latencies, 99),
    minMs: latencies.length > 0 ? latencies[0] : null,
    maxMs: latencies.length > 0 ? latencies.at(-1) : null,
    averageMs: latencies.length > 0 ? totalDuration / latencies.length : null,
    statusCounts,
    bytes: {
      total: totalBytes,
      min: byteValues.length > 0 ? byteValues[0] : null,
      max: byteValues.length > 0 ? byteValues.at(-1) : null,
      average: byteValues.length > 0 ? totalBytes / byteValues.length : null,
    },
    timeouts: samples.filter((sample) => sample.timedOut).length,
    errors: samples.filter((sample) => sample.failed && !sample.timedOut).length,
    responseTooLarge: samples.filter((sample) => sample.responseTooLarge).length,
  }
}

async function runSequential(url, count, options) {
  const samples = []
  for (let index = 0; index < count; index += 1) {
    if (index > 0 && options.gapMs > 0) await sleep(options.gapMs)
    samples.push(await measureRequest(url, options))
  }
  return summarizeSamples(samples)
}

async function runBoundedConcurrency(url, count, options) {
  const samples = Array.from({ length: count })
  let nextIndex = 0
  const workerCount = Math.min(options.concurrency, count)
  const workers = Array.from({ length: workerCount }, async () => {
    while (nextIndex < count) {
      const index = nextIndex
      nextIndex += 1
      samples[index] = await measureRequest(url, options)
    }
  })
  await Promise.all(workers)
  return summarizeSamples(samples)
}

function shouldRun(mode, expectedMode) {
  return mode === 'all' || mode === expectedMode
}

export async function runBenchmark({
  baseUrl = DEFAULT_BASE_URL,
  endpointPaths = DEFAULT_ENDPOINTS,
  iterations = DEFAULT_ITERATIONS,
  coldIterations = DEFAULT_COLD_ITERATIONS,
  concurrency = DEFAULT_CONCURRENCY,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  coldGapMs = DEFAULT_COLD_GAP_MS,
  mode = 'all',
  fetchImpl = globalThis.fetch,
} = {}) {
  const validated = validateBenchmarkOptions({
    iterations,
    coldIterations,
    concurrency,
    timeoutMs,
    coldGapMs,
    mode,
  })
  const parsedBaseUrl = validateBaseUrl(baseUrl)
  const normalizedEndpoints = validateEndpointCount(endpointPaths).map(normalizeEndpointPath)
  const endpointReports = []

  for (const endpointPath of normalizedEndpoints) {
    const requestUrl = new URL(endpointPath, parsedBaseUrl).href
    const report = { endpoint: redactEndpointPath(endpointPath) }
    if (shouldRun(validated.mode, 'cold')) {
      report.cold = await runSequential(requestUrl, validated.coldIterations, {
        fetchImpl,
        timeoutMs: validated.timeoutMs,
        mode: 'cold',
        gapMs: validated.coldGapMs,
      })
    }
    if (shouldRun(validated.mode, 'warm')) {
      report.warm = await runSequential(requestUrl, validated.iterations, {
        fetchImpl,
        timeoutMs: validated.timeoutMs,
        mode: 'warm',
        gapMs: 0,
      })
    }
    if (shouldRun(validated.mode, 'concurrency')) {
      report.concurrency = await runBoundedConcurrency(requestUrl, validated.iterations, {
        fetchImpl,
        timeoutMs: validated.timeoutMs,
        mode: 'warm',
        concurrency: validated.concurrency,
        gapMs: 0,
      })
    }
    endpointReports.push(report)
  }

  return {
    schemaVersion: 1,
    measurement: 'HTTP GET latency and response size',
    coldSemantics:
      'cold is a client-side probe with cache-control: no-cache and Connection: close; it cannot force a serverless cold start',
    configuration: {
      endpoints: normalizedEndpoints.map(redactEndpointPath),
      iterations: validated.iterations,
      coldIterations: validated.coldIterations,
      concurrency: validated.concurrency,
      timeoutMs: validated.timeoutMs,
      coldGapMs: validated.coldGapMs,
      mode: validated.mode,
    },
    endpoints: endpointReports,
  }
}

export const CLI_USAGE = `Usage:
  node scripts/benchmarks/http-benchmark.js [options]

Options:
  --url URL              Base URL. Defaults to http://127.0.0.1:3000.
  --endpoint PATH        GET path. Repeat for up to 20 endpoints.
  --iterations N         Warm and concurrency requests per endpoint. Default: 30.
  --cold-iterations N    Cold probes per endpoint. Default: 1.
  --concurrency N        Maximum concurrent requests. Default: 4.
  --timeout-ms N         Per-request timeout. Default: 10000.
  --cold-gap-ms N        Delay between cold probes. Default: 0.
  --mode MODE            all, cold, warm, or concurrency. Default: all.
  --help                 Show this message.

The command does not load .env files, read process.env, print response bodies, or print the target URL.
An explicit --url is required for any non-local target.`

function isMainModule() {
  return process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href
}

if (isMainModule()) {
  try {
    const options = parseCliArguments(process.argv.slice(2))
    if (options.help) {
      console.log(CLI_USAGE)
    } else {
      const report = await runBenchmark(options)
      console.log(JSON.stringify(report, null, 2))
    }
  } catch (error) {
    console.error(
      `Benchmark failed: ${error instanceof BenchmarkUsageError ? error.message : 'request execution failed'}`,
    )
    process.exitCode = 1
  }
}
