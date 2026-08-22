import { describe, expect, it, vi } from 'vitest'
import {
  ADMIN_DASHBOARD_ENDPOINTS,
  AdminDashboardBenchmarkConfigurationError,
  explainAdminDashboardMongoPlans,
  parseAdminDashboardBenchmarkEnvironment,
  runAdminDashboardBenchmark,
} from '../../scripts/benchmarks/admin-dashboard-benchmark.js'

function response({ status = 200, body = {}, cookie } = {}) {
  const bytes = new globalThis.TextEncoder().encode(JSON.stringify(body))
  return {
    status,
    headers: {
      get(name) {
        if (name.toLowerCase() === 'content-type') return 'application/json'
        if (name.toLowerCase() === 'set-cookie') return cookie ?? null
        return null
      },
      getSetCookie() {
        return cookie ? [cookie] : []
      },
    },
    arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
  }
}

function configuredEnvironment(overrides = {}) {
  return {
    ADMIN_BENCHMARK_ENABLED: 'true',
    ADMIN_BENCHMARK_TARGET: 'local',
    ADMIN_BENCHMARK_BASE_URL: 'http://localhost:3000',
    ADMIN_BENCHMARK_ORIGIN: 'http://localhost:3000',
    ADMIN_BENCHMARK_EMAIL: 'benchmark-admin@example.test',
    ADMIN_BENCHMARK_PASSWORD: 'benchmark-password-not-a-secret',
    ADMIN_BENCHMARK_ITERATIONS: '2',
    ADMIN_BENCHMARK_COLD_ITERATIONS: '1',
    ADMIN_BENCHMARK_TIMEOUT_MS: '100',
    ...overrides,
  }
}

function adminFetch({ failedPath } = {}) {
  return vi.fn(async (input) => {
    const path = new URL(input).pathname
    if (path === '/api/v1/auth/login') {
      return response({
        cookie: '__Host-techpulse_session=benchmark-session; Path=/; HttpOnly',
        body: { data: { user: { role: 'admin' }, csrfToken: 'csrf-token-not-for-reporting' } },
      })
    }
    return response({
      status: path === failedPath ? 503 : 200,
      body: {
        data: [],
        meta: { hasNext: false, nextCursor: null },
        privateResponseBody: 'must never appear in a benchmark report',
      },
    })
  })
}

function queryPlan({ stage = 'IXSCAN' } = {}) {
  return {
    queryPlanner: { winningPlan: { stage, indexName: stage === 'IXSCAN' ? 'benchmark_index' : undefined } },
    executionStats: {
      executionTimeMillis: 2,
      totalKeysExamined: 3,
      totalDocsExamined: 3,
      nReturned: 2,
      executionStages: { stage },
    },
  }
}

