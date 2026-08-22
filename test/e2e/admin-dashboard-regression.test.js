import { describe, expect, it } from 'vitest'
import {
  assertListEnvelope,
  assertSafeResponse,
  LocalHostClient,
  localHostCredentials,
} from './local-host-client.js'

const enabled = process.env.ADMIN_E2E_ENABLED === 'true'
const adminE2e = enabled ? describe : describe.skip

if (process.env.ADMIN_E2E_RUNNER_ENFORCE === 'true' && !enabled)
  throw new Error('The admin dashboard E2E runner requires ADMIN_E2E_ENABLED=true; refusing a skipped suite')

function expectStatus(result, expected, label) {
  expect(result.response.status, `${label} returned status ${result.response.status}`).toBe(expected)
}

function createRecordingClient() {
  const client = new LocalHostClient()
  const requests = []
  const originalRequest = client.request.bind(client)
  client.request = async (path, options) => {
    const result = await originalRequest(path, options)
    requests.push({ path, method: (options?.method ?? 'GET').toUpperCase(), status: result.response.status })
    return result
  }
  return { client, requests }
}

function matchingRequests(requests, pathname) {
  return requests.filter((request) => new URL(request.path, 'http://admin-e2e.invalid').pathname === pathname)
}

function assertOneRead(requests, pathname, expectedQuery = {}) {
  const matches = matchingRequests(requests, pathname)
  expect(matches, `${pathname} should issue exactly one request`).toHaveLength(1)
  expect(matches[0].method).toBe('GET')
  const query = new URL(matches[0].path, 'http://admin-e2e.invalid').searchParams
  for (const [key, value] of Object.entries(expectedQuery))
    expect(query.get(key), `${pathname} must include filter ${key}`).toBe(value)
  return matches[0]
}

async function loginAdmin() {
  const { client, requests } = createRecordingClient()
  const login = await client.login(localHostCredentials('ADMIN'))
  expectStatus(login, 200, 'admin login')
  expect(login.payload.data.user.role).toBe('admin')
  return { client, requests, login }
}

adminE2e('admin dashboard authenticated API regression', () => {
  it('reads overview, jobs, articles, and audit through the expected API sequence', async () => {
    const { client, requests } = await loginAdmin()

    const overview = await client.request('/api/v1/admin/overview')
    expectStatus(overview, 200, 'admin overview')
    expect(overview.payload.data).toEqual(
      expect.objectContaining({ activeSources: expect.any(Number), queuedJobs: expect.any(Number) }),
    )
    assertSafeResponse(overview.payload)

    const jobs = await Promise.all([
      client.request('/api/v1/admin/ingestion-jobs'),
      client.request('/api/v1/admin/sources'),
    ])
    for (const [result, label] of [[jobs[0], 'ingestion jobs'], [jobs[1], 'job sources']]) {
      expectStatus(result, 200, label)
      assertListEnvelope(result.payload, label)
    }

    const indexing = await client.request('/api/v1/admin/indexing-jobs')
    expectStatus(indexing, 200, 'indexing jobs')
    assertListEnvelope(indexing.payload, 'indexing jobs')

    const articles = await client.request('/api/v1/admin/articles')
    expectStatus(articles, 200, 'admin articles')
    assertListEnvelope(articles.payload, 'admin articles')

    const audit = await client.request('/api/v1/admin/audit-logs')
    expectStatus(audit, 200, 'admin audit logs')
    assertListEnvelope(audit.payload, 'admin audit logs')

    expect(requests.filter(({ method }) => method === 'GET')).toHaveLength(6)
    assertOneRead(requests, '/api/v1/admin/overview')
    assertOneRead(requests, '/api/v1/admin/ingestion-jobs')
    assertOneRead(requests, '/api/v1/admin/sources')
    assertOneRead(requests, '/api/v1/admin/indexing-jobs')
    assertOneRead(requests, '/api/v1/admin/articles')
    assertOneRead(requests, '/api/v1/admin/audit-logs')
  }, 60_000)

  it('accepts the contract-defined admin list filters through the authenticated API', async () => {
    const { client, requests } = await loginAdmin()
    const reads = [
      {
        path: '/api/v1/admin/ingestion-jobs',
        label: 'filtered ingestion jobs',
        query: { status: 'queued' },
      },
      {
        path: '/api/v1/admin/indexing-jobs',
        label: 'filtered indexing jobs',
        query: { status: 'queued', task: 'embedding' },
      },
      {
        path: '/api/v1/admin/articles',
        label: 'filtered admin articles',
        query: { status: 'published' },
      },
      {
        path: '/api/v1/admin/audit-logs',
        label: 'filtered admin audit logs',
        query: { actorType: 'admin' },
      },
    ]

    for (const read of reads) {
      const requestUrl = new URL(read.path, 'http://admin-e2e.invalid')
      for (const [key, value] of Object.entries(read.query)) requestUrl.searchParams.set(key, value)
      const result = await client.request(`${requestUrl.pathname}${requestUrl.search}`)
      expectStatus(result, 200, read.label)
      assertListEnvelope(result.payload, read.label)
    }

    expect(requests.filter(({ method }) => method === 'GET')).toHaveLength(reads.length)
    for (const read of reads) assertOneRead(requests, read.path, read.query)
    expect(requests.every(({ method }) => method === 'GET' || method === 'POST')).toBe(true)
  }, 60_000)
})
