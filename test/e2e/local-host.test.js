import { describe, expect, it } from 'vitest'
import {
  LocalHostClient,
  assertListEnvelope,
  assertSafeResponse,
  localHostCredentials,
} from './local-host-client.js'

const enabled = process.env.E2E_ENABLED === 'true'
const localHost = enabled ? describe : describe.skip
const governanceMutationsEnabled = process.env.E2E_GOVERNANCE_MUTATIONS === 'true'
const localGovernance = enabled && governanceMutationsEnabled ? describe : describe.skip
const searchQuery = process.env.E2E_SEARCH_QUERY || ''
const requireArticles = process.env.E2E_REQUIRE_ARTICLES === 'true'
const demoSourceId = process.env.E2E_DEMO_SOURCE_ID || ''
const demoArticleId = process.env.E2E_DEMO_ARTICLE_ID || ''

if (process.env.E2E_RUNNER_ENFORCE === 'true' && !enabled)
  throw new Error('The local E2E runner requires E2E_ENABLED=true; refusing a skipped suite')
if (process.env.E2E_RUNNER_ENFORCE === 'true' && !requireArticles)
  throw new Error(
    'The local E2E runner requires E2E_REQUIRE_ARTICLES=true; refusing an empty-data suite',
  )

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
    expect(
      demoSourceId,
      'E2E_DEMO_SOURCE_ID is required for deterministic demo assertions',
    ).toMatch(/^[0-9a-f]{24}$/i)
    expect(
      demoArticleId,
      'E2E_DEMO_ARTICLE_ID is required for deterministic demo assertions',
    ).toMatch(/^[0-9a-f]{24}$/i)
    expect(searchQuery.trim(), 'E2E_SEARCH_QUERY must be non-empty').toMatch(/\S{2,}/)
    const client = new LocalHostClient()
    const login = await client.login(localHostCredentials('USER'))
    expectStatus(login, 200, 'user login')
    expect(login.payload.data.csrfToken).toEqual(expect.any(String))
    expect(login.payload.data.user.status).toBe('active')

    const me = await client.currentUser()
    expectStatus(me, 200, 'current user')
    expect(me.payload.data.user.email).toBe(login.payload.data.user.email)
    const csrfToken = me.payload.data.csrfToken

    const articles = await client.request(
      `/api/v1/articles?limit=100&sourceId=${encodeURIComponent(demoSourceId)}`,
    )
    expectStatus(articles, 200, 'articles')
    assertListEnvelope(articles.payload, 'articles')
    if (requireArticles)
      expect(
        articles.payload.data.length,
        'demo article seed is required for this E2E run',
      ).toBeGreaterThan(0)

    const demoArticle = articles.payload.data.find(({ id }) => id === demoArticleId)
    expect(demoArticle, 'deterministic demo article is missing from the seeded source').toEqual(
      expect.objectContaining({
        id: demoArticleId,
        source: expect.objectContaining({ id: demoSourceId }),
      }),
    )
    const detail = await client.request(`/api/v1/articles/${encodeURIComponent(demoArticleId)}`)
    expectStatus(detail, 200, 'article detail')
    expect(detail.payload.data.id).toBe(demoArticleId)
    expect(detail.payload.data.source.id).toBe(demoSourceId)
    assertSafeResponse(detail.payload)

    const search = await client.request(
      `/api/v1/search-results?q=${encodeURIComponent(searchQuery)}&mode=text&limit=10`,
    )
    expectStatus(search, 200, 'text search')
    assertListEnvelope(search.payload, 'search results')
    expect(
      search.payload.data.length,
      'E2E_SEARCH_QUERY returned no seeded result',
    ).toBeGreaterThan(0)

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

  it('enforces governance authentication and CSRF boundaries before mutation', async () => {
    const user = new LocalHostClient()
    await user.login(localHostCredentials('USER'))
    const forbiddenAdminRead = await user.request('/api/v1/admin/takedown-requests?limit=1')
    expectStatus(forbiddenAdminRead, 403, 'user takedown read')

    const deletionWithoutCsrf = await user.request('/api/v1/me/deletion-requests', {
      method: 'POST',
      headers: { 'Idempotency-Key': `e2e-boundary-${Date.now()}` },
      body: {},
    })
    expectStatus(deletionWithoutCsrf, 403, 'deletion without csrf')

    const admin = new LocalHostClient()
    await admin.login(localHostCredentials('ADMIN'))
    const takedownWithoutCsrf = await admin.request('/api/v1/admin/takedown-requests', {
      method: 'POST',
      headers: { 'Idempotency-Key': `e2e-boundary-${Date.now()}` },
      body: {
        requesterName: 'E2E boundary probe',
        requesterContact: 'e2e-boundary@example.test',
        targetType: 'article',
        targetIds: ['000000000000000000000000'],
        reason: 'CSRF boundary probe',
        requestedScope: ['metadata'],
      },
    })
    expectStatus(takedownWithoutCsrf, 403, 'takedown without csrf')
  }, 60_000)
})

