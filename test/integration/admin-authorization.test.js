import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { createApp } from '../../server/app.js'

const adminToken = 'step11-admin-authorization-token'
const userToken = 'step11-user-authorization-token'
const service = { getAdminOverview: vi.fn(async () => ({ activeSources: 0, pausedSources: 0, sourcesNeedingReview: 0, queuedJobs: 0, failedJobs: 0, articlesNeedingReview: 0, failedIndexes: 0, openTakedowns: 0, failedAccountDeletions: 0, lastSuccessfulIngestionAt: null })) }
const authService = {
  authenticate: vi.fn(async ({ token }) => ({
    user: { id: '507f1f77bcf86cd799439001', role: token === adminToken ? 'admin' : 'user', status: 'active' },
    session: { id: '507f1f77bcf86cd799439002', userSessionVersion: 3 },
  })),
  verifyCsrf: vi.fn(async () => false),
}

let server
let origin

beforeAll(async () => {
  server = await new Promise((resolve) => { const listener = createApp({ authService, adminGovernanceService: service }).listen(0, () => resolve(listener)) })
  origin = `http://127.0.0.1:${server.address().port}`
})
afterAll(async () => { await new Promise((resolve) => server.close(resolve)) })

describe('Step 11 admin authorization integration', () => {
  it('does not disclose the admin surface to unauthenticated or non-admin actors', async () => {
    const unauthenticated = await fetch(`${origin}/api/v1/admin/overview`)
    const regularUser = await fetch(`${origin}/api/v1/admin/overview`, { headers: { Cookie: `__Host-techpulse_session=${userToken}` } })
    expect(unauthenticated.status).toBe(401)
    expect(regularUser.status).toBe(403)
    expect(service.getAdminOverview).not.toHaveBeenCalled()
  })

  it('allows the authenticated admin read through the canonical contract boundary', async () => {
    const response = await fetch(`${origin}/api/v1/admin/overview`, { headers: { Cookie: `__Host-techpulse_session=${adminToken}` } })
    expect(response.status).toBe(200)
    expect(response.headers.get('cache-control')).toBe('no-store, private')
    expect(await response.json()).toEqual({ data: expect.objectContaining({ activeSources: 0, openTakedowns: 0 }) })
  })
})
