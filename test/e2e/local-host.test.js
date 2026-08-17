import { describe, expect, it } from 'vitest'
import {
  LocalHostClient,
  assertListEnvelope,
  assertSafeResponse,
  localHostCredentials,
} from './local-host-client.js'

const enabled = process.env.E2E_ENABLED === 'true'
const localHost = enabled ? describe : describe.skip
const searchQuery = process.env.E2E_SEARCH_QUERY || 'AI'
const requireArticles = process.env.E2E_REQUIRE_ARTICLES === 'true'

function expectStatus(result, expected, label) {
  expect(
    result.response.status,
    `${label} returned ${result.response.status}: ${JSON.stringify(result.payload)}`,
  ).toBe(expected)
}

localHost('Step 12 local-host Vitest E2E', () => {
  it('serves the health endpoint through the running local host', async () => {
    const client = new LocalHostClient()
    const result = await client.request('/api/v1/health')
    expectStatus(result, 200, 'health')
    expect(result.payload.data.status).toBe('ok')
    expect(result.payload.data.timestamp).toMatch(/Z$/)
    assertSafeResponse(result.payload)
  })

  it('runs the authenticated user content flow and revokes the session', async () => {
    const client = new LocalHostClient()
    const login = await client.login(localHostCredentials('USER'))
    expectStatus(login, 200, 'user login')
    expect(login.payload.data.csrfToken).toEqual(expect.any(String))
    expect(login.payload.data.user.status).toBe('active')

    const me = await client.currentUser()
    expectStatus(me, 200, 'current user')
    expect(me.payload.data.user.email).toBe(login.payload.data.user.email)
    const csrfToken = me.payload.data.csrfToken

    const articles = await client.request('/api/v1/articles?limit=10')
    expectStatus(articles, 200, 'articles')
    assertListEnvelope(articles.payload, 'articles')
    if (requireArticles)
      expect(
        articles.payload.data.length,
        'demo article seed is required for this E2E run',
      ).toBeGreaterThan(0)

    const firstArticle = articles.payload.data[0]
    if (firstArticle?.id) {
      const detail = await client.request(`/api/v1/articles/${encodeURIComponent(firstArticle.id)}`)
      expectStatus(detail, 200, 'article detail')
      expect(detail.payload.data.id).toBe(firstArticle.id)
      assertSafeResponse(detail.payload)
    }

    const search = await client.request(
      `/api/v1/search-results?q=${encodeURIComponent(searchQuery)}&mode=text&limit=10`,
    )
    expectStatus(search, 200, 'text search')
    assertListEnvelope(search.payload, 'search results')

    const sessions = await client.request('/api/v1/chat-sessions?limit=10')
    expectStatus(sessions, 200, 'chat sessions')
    assertListEnvelope(sessions.payload, 'chat sessions')

    const saved = await client.request('/api/v1/me/saved-articles?limit=10')
    expectStatus(saved, 200, 'saved articles')
    assertListEnvelope(saved.payload, 'saved articles')

    const logout = await client.logout(csrfToken)
    expectStatus(logout, 204, 'user logout')
    const afterLogout = await client.currentUser()
    expectStatus(afterLogout, 401, 'current user after logout')
  }, 60_000)

  it('reads all admin dashboard list surfaces without exposing sensitive fields', async () => {
    const client = new LocalHostClient()
    const login = await client.login(localHostCredentials('ADMIN'))
    expectStatus(login, 200, 'admin login')
    expect(login.payload.data.user.role).toBe('admin')

    const overview = await client.request('/api/v1/admin/overview')
    expectStatus(overview, 200, 'admin overview')
    expect(overview.payload.data).toEqual(
      expect.objectContaining({
        activeSources: expect.any(Number),
        queuedJobs: expect.any(Number),
      }),
    )
    assertSafeResponse(overview.payload)

    const listRoutes = [
      ['/api/v1/admin/articles?limit=10', 'admin articles'],
      ['/api/v1/admin/sources?limit=10', 'admin sources'],
      ['/api/v1/admin/ingestion-jobs?limit=10', 'admin ingestion jobs'],
      ['/api/v1/admin/indexing-jobs?limit=10', 'admin indexing jobs'],
      ['/api/v1/admin/takedown-requests?limit=10', 'admin takedowns'],
      ['/api/v1/admin/account-deletion-requests?limit=10', 'admin account deletions'],
      ['/api/v1/admin/users?limit=10', 'admin users'],
      ['/api/v1/admin/audit-logs?limit=10', 'admin audit logs'],
    ]
    for (const [path, label] of listRoutes) {
      const result = await client.request(path)
      expectStatus(result, 200, label)
      assertListEnvelope(result.payload, label)
    }

    const postLogoutMe = await client.currentUser()
    expectStatus(postLogoutMe, 200, 'current admin user before logout')

    const logout = await client.logout(postLogoutMe.payload.data.csrfToken)
    expectStatus(logout, 204, 'admin logout')
  }, 60_000)
})
