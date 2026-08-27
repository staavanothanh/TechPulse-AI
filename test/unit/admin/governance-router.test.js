import { describe, expect, it, vi } from 'vitest'
import { createApp } from '../../../server/app.js'

const adminToken = 'admin-governance-session'
const userToken = 'user-governance-session'
const article = { id: '507f1f77bcf86cd799439010', sourceId: '507f1f77bcf86cd799439011', titleOriginal: 'Safe', status: 'published', topics: ['AI'], leadMedia: null, leadMediaStatus: 'none', summaryStatus: 'pending', embeddingStatus: 'pending', embeddingModel: null, embeddingVersion: null, updatedAt: '2026-01-01T00:00:00.000Z' }
const authService = {
  authenticate: vi.fn(async ({ token }) => ({ user: { id: '507f1f77bcf86cd799439001', role: token === adminToken ? 'admin' : 'user', status: 'active' }, session: { id: '507f1f77bcf86cd799439002', userSessionVersion: 1 } })),
  verifyCsrf: vi.fn(async () => true),
}

describe('admin governance HTTP boundaries', () => {
  it('exposes overview, safe articles and audit only to admins', async () => {
    const service = {
      getAdminOverview: vi.fn(async () => ({ activeSources: 1, pausedSources: 0, sourcesNeedingReview: 0, queuedJobs: 0, failedJobs: 0, articlesNeedingReview: 0, failedIndexes: 0, openTakedowns: 0, failedAccountDeletions: 0, lastSuccessfulIngestionAt: null })),
      listAdminArticles: vi.fn(async () => ({ articles: [article], hasNext: false, nextCursor: null })),
      listAuditLogs: vi.fn(async () => ({ logs: [], hasNext: false, nextCursor: null })),
    }
    const app = createApp({ authService, adminGovernanceService: service })
    const server = await new Promise((resolve) => { const listener = app.listen(0, () => resolve(listener)) })
    try {
      const origin = `http://127.0.0.1:${server.address().port}`
      expect((await fetch(`${origin}/api/v1/admin/overview`, { headers: { Cookie: `__Host-techpulse_session=${adminToken}` } })).status).toBe(200)
      const list = await fetch(`${origin}/api/v1/admin/articles?limit=20`, { headers: { Cookie: `__Host-techpulse_session=${adminToken}` } })
      expect(list.status).toBe(200)
      expect((await list.json()).data[0]).not.toHaveProperty('body')
      expect((await fetch(`${origin}/api/v1/admin/audit-logs`, { headers: { Cookie: `__Host-techpulse_session=${userToken}` } })).status).toBe(403)
    } finally { await new Promise((resolve) => server.close(resolve)) }
  })

  it('returns OAuth audit records without failing response validation', async () => {
    const service = {
      listAuditLogs: vi.fn(async () => ({
        logs: [{
          id: '507f1f77bcf86cd799439023', actorType: 'user', actorId: '507f1f77bcf86cd799439013', action: 'google_oauth_login',
          targetType: 'user', targetId: '507f1f77bcf86cd799439013', changedFields: [], stateTransition: null,
          reasonCode: 'google_oauth_login', requestId: 'oauth-audit-contract-0001', result: 'succeeded', createdAt: '2026-01-01T00:00:00.000Z',
        }],
        hasNext: false,
        nextCursor: null,
      })),
    }
    const app = createApp({ authService, adminGovernanceService: service })
    const server = await new Promise((resolve) => { const listener = app.listen(0, () => resolve(listener)) })
    try {
      const origin = `http://127.0.0.1:${server.address().port}`
      const response = await fetch(`${origin}/api/v1/admin/audit-logs`, { headers: { Cookie: `__Host-techpulse_session=${adminToken}` } })
      expect(response.status).toBe(200)
      expect((await response.json()).data[0].reasonCode).toBe('google_oauth_login')
    } finally { await new Promise((resolve) => server.close(resolve)) }
  })

  it('enforces one article mutation category and hidden idempotency for merge', async () => {
    const service = { updateAdminArticle: vi.fn(), mergeDuplicateArticles: vi.fn() }
    const app = createApp({ authService, adminGovernanceService: service })
    const server = await new Promise((resolve) => { const listener = app.listen(0, () => resolve(listener)) })
    try {
      const origin = `http://127.0.0.1:${server.address().port}`
      const headers = { Origin: 'http://localhost:3000', Cookie: `__Host-techpulse_session=${adminToken}`, 'X-CSRF-Token': 'csrf', 'Content-Type': 'application/json' }
      const invalid = await fetch(`${origin}/api/v1/admin/articles/${article.id}`, { method: 'PATCH', headers, body: JSON.stringify({ status: 'hidden', topics: ['AI'], reasonCode: 'article_status_changed' }) })
      expect(invalid.status).toBe(422)
      const missing = await fetch(`${origin}/api/v1/admin/duplicate-merges`, { method: 'POST', headers, body: JSON.stringify({ canonicalArticleId: article.id, duplicateArticleIds: ['507f1f77bcf86cd799439012'], reasonCode: 'duplicate_merge_confirmed' }) })
      expect(missing.status).toBe(400)
      expect(service.updateAdminArticle).not.toHaveBeenCalled()
      expect(service.mergeDuplicateArticles).not.toHaveBeenCalled()
    } finally { await new Promise((resolve) => server.close(resolve)) }
  })

  it('rejects missing or foreign browser Origin before an admin mutation', async () => {
    const service = { updateAdminArticle: vi.fn() }
    const app = createApp({ authService, adminGovernanceService: service })
    const server = await new Promise((resolve) => { const listener = app.listen(0, () => resolve(listener)) })
    try {
      const origin = `http://127.0.0.1:${server.address().port}`
      const baseHeaders = { Cookie: `__Host-techpulse_session=${adminToken}`, 'X-CSRF-Token': 'csrf', 'Content-Type': 'application/json' }
      const body = JSON.stringify({ status: 'hidden', reasonCode: 'article_status_changed' })
      const missing = await fetch(`${origin}/api/v1/admin/articles/${article.id}`, { method: 'PATCH', headers: baseHeaders, body })
      const foreign = await fetch(`${origin}/api/v1/admin/articles/${article.id}`, { method: 'PATCH', headers: { ...baseHeaders, Origin: 'https://foreign.example.test' }, body })
      expect(missing.status).toBe(403)
      expect(foreign.status).toBe(403)
      expect(service.updateAdminArticle).not.toHaveBeenCalled()
    } finally { await new Promise((resolve) => server.close(resolve)) }
  })
})
