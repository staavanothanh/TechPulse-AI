import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { createApp } from '../../server/app.js'

const now = '2026-08-10T00:00:00.000Z'
const adminToken = 'admin-session-token-1234'
const userToken = 'user-session-token-12345'
const source = {
  id: '64d2f4bda57d0c1d2c38f010', name: 'Example', sourceKey: 'rss:example', publisherName: 'Example Publisher', domain: 'example.com', connectorType: 'rss', accessMethod: 'rss', authorityTier: 'editorial', connectorConfig: { kind: 'rss', feedUrl: 'https://example.com/feed.xml', batchSize: 20 },
  operationalStatus: 'draft', licenseStatus: 'review-needed', llmInputScope: 'none', storageScope: { metadata: false, excerpt: false, summary: false, embedding: false }, mediaPolicy: { imageMode: 'none', videoMode: 'none', allowedHosts: [], attributionRequired: false, evidenceNote: null }, attributionRequired: false, attributionText: null, termsUrl: null, licenseUrl: null, evidenceNote: null, reviewedAt: null, reviewedBy: null, policyVersion: 1,
  reconciliation: { status: 'idle', requiredPolicyVersion: 1, completedPolicyVersion: null, requestedAt: null, error: null }, technicalCheck: { status: 'not-run', checkedAt: null, contentType: null, resolvedHost: null, sampleCount: null, error: null }, health: { lastIngestSucceededAt: null, lastIngestFailedAt: null, consecutiveFailures: 0, lastError: null }, createdAt: now, updatedAt: now,
  rightsHolderNote: 'Internal evidence that must not cross HTTP',
}
const authService = {
  authenticate: vi.fn(async ({ token }) => ({
    user: { id: '64d2f4bda57d0c1d2c38f001', role: token === adminToken ? 'admin' : 'user', status: 'active' },
    session: { _id: '64d2f4bda57d0c1d2c38f002', userSessionVersion: 0 },
  })),
  verifyCsrf: vi.fn(async () => true),
}
const sourceService = {
  list: vi.fn(async () => ({ sources: [source], hasNext: false, nextCursor: null })),
  get: vi.fn(async () => source),
  create: vi.fn(async () => source),
  update: vi.fn(async () => source),
  reviewPolicy: vi.fn(async () => source),
  requestReReview: vi.fn(async () => source),
  runTechnicalCheck: vi.fn(async () => { const error = new Error('Technical check is unavailable until Step 4'); error.status = 503; error.code = 'service_unavailable'; throw error }),
}
const reconciliationService = {
  preview: vi.fn(async () => ({ outcome: 'completed', mode: 'dry-run', sourceId: source.id, sourceKey: source.sourceKey, policyVersion: 1, requiredPolicyVersion: 1, operationalStatus: source.operationalStatus, reconciliation: source.reconciliation, inspected: 0, staleArticleCount: 0, wouldCreate: 0, created: 0, pages: 0, hasMore: false, jobs: [], skippedReasons: [], failedReasons: [] })),
  execute: vi.fn(async () => ({ outcome: 'completed', mode: 'execute', sourceId: source.id, sourceKey: source.sourceKey, policyVersion: 1, requiredPolicyVersion: 1, operationalStatus: source.operationalStatus, reconciliation: source.reconciliation, inspected: 0, staleArticleCount: 0, wouldCreate: 0, created: 0, pages: 0, hasMore: false, jobs: [], skippedReasons: [], failedReasons: [] })),
}
let server
let origin

beforeAll(async () => {
  const app = createApp({ authService, sourceService, sourcePolicyReconciliationService: reconciliationService })
  server = await new Promise((resolve) => { const listener = app.listen(0, () => resolve(listener)) })
  origin = `http://127.0.0.1:${server.address().port}`
})
afterAll(async () => { if (server) await new Promise((resolve) => server.close(resolve)) })