localGovernance('Step 12 opt-in governance mutation E2E', () => {
  it('creates and rejects a takedown request without hiding the demo article', async () => {
    const articleId = process.env.E2E_TAKEDOWN_ARTICLE_ID
    expect(articleId, 'E2E_TAKEDOWN_ARTICLE_ID is required for governance mutations').toMatch(
      /^[0-9a-f]{24}$/i,
    )
    const admin = new LocalHostClient()
    const login = await admin.login(localHostCredentials('ADMIN'))
    expectStatus(login, 200, 'governance admin login')
    const session = await admin.currentUser()
    expectStatus(session, 200, 'governance admin session')
    const idempotencyKey = `e2e-takedown-${articleId}-${Date.now()}`
    const created = await admin.request('/api/v1/admin/takedown-requests', {
      method: 'POST',
      headers: { 'Idempotency-Key': idempotencyKey },
      csrfToken: session.payload.data.csrfToken,
      body: {
        requesterName: 'TechPulse E2E',
        requesterContact: 'e2e-takedown@example.test',
        targetType: 'article',
        targetIds: [articleId],
        reason: 'Opt-in local E2E rejection path',
        requestedScope: ['metadata'],
      },
    })
    expectStatus(created, 201, 'create takedown')
    const takedownId = created.payload.data.id

    const reviewing = await admin.request(`/api/v1/admin/takedown-requests/${takedownId}`, {
      method: 'PATCH',
      csrfToken: session.payload.data.csrfToken,
      body: { status: 'reviewing', reasonCode: 'takedown_review_started' },
    })
    expectStatus(reviewing, 200, 'review takedown')
    const rejected = await admin.request(`/api/v1/admin/takedown-requests/${takedownId}`, {
      method: 'PATCH',
      csrfToken: session.payload.data.csrfToken,
      body: { status: 'rejected', reasonCode: 'takedown_rejected' },
    })
    expectStatus(rejected, 200, 'reject takedown')
    expect(rejected.payload.data.status).toBe('rejected')
  }, 60_000)

  it('accepts account deletion only for an explicitly disposable E2E user', async () => {
    const deletionEmail = process.env.E2E_DELETION_EMAIL?.trim().toLowerCase()
    const confirmationEmail = process.env.E2E_DELETION_CONFIRM_EMAIL?.trim().toLowerCase()
    const userEmail = process.env.E2E_USER_EMAIL?.trim().toLowerCase()
    const adminEmail = process.env.E2E_ADMIN_EMAIL?.trim().toLowerCase()
    expect(confirmationEmail, 'E2E_DELETION_CONFIRM_EMAIL is required').toBe(deletionEmail)
    expect(
      deletionEmail,
      'E2E_DELETION_EMAIL must be distinct from the core E2E accounts',
    ).not.toBe(userEmail)
    expect(
      deletionEmail,
      'E2E_DELETION_EMAIL must be distinct from the core E2E accounts',
    ).not.toBe(adminEmail)
    const user = new LocalHostClient()
    const login = await user.login(localHostCredentials('DELETION'))
    expectStatus(login, 200, 'deletion user login')
    expect(login.payload.data.user.role).toBe('user')
    expect(login.payload.data.user.email.trim().toLowerCase()).toBe(deletionEmail)
    const session = await user.currentUser()
    expectStatus(session, 200, 'deletion user session')
    const accepted = await user.request('/api/v1/me/deletion-requests', {
      method: 'POST',
      headers: { 'Idempotency-Key': `e2e-deletion-${Date.now()}` },
      csrfToken: session.payload.data.csrfToken,
      body: {},
    })
    expectStatus(accepted, 202, 'account deletion request')
    expect(accepted.payload.data.id).toEqual(expect.any(String))
    const afterRequest = await user.currentUser()
    expectStatus(afterRequest, 401, 'deletion user after request')
  }, 60_000)
})
