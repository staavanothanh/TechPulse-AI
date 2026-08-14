import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { createApp } from '../../server/app.js'

const token = 'step11-admin-redaction-token'
const authService = {
  authenticate: vi.fn(async () => ({ user: { id: '507f1f77bcf86cd799439001', role: 'admin', status: 'active' }, session: { id: '507f1f77bcf86cd799439002', userSessionVersion: 2 } })),
  verifyCsrf: vi.fn(async () => true),
}
const privateFields = {
  rawHtml: '<script>secret</script>', vector: [0.1, 0.2], embeddingInput: 'private corpus', providerPayload: { prompt: 'secret' }, requesterContact: 'private@example.com', question: 'private question', stack: 'private stack', arbitraryDiagnostic: 'private debug',
}
const overview = { activeSources: 1, pausedSources: 0, sourcesNeedingReview: 0, queuedJobs: 0, failedJobs: 0, articlesNeedingReview: 0, failedIndexes: 0, openTakedowns: 1, failedAccountDeletions: 0, lastSuccessfulIngestionAt: null }
const service = {
  getAdminOverview: vi.fn(async () => ({ ...overview, ...privateFields })),
  listTakedownRequests: vi.fn(async () => ({ requests: [{ id: '507f1f77bcf86cd799439010', status: 'reviewing', targetType: 'article', targetIds: ['507f1f77bcf86cd799439011'], requestedScope: ['summary'], createdAt: '2026-08-13T00:00:00.000Z', updatedAt: '2026-08-13T00:00:00.000Z', ...privateFields }], hasNext: false, nextCursor: null })),
}

let server
let origin
beforeAll(async () => {
  server = await new Promise((resolve) => { const listener = createApp({ authService, adminGovernanceService: service }).listen(0, () => resolve(listener)) })
  origin = `http://127.0.0.1:${server.address().port}`
})
afterAll(async () => { await new Promise((resolve) => server.close(resolve)) })

describe('Step 11 admin redaction boundary', () => {
  it('fails closed instead of serializing non-contract overview diagnostics', async () => {
    const response = await fetch(`${origin}/api/v1/admin/overview`, { headers: { Cookie: `__Host-techpulse_session=${token}` } })
    const payload = await response.json()
    expect(response.status).toBe(500)
    expect(payload.error).toEqual(expect.objectContaining({ code: 'internal_error' }))
    expect(JSON.stringify(payload)).not.toContain('private')
    expect(JSON.stringify(payload)).not.toContain('secret')
  })

  it('fails closed when a summary repository attempts to attach requester or content data', async () => {
    const response = await fetch(`${origin}/api/v1/admin/takedown-requests`, { headers: { Cookie: `__Host-techpulse_session=${token}` } })
    const payload = await response.json()
    expect(response.status).toBe(500)
    expect(payload.error.code).toBe('internal_error')
    for (const forbidden of ['requesterContact', 'rawHtml', 'vector', 'question', 'stack']) expect(JSON.stringify(payload)).not.toContain(forbidden)
  })
})
