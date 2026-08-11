import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import Ajv from 'ajv'
import addFormats from 'ajv-formats'
import { createApp } from '../../server/app.js'
import { loadOpenApi } from '../../scripts/contracts/openapi-utils.js'

const openApi = loadOpenApi()
const ajv = new Ajv({ strict: false, allErrors: true })
addFormats(ajv)
for (const [name, schema] of Object.entries(openApi.components.schemas)) ajv.addSchema(schema, `#/components/schemas/${name}`)
const validateJob = ajv.compile({ $ref: '#/components/schemas/IndexingJobResponse' })
const validateList = ajv.compile({ $ref: '#/components/schemas/IndexingJobListResponse' })

const adminToken = 'step9-admin-session'
const userToken = 'step9-user-session'
const job = {
  id: '64d2f4bda57d0c1d2c38f100', idempotencyKey: 'step9-indexing-key-0001', articleId: '64d2f4bda57d0c1d2c38f020', sourceId: '64d2f4bda57d0c1d2c38f010',
  expectedSourcePolicyVersion: 2, task: 'embedding', trigger: 'admin', status: 'queued', attempt: 1,
  availableAt: '2026-08-10T00:00:00.000Z', leaseGeneration: 0, parentJobId: null, error: null,
  createdAt: '2026-08-10T00:00:00.000Z', startedAt: null, finishedAt: null,
  actorScope: 'must-not-leak', requestHash: 'must-not-leak', inputHash: 'must-not-leak', targetEmbeddingVersion: 1,
}
const authService = {
  authenticate: vi.fn(async ({ token }) => ({
    user: { id: '64d2f4bda57d0c1d2c38f001', role: token === adminToken ? 'admin' : 'user', status: 'active' },
    session: { _id: '64d2f4bda57d0c1d2c38f002', userSessionVersion: 0 },
  })),
  verifyCsrf: vi.fn(async () => true),
}
const indexingJobService = {
  listIndexingJobs: vi.fn(async () => ({ jobs: [job], hasNext: false, nextCursor: null })),
  getIndexingJob: vi.fn(async () => job), createSummaryJob: vi.fn(async () => ({ ...job, task: 'summary' })),
  createIndexingJob: vi.fn(async () => job), retryIndexingJob: vi.fn(async () => ({ ...job, trigger: 'retry', attempt: 2, parentJobId: job.id })),
  cancelIndexingJob: vi.fn(async () => ({ ...job, status: 'cancelled', finishedAt: '2026-08-10T00:01:00.000Z' })),
}
let server
let origin

beforeAll(async () => {
  const app = createApp({ authService, indexingJobService })
  server = await new Promise((resolve) => { const listener = app.listen(0, () => resolve(listener)) })
  origin = `http://127.0.0.1:${server.address().port}`
})
afterAll(async () => { if (server) await new Promise((resolve) => server.close(resolve)) })

describe('Step 9 six canonical indexing admin operations', () => {
  it('serializes list/detail without model, vector, hash, provider or target version', async () => {
    const cookie = { Cookie: `__Host-techpulse_session=${adminToken}` }
    const listResponse = await fetch(`${origin}/api/v1/admin/indexing-jobs?task=embedding&status=queued`, { headers: cookie })
    const list = await listResponse.json()
    expect(listResponse.status).toBe(200)
    expect(validateList(list), JSON.stringify(validateList.errors)).toBe(true)
    const detailResponse = await fetch(`${origin}/api/v1/admin/indexing-jobs/${job.id}`, { headers: cookie })
    const detail = await detailResponse.json()
    expect(detailResponse.status).toBe(200)
    expect(validateJob(detail), JSON.stringify(validateJob.errors)).toBe(true)
    expect(JSON.stringify(detail)).not.toMatch(/actorScope|requestHash|inputHash|targetEmbeddingVersion|embeddingModel|provider|vector/)
  })

  it('implements create-summary, create-indexing, retry and cancellation with exact bodies', async () => {
    const headers = { Origin: 'http://localhost:3000', Cookie: `__Host-techpulse_session=${adminToken}`, 'X-CSRF-Token': 'csrf', 'Content-Type': 'application/json' }
    const summary = await fetch(`${origin}/api/v1/admin/articles/${job.articleId}/summary-jobs`, { method: 'POST', headers: { ...headers, 'Idempotency-Key': 'step9-summary-create-key' }, body: JSON.stringify({ reasonCode: 'artifact_regeneration_requested' }) })
    expect(summary.status).toBe(202)
    expect(validateJob(await summary.json())).toBe(true)
    const embedding = await fetch(`${origin}/api/v1/admin/articles/${job.articleId}/indexing-jobs`, { method: 'POST', headers: { ...headers, 'Idempotency-Key': 'step9-embedding-create-key' }, body: JSON.stringify({ task: 'embedding', reasonCode: 'artifact_regeneration_requested' }) })
    expect(embedding.status).toBe(202)
    const retry = await fetch(`${origin}/api/v1/admin/indexing-jobs/${job.id}/retries`, { method: 'POST', headers: { ...headers, 'Idempotency-Key': 'step9-indexing-retry-key' }, body: JSON.stringify({ reasonCode: 'job_retry_requested' }) })
    expect(retry.status).toBe(202)
    const cancel = await fetch(`${origin}/api/v1/admin/indexing-jobs/${job.id}/cancellation`, { method: 'POST', headers, body: JSON.stringify({ reasonCode: 'job_cancel_requested' }) })
    expect(cancel.status).toBe(200)
    expect(indexingJobService.createSummaryJob).toHaveBeenCalledWith(expect.objectContaining({ articleId: job.articleId, idempotencyKey: 'step9-summary-create-key' }))
    expect(indexingJobService.createIndexingJob).toHaveBeenCalledWith(expect.objectContaining({ input: { task: 'embedding', reasonCode: 'artifact_regeneration_requested' } }))
  })

  it('keeps admin, CSRF, schema and idempotency checks fail closed', async () => {
    const regular = await fetch(`${origin}/api/v1/admin/articles/${job.articleId}/summary-jobs`, { method: 'POST', headers: { Origin: 'http://localhost:3000', Cookie: `__Host-techpulse_session=${userToken}`, 'X-CSRF-Token': 'csrf', 'Idempotency-Key': 'step9-summary-user-key', 'Content-Type': 'application/json' }, body: JSON.stringify({ reasonCode: 'artifact_regeneration_requested' }) })
    expect(regular.status).toBe(403)
    const missingKey = await fetch(`${origin}/api/v1/admin/articles/${job.articleId}/summary-jobs`, { method: 'POST', headers: { Origin: 'http://localhost:3000', Cookie: `__Host-techpulse_session=${adminToken}`, 'X-CSRF-Token': 'csrf', 'Content-Type': 'application/json' }, body: JSON.stringify({ reasonCode: 'artifact_regeneration_requested' }) })
    expect(missingKey.status).toBe(400)
    const invalidTask = await fetch(`${origin}/api/v1/admin/articles/${job.articleId}/indexing-jobs`, { method: 'POST', headers: { Origin: 'http://localhost:3000', Cookie: `__Host-techpulse_session=${adminToken}`, 'X-CSRF-Token': 'csrf', 'Idempotency-Key': 'step9-invalid-task-key', 'Content-Type': 'application/json' }, body: JSON.stringify({ task: 'summary', reasonCode: 'artifact_regeneration_requested' }) })
    expect(invalidTask.status).toBe(422)
  })
})