describe('admin dashboard benchmark', () => {
  it('requires explicit opt-in and rejects an unsafe target configuration', () => {
    expect(() =>
      parseAdminDashboardBenchmarkEnvironment(configuredEnvironment({ ADMIN_BENCHMARK_ENABLED: 'false' })),
    ).toThrow(AdminDashboardBenchmarkConfigurationError)
    expect(() =>
      parseAdminDashboardBenchmarkEnvironment(
        configuredEnvironment({
          ADMIN_BENCHMARK_TARGET: 'preview',
          ADMIN_BENCHMARK_BASE_URL: 'http://preview.example.test',
          ADMIN_BENCHMARK_ORIGIN: 'http://preview.example.test',
        }),
      ),
    ).toThrow(/HTTPS/)
    expect(() =>
      parseAdminDashboardBenchmarkEnvironment(
        configuredEnvironment({ ADMIN_BENCHMARK_BASE_URL: 'http://user:password@localhost:3000' }),
      ),
    ).toThrow(/credentials/)
    expect(() =>
      parseAdminDashboardBenchmarkEnvironment(
        configuredEnvironment({ ADMIN_BENCHMARK_PROTECTION_HEADERS_JSON: '{"Cookie":"unsafe"}' }),
      ),
    ).toThrow(/Cookie/)
  })

  it('measures authenticated cold and warm endpoint latency plus the dashboard request waterfall without reporting credentials or bodies', async () => {
    const protectionValue = 'test-only-preview-protection-value'
    const configuration = parseAdminDashboardBenchmarkEnvironment(
      configuredEnvironment({
        ADMIN_BENCHMARK_PROTECTION_HEADERS_JSON: JSON.stringify({ Authorization: protectionValue }),
      }),
    )
    const fetchImpl = adminFetch()

    const report = await runAdminDashboardBenchmark({ configuration, fetchImpl })

    expect(report).toMatchObject({
      schemaVersion: 1,
      passed: true,
      authentication: { status: 200, durationMs: expect.any(Number) },
      configuration: {
        target: 'local',
        iterations: 2,
        coldIterations: 1,
        protectionHeaderNames: ['authorization'],
        endpoints: ADMIN_DASHBOARD_ENDPOINTS.map(({ id }) => id),
      },
      waterfall: {
        phases: expect.arrayContaining([
          expect.objectContaining({ id: 'overview', requests: expect.any(Array) }),
          expect.objectContaining({ id: 'jobs-ingestion', requestCount: 2 }),
          expect.objectContaining({ id: 'jobs-indexing', requestCount: 1 }),
          expect.objectContaining({ id: 'audit', requests: expect.any(Array) }),
        ]),
      },
    })
    expect(report.endpoints).toHaveLength(ADMIN_DASHBOARD_ENDPOINTS.length)
    for (const endpoint of report.endpoints) {
      expect(endpoint.cold).toMatchObject({ requests: 1, p50Ms: expect.any(Number), p95Ms: expect.any(Number) })
      expect(endpoint.warm).toMatchObject({ requests: 2, p50Ms: expect.any(Number), p95Ms: expect.any(Number) })
    }
    expect(fetchImpl).toHaveBeenCalledTimes(1 + 6 + ADMIN_DASHBOARD_ENDPOINTS.length * 3)
    const coldRequests = fetchImpl.mock.calls.filter(([, init]) => init.headers.get('connection') === 'close')
    expect(coldRequests).toHaveLength(ADMIN_DASHBOARD_ENDPOINTS.length)

    const serialized = JSON.stringify(report)
    expect(serialized).not.toContain('benchmark-password-not-a-secret')
    expect(serialized).not.toContain('benchmark-admin@example.test')
    expect(serialized).not.toContain('benchmark-session')
    expect(serialized).not.toContain('csrf-token-not-for-reporting')
    expect(serialized).not.toContain('must never appear in a benchmark report')
    expect(serialized).not.toContain('localhost:3000')
    expect(serialized).not.toContain(protectionValue)
  })

  it('marks an unexpected admin response as a failed measurement without exposing its body', async () => {
    const configuration = parseAdminDashboardBenchmarkEnvironment(configuredEnvironment())
    const report = await runAdminDashboardBenchmark({
      configuration,
      fetchImpl: adminFetch({ failedPath: '/api/v1/admin/audit-logs' }),
    })

    expect(report.passed).toBe(false)
    expect(report.endpoints.find(({ id }) => id === 'audit')?.warm.statusCounts).toEqual({ 503: 2 })
    expect(JSON.stringify(report)).not.toContain('must never appear in a benchmark report')
  })

  it('runs read-only Mongo explain diagnostics through an environment indirection without reporting the URI', async () => {
    const explain = vi.fn(async () => queryPlan())
    const client = {
      connect: vi.fn(async () => undefined),
      close: vi.fn(async () => undefined),
      db: vi.fn(() => ({
        collection: vi.fn(() => ({
          find: vi.fn(() => ({
            sort: vi.fn(() => ({
              limit: vi.fn(() => ({ explain })),
            })),
          })),
        })),
      })),
    }
    const createMongoClient = vi.fn(() => client)
    const report = await explainAdminDashboardMongoPlans({
      environment: {
        MONGODB_URI_ENV: 'ADMIN_BENCHMARK_MONGO_URI',
        ADMIN_BENCHMARK_MONGO_URI: 'mongodb+srv://benchmark-user:benchmark-password@cluster.example.test/app',
        MONGODB_DATABASE: 'techpulse_app',
      },
      createMongoClient,
    })

    expect(report).toMatchObject({ status: 'ok', plans: expect.any(Array) })
    expect(report.plans).toHaveLength(5)
    expect(explain).toHaveBeenCalledTimes(5)
    expect(client.close).toHaveBeenCalledTimes(1)
    expect(JSON.stringify(report)).not.toContain('benchmark-user')
    expect(JSON.stringify(report)).not.toContain('benchmark-password')
    expect(JSON.stringify(report)).not.toContain('cluster.example.test')
  })

  it('flags a COLLSCAN or blocking sort in a Mongo explain diagnostic instead of hiding it', async () => {
    const client = {
      connect: async () => undefined,
      close: async () => undefined,
      db: () => ({
        collection: () => ({
          find: () => ({
            sort: () => ({
              limit: () => ({ explain: async () => queryPlan({ stage: 'COLLSCAN' }) }),
            }),
          }),
        }),
      }),
    }
    const report = await explainAdminDashboardMongoPlans({
      environment: {
        MONGODB_URI_ENV: 'ADMIN_BENCHMARK_MONGO_URI',
        ADMIN_BENCHMARK_MONGO_URI: 'mongodb://localhost:27017',
        MONGODB_DATABASE: 'techpulse_app',
      },
      createMongoClient: () => client,
    })

    expect(report.status).toBe('ok')
    expect(report.plans.every(({ requiresAttention }) => requiresAttention)).toBe(true)
  })
})