describe('Source Registry HTTP security boundary', () => {
  it('returns 403 for a regular user on every Source Registry operation', async () => {
    vi.clearAllMocks()
    const cookie = `__Host-techpulse_session=${userToken}`
    const mutationHeaders = { Origin: 'http://localhost:3000', Cookie: cookie, 'X-CSRF-Token': 'csrf-token', 'Content-Type': 'application/json' }
    const createBody = { name: 'Example', sourceKey: 'rss:example', publisherName: 'Example Publisher', domain: 'example.com', connectorType: 'rss', accessMethod: 'rss', authorityTier: 'editorial', connectorConfig: { kind: 'rss', feedUrl: 'https://example.com/feed.xml', batchSize: 20 } }
    const reviewBody = { licenseStatus: 'metadata-only', llmInputScope: 'metadata', storageScope: { metadata: true, excerpt: false, summary: true, embedding: true }, mediaPolicy: { imageMode: 'none', videoMode: 'none', allowedHosts: [], attributionRequired: false, evidenceNote: null }, attributionRequired: true, attributionText: 'Example', evidenceNote: 'Human review.', reasonCode: 'source_policy_reviewed' }
    const cases = [
      ['/api/v1/admin/sources', { headers: { Cookie: cookie } }],
      ['/api/v1/admin/sources', { method: 'POST', headers: mutationHeaders, body: JSON.stringify(createBody) }],
      [`/api/v1/admin/sources/${source.id}`, { headers: { Cookie: cookie } }],
      [`/api/v1/admin/sources/${source.id}`, { method: 'PATCH', headers: mutationHeaders, body: JSON.stringify({ operationalStatus: 'testing', reasonCode: 'source_status_changed' }) }],
      [`/api/v1/admin/sources/${source.id}/technical-checks`, { method: 'POST', headers: mutationHeaders, body: JSON.stringify({ reasonCode: 'source_technical_check_requested' }) }],
      [`/api/v1/admin/sources/${source.id}/policy-reviews`, { method: 'POST', headers: mutationHeaders, body: JSON.stringify(reviewBody) }],
      [`/api/v1/admin/sources/${source.id}/reconciliation`, { headers: { Cookie: cookie } }],
      [`/api/v1/admin/sources/${source.id}/reconciliation`, { method: 'POST', headers: { ...mutationHeaders, 'Idempotency-Key': 'regular-reconciliation-1' }, body: JSON.stringify({ reasonCode: 'source_policy_reconciliation_requested' }) }],
      [`/api/v1/admin/sources/${source.id}/re-review-requests`, { method: 'POST', headers: { ...mutationHeaders, 'Idempotency-Key': 'regular-user-re-review-1' }, body: JSON.stringify({ reasonCode: 'source_policy_re_review_requested' }) }],
    ]
    for (const [path, init] of cases) {
      const response = await fetch(`${origin}${path}`, init)
      expect(response.status).toBe(403)
      expect((await response.json()).error.code).toBe('forbidden')
    }
    expect(sourceService.list).not.toHaveBeenCalled()
    expect(sourceService.create).not.toHaveBeenCalled()
    expect(sourceService.get).not.toHaveBeenCalled()
    expect(sourceService.update).not.toHaveBeenCalled()
    expect(sourceService.runTechnicalCheck).not.toHaveBeenCalled()
    expect(sourceService.reviewPolicy).not.toHaveBeenCalled()
    expect(reconciliationService.preview).not.toHaveBeenCalled()
    expect(reconciliationService.execute).not.toHaveBeenCalled()
    expect(sourceService.requestReReview).not.toHaveBeenCalled()
  })

  it('distinguishes unauthenticated 401 from authenticated non-admin 403', async () => {
    const unauthenticated = await fetch(`${origin}/api/v1/admin/sources`)
    const forbidden = await fetch(`${origin}/api/v1/admin/sources`, { headers: { Cookie: `__Host-techpulse_session=${userToken}` } })
    expect(unauthenticated.status).toBe(401)
    expect(forbidden.status).toBe(403)
    expect((await forbidden.json()).error.code).toBe('forbidden')
  })

  it('returns the admin list with no-store and never exposes credential fields', async () => {
    const response = await fetch(`${origin}/api/v1/admin/sources`, { headers: { Cookie: `__Host-techpulse_session=${adminToken}` } })
    const payload = await response.json()
    expect(response.status).toBe(200)
    expect(response.headers.get('cache-control')).toBe('no-store, private')
    expect(payload.data).toHaveLength(1)
    expect(payload.data[0]).toEqual(expect.objectContaining({ id: source.id, sourceKey: source.sourceKey }))
    expect(payload.data[0]).not.toHaveProperty('rightsHolderNote')
    expect(JSON.stringify(payload)).not.toMatch(/password|secret|credential/i)
  })

  it('enforces Origin and CSRF before a source mutation', async () => {
    const response = await fetch(`${origin}/api/v1/admin/sources`, {
      method: 'POST', headers: { Origin: 'http://localhost:3000', Cookie: `__Host-techpulse_session=${adminToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Example', sourceKey: 'rss:example', publisherName: 'Example Publisher', domain: 'example.com', connectorType: 'rss', accessMethod: 'rss', authorityTier: 'editorial', connectorConfig: { kind: 'rss', feedUrl: 'https://example.com/feed.xml', batchSize: 20 } }),
    })
    expect(response.status).toBe(403)
    expect(sourceService.create).not.toHaveBeenCalled()
  })

  it('preserves the canonical 503 when no technical-check adapter exists', async () => {
    const response = await fetch(`${origin}/api/v1/admin/sources/${source.id}/technical-checks`, {
      method: 'POST', headers: { Origin: 'http://localhost:3000', Cookie: `__Host-techpulse_session=${adminToken}`, 'X-CSRF-Token': 'csrf-token', 'Content-Type': 'application/json' },
      body: JSON.stringify({ reasonCode: 'source_technical_check_requested' }),
    })
    expect(response.status).toBe(503)
    expect((await response.json()).error.code).toBe('service_unavailable')
  })
  it('returns a no-store preview and requires CSRF plus idempotency for execution', async () => {
    vi.clearAllMocks()
    const cookie = `__Host-techpulse_session=${adminToken}`
    const preview = await fetch(`${origin}/api/v1/admin/sources/${source.id}/reconciliation?limit=2`, { headers: { Cookie: cookie } })
    expect(preview.status).toBe(200)
    expect(preview.headers.get('cache-control')).toBe('no-store, private')
    expect((await preview.json()).data).toEqual(expect.objectContaining({ mode: 'dry-run', sourceId: source.id }))
    expect(reconciliationService.preview).toHaveBeenCalledWith(expect.objectContaining({ auth: expect.any(Object), sourceId: source.id, limit: '2' }))

    const missingKey = await fetch(`${origin}/api/v1/admin/sources/${source.id}/reconciliation`, {
      method: 'POST', headers: { Origin: 'http://localhost:3000', Cookie: cookie, 'X-CSRF-Token': 'csrf-token', 'Content-Type': 'application/json' },
      body: JSON.stringify({ reasonCode: 'source_policy_reconciliation_requested' }),
    })
    expect(missingKey.status).toBe(400)
    expect(reconciliationService.execute).not.toHaveBeenCalled()

    const executed = await fetch(`${origin}/api/v1/admin/sources/${source.id}/reconciliation`, {
      method: 'POST', headers: { Origin: 'http://localhost:3000', Cookie: cookie, 'X-CSRF-Token': 'csrf-token', 'Content-Type': 'application/json', 'Idempotency-Key': 'source-reconciliation-1' },
      body: JSON.stringify({ reasonCode: 'source_policy_reconciliation_requested', limit: 2, maxPages: 1 }),
    })
    expect(executed.status).toBe(202)
    expect(reconciliationService.execute).toHaveBeenCalledWith(expect.objectContaining({ sourceId: source.id, limit: 2, maxPages: 1, reasonCode: 'source_policy_reconciliation_requested', idempotencyKey: 'source-reconciliation-1' }))
  })
})
