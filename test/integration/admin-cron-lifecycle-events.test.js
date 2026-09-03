import { describe, expect, it, vi } from 'vitest'
import Ajv from 'ajv'
import addFormats from 'ajv-formats'
import { createApp } from '../../server/app.js'
import { loadOpenApi } from '../../scripts/contracts/openapi-utils.js'

const openApi = loadOpenApi()
const ajv = new Ajv({ strict: false, allErrors: true })
addFormats(ajv)
for (const [name, schema] of Object.entries(openApi.components.schemas)) {
  ajv.addSchema(schema, `#/components/schemas/${name}`)
}
const validateEventList = ajv.compile({ $ref: '#/components/schemas/CronLifecycleEventListResponse' })

const adminToken = 'admin-session-test'
const userToken = 'user-session-test'

const authService = {
  authenticate: vi.fn(async ({ token }) => ({
    user: { id: '507f1f77bcf86cd799439001', role: token === adminToken ? 'admin' : 'user', status: 'active' },
    session: { _id: '507f1f77bcf86cd799439002', userSessionVersion: 1 },
  })),
  verifyCsrf: vi.fn(async () => true),
}

const eventItem = {
  eventId: 'e'.repeat(64),
  runId: 'cron-run-001',
  queueName: 'indexing',
  task: 'summary',
  jobId: '507f1f77bcf86cd799439011',
  articleId: '507f1f77bcf86cd799439012',
  sourceId: '507f1f77bcf86cd799439013',
  sourceKey: 'rss:vnexpress',
  leaseGeneration: 1,
  stage: 'indexing.executor',
  eventType: 'phase',
  status: 'succeeded',
  elapsedMs: 350,
  occurredAt: '2026-09-03T10:00:00.000Z',
  counters: { fetched: 1 },
  error: null,
}

const cronEventRepository = {
  listLifecycleEvents: vi.fn(async () => ({
    events: [eventItem],
    hasNext: false,
    nextCursor: null,
  })),
}

describe('admin cron lifecycle events HTTP endpoint integration', () => {
  it('blocks non-admin users with 403 Forbidden', async () => {
    const app = createApp({ authService, cronEventRepository })
    const server = await new Promise((res) => { const l = app.listen(0, () => res(l)) })
    const origin = `http://127.0.0.1:${server.address().port}`
    try {
      const response = await fetch(`${origin}/api/v1/admin/cron-lifecycle-events`, {
        headers: { Cookie: `__Host-techpulse_session=${userToken}` },
      })
      expect(response.status).toBe(403)
    } finally {
      await new Promise((res) => server.close(res))
    }
  })

  it('allows admin users and returns valid CronLifecycleEventListResponse matching OpenAPI', async () => {
    const app = createApp({ authService, cronEventRepository })
    const server = await new Promise((res) => { const l = app.listen(0, () => res(l)) })
    const origin = `http://127.0.0.1:${server.address().port}`
    try {
      const response = await fetch(`${origin}/api/v1/admin/cron-lifecycle-events?runId=cron-run-001&limit=10`, {
        headers: { Cookie: `__Host-techpulse_session=${adminToken}` },
      })
      expect(response.status).toBe(200)
      const payload = await response.json()
      expect(validateEventList(payload), JSON.stringify(validateEventList.errors)).toBe(true)
      expect(payload.data).toHaveLength(1)
      expect(payload.data[0].eventId).toBe('e'.repeat(64))
      expect(payload.data[0].runId).toBe('cron-run-001')
      expect(response.headers.get('cache-control')).toBe('no-store, private')
    } finally {
      await new Promise((res) => server.close(res))
    }
  })

  it('returns 503 when lifecycle observability is not ready', async () => {
    const app = createApp({ authService })
    const server = await new Promise((res) => { const l = app.listen(0, () => res(l)) })
    const origin = `http://127.0.0.1:${server.address().port}`
    try {
      const response = await fetch(`${origin}/api/v1/admin/cron-lifecycle-events`, {
        headers: { Cookie: `__Host-techpulse_session=${adminToken}` },
      })
      expect(response.status).toBe(503)
      expect((await response.json()).error.code).toBe('service_unavailable')
    } finally {
      await new Promise((res) => server.close(res))
    }
  })
})
