import { describe, expect, it, vi } from 'vitest'
import {
  measureRequest,
  parseCliArguments,
  runBenchmark,
  summarizeSamples,
} from '../../scripts/benchmarks/http-benchmark.js'

describe('HTTP benchmark utility', () => {
  it('uses a local default and requires an explicit URL for non-local targets', () => {
    expect(parseCliArguments([])).toMatchObject({
      baseUrl: 'http://127.0.0.1:3000',
      endpointPaths: ['/api/v1/health'],
      explicitUrl: false,
    })
    expect(
      parseCliArguments([
        '--url',
        'https://preview.example.test',
        '--endpoint',
        '/api/v1/articles',
        '--mode',
        'warm',
      ]),
    ).toMatchObject({
      baseUrl: 'https://preview.example.test/',
      endpointPaths: ['/api/v1/articles'],
      mode: 'warm',
      explicitUrl: true,
    })
    expect(() => parseCliArguments(['--url', 'ftp://preview.example.test'])).toThrow(
      /http or https/,
    )
    expect(() =>
      parseCliArguments(['--url', 'https://user:password@preview.example.test']),
    ).toThrow(/credentials/)
  })

  it('rejects unsafe request-count, concurrency, timeout, and gap limits from CLI and API calls', async () => {
    const cliLimits = [
      [['--iterations', '1001'], /iterations.*1000/],
      [['--cold-iterations', '101'], /cold-iterations.*100/],
      [['--concurrency', '101'], /concurrency.*100/],
      [['--timeout-ms', '120001'], /timeout-ms.*120000/],
      [['--cold-gap-ms', '300001'], /cold-gap-ms.*300000/],
    ]
    for (const [args, pattern] of cliLimits) expect(() => parseCliArguments(args)).toThrow(pattern)

    const apiLimits = [
      ['iterations', 1001, /iterations.*1000/],
      ['coldIterations', 101, /coldIterations.*100/],
      ['concurrency', 101, /concurrency.*100/],
      ['timeoutMs', 120001, /timeoutMs.*120000/],
      ['coldGapMs', 300001, /coldGapMs.*300000/],
    ]
    for (const [name, value, pattern] of apiLimits) {
      await expect(
        runBenchmark({ baseUrl: 'https://preview.example.test', [name]: value }),
      ).rejects.toThrow(pattern)
    }
  })

  it('enforces a shared maximum endpoint count for CLI and API calls', async () => {
    const endpointPaths = Array.from({ length: 21 }, (_, index) => `/endpoint-${index}`)
    const cliArguments = endpointPaths.flatMap((endpoint) => ['--endpoint', endpoint])

    expect(() => parseCliArguments(cliArguments)).toThrow(/endpoint.*20/i)
    await expect(
      runBenchmark({
        baseUrl: 'https://preview.example.test',
        endpointPaths,
        mode: 'warm',
        iterations: 1,
        fetchImpl: vi.fn(),
      }),
    ).rejects.toThrow(/endpoint.*20/i)
  })

  it('summarizes latency, statuses, bytes, and timeouts', () => {
    const summary = summarizeSamples([
      { durationMs: 3, status: 200, bytes: 10, timedOut: false, failed: false },
      { durationMs: 1, status: 200, bytes: 20, timedOut: false, failed: false },
      { durationMs: 8, status: 503, bytes: 5, timedOut: false, failed: false },
      { durationMs: 13, status: null, bytes: 0, timedOut: true, failed: true },
    ])

    expect(summary).toMatchObject({
      requests: 4,
      p50Ms: 3,
      p95Ms: 13,
      p99Ms: 13,
      statusCounts: { 200: 2, 503: 1, error: 1 },
      bytes: { total: 35, min: 0, max: 20, average: 8.75 },
      timeouts: 1,
      errors: 0,
    })
  })

  it('runs cold, warm, and bounded concurrency samples without exposing response data', async () => {
    let active = 0
    let maxActive = 0
    const fetchImpl = vi.fn(async (url, init) => {
      active += 1
      maxActive = Math.max(maxActive, active)
      await new Promise((resolve) => setTimeout(resolve, 1))
      active -= 1
      expect(init.method).toBe('GET')
      expect(init.headers['cache-control']).toBe('no-cache')
      expect(url).toMatch(/^https:\/\/preview\.example\.test\//)
      return {
        status: url.endsWith('/health') ? 200 : 201,
        arrayBuffer: async () =>
          new globalThis.TextEncoder().encode('private response body').buffer,
      }
    })

    const report = await runBenchmark({
      baseUrl: 'https://preview.example.test',
      endpointPaths: ['/health', '/articles?limit=20'],
      coldIterations: 1,
      iterations: 3,
      concurrency: 2,
      timeoutMs: 100,
      fetchImpl,
    })

    expect(fetchImpl).toHaveBeenCalledTimes(14)
    expect(maxActive).toBeLessThanOrEqual(2)
    expect(report.configuration.endpoints).toEqual(['/health', '/articles?limit=%5Bredacted%5D'])
    expect(report.endpoints[0].cold.requests).toBe(1)
    expect(report.endpoints[0].warm.requests).toBe(3)
    expect(report.endpoints[0].concurrency.requests).toBe(3)
    expect(report.endpoints[1].warm.statusCounts).toEqual({ 201: 3 })
    expect(report.endpoints[1].warm.bytes.total).toBeGreaterThan(0)
    expect(JSON.stringify(report)).not.toContain('private response body')
  })

  it('redacts sensitive path segments while preserving safe route names', async () => {
    const fetchImpl = vi.fn(async () => ({
      status: 200,
      arrayBuffer: async () => new ArrayBuffer(0),
    }))
    const report = await runBenchmark({
      baseUrl: 'https://preview.example.test',
      endpointPaths: [
        '/api/v1/users/secret-session-token',
        '/api/v1/articles/507f1f77bcf86cd799439011',
        '/api/v1/account-deletion-requests',
      ],
      mode: 'warm',
      iterations: 1,
      fetchImpl,
    })

    expect(report.endpoints.map(({ endpoint }) => endpoint)).toEqual([
      '/api/v1/users/[redacted]',
      '/api/v1/articles/[redacted]',
      '/api/v1/account-deletion-requests',
    ])
    expect(JSON.stringify(report)).not.toContain('secret-session-token')
    expect(JSON.stringify(report)).not.toContain('507f1f77bcf86cd799439011')
  })

  it('caps streamed response accounting without buffering an oversized body', async () => {
    let cancelled = false
    const result = await measureRequest('https://preview.example.test/large', {
      timeoutMs: 100,
      fetchImpl: async () => ({
        status: 200,
        body: {
          getReader: () => ({
            read: async () => ({ done: false, value: new Uint8Array(8 * 1024 * 1024 + 1) }),
            cancel: async () => {
              cancelled = true
            },
            releaseLock: () => undefined,
          }),
        },
      }),
    })

    expect(result).toMatchObject({
      status: 200,
      bytes: 8 * 1024 * 1024,
      failed: true,
      timedOut: false,
      responseTooLarge: true,
    })
    expect(cancelled).toBe(true)
  })

  it('classifies an abort as a timeout without returning the underlying error', async () => {
    const result = await measureRequest('https://preview.example.test/slow', {
      timeoutMs: 5,
      fetchImpl: (_url, { signal }) =>
        new Promise((resolve, reject) => {
          signal.addEventListener(
            'abort',
            () => {
              const error = new Error('secret response details')
              error.name = 'AbortError'
              reject(error)
            },
            { once: true },
          )
        }),
    })

    expect(result).toMatchObject({ timedOut: true, failed: true, status: null, bytes: 0 })
    expect(JSON.stringify(result)).not.toContain('secret response details')
  })
})
