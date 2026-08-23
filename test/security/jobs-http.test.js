import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import Ajv from 'ajv'
import addFormats from 'ajv-formats'
import { createApp } from '../../server/app.js'
import { loadOpenApi } from '../../scripts/contracts/openapi-utils.js'
import { JobError } from '../../server/application/jobs/service.js'

const openApi = loadOpenApi()
const ajv = new Ajv({ strict: false, allErrors: true })
addFormats(ajv)
for (const [name, schema] of Object.entries(openApi.components.schemas)) ajv.addSchema(schema, `#/components/schemas/${name}`)
const validateJob = ajv.compile({ $ref: '#/components/schemas/IngestionJobResponse' })
const validateJobList = ajv.compile({ $ref: '#/components/schemas/IngestionJobListResponse' })
const validateCron = ajv.compile({ $ref: '#/components/schemas/CronRunResponse' })
const validateMaintenance = ajv.compile({ $ref: '#/components/schemas/MaintenanceRunResponse' })

const adminToken = 'step4-admin-session'
const userToken = 'step4-user-session'
const job = {
  id: '64d2f4bda57d0c1d2c38f100', idempotencyKey: 'step4-job-key-0001', sourceId: '64d2f4bda57d0c1d2c38f010', connectorType: 'rss',
  expectedSourcePolicyVersion: 2, trigger: 'admin', status: 'queued', attempt: 1, availableAt: '2026-08-10T00:00:00.000Z', leaseGeneration: 0,
  batchSize: 20, parentJobId: null, counters: { fetched: 0, created: 0, updated: 0, duplicate: 0, skipped: 0, failed: 0 }, error: null,
  createdAt: '2026-08-10T00:00:00.000Z', startedAt: null, finishedAt: null, actorScope: 'must-not-leak', requestHash: 'must-not-leak',
}
const authService = {
  authenticate: vi.fn(async ({ token }) => ({
    user: { id: '64d2f4bda57d0c1d2c38f001', role: token === adminToken ? 'admin' : 'user', status: 'active' },
    session: { _id: '64d2f4bda57d0c1d2c38f002', userSessionVersion: 0 },
  })),
  verifyCsrf: vi.fn(async () => true),
}
const jobService = {
  listIngestionJobs: vi.fn(async () => ({ jobs: [job], hasNext: false, nextCursor: null })),
  getIngestionJob: vi.fn(async () => job), createIngestionJob: vi.fn(async () => job), retryIngestionJob: vi.fn(async () => job), cancelIngestionJob: vi.fn(async () => job),
  runDueWork: vi.fn(async () => ({
    runId: 'run-admin-step4', startedAt: new Date('2026-08-10T00:00:00.000Z'), finishedAt: new Date('2026-08-10T00:00:01.000Z'),
    recovery: { inspected: 0, recovered: 0, retriesCreated: 0, failed: 0 },
    queues: {
      ingestion: { claimed: 1, succeeded: 1, partial: 0, failed: 0, deferred: 0 },
      indexing: { claimed: 1, succeeded: 1, partial: 0, failed: 0, deferred: 0 },
      accountDeletion: { claimed: 0, succeeded: 0, partial: 0, failed: 0, deferred: 0 },
    }, nextAvailableAt: null, privateDiagnostic: 'must-not-leak',
  })),
}
const dueWorkRunner = vi.fn(async () => ({
  runId: 'run-step4', startedAt: new Date('2026-08-10T00:00:00.000Z'), finishedAt: new Date('2026-08-10T00:00:01.000Z'),
  recovery: { inspected: 0, recovered: 0, retriesCreated: 0, failed: 0 },
  queues: {
    ingestion: { claimed: 1, succeeded: 0, partial: 0, failed: 0, deferred: 1 },
    indexing: { claimed: 0, succeeded: 0, partial: 0, failed: 0, deferred: 0 },
    accountDeletion: { claimed: 0, succeeded: 0, partial: 0, failed: 0, deferred: 0 },
  }, nextAvailableAt: new Date('2026-08-10T00:10:00.000Z'),
}))
const maintenanceRunner = { run: vi.fn(async () => ({ taskName: 'purge-ingestion-jobs', inspected: 2, affected: 1, hasMore: false, completedAt: new Date('2026-08-10T00:00:00.000Z') })) }
let server
let origin

beforeAll(async () => {
  const app = createApp({ authService, jobService, dueWorkRunner, maintenanceRunner, machineSecret: 'step4-machine-secret' })
  server = await new Promise((resolve) => { const listener = app.listen(0, () => resolve(listener)) })
  origin = `http://127.0.0.1:${server.address().port}`
})
afterAll(async () => { if (server) await new Promise((resolve) => server.close(resolve)) })

describe('Step 4 jobs, cron and maintenance HTTP boundaries', () => {
  it('serializes job responses without internal identity fields', async () => {
    const response = await fetch(`${origin}/api/v1/admin/ingestion-jobs/${job.id}`, { headers: { Cookie: `__Host-techpulse_session=${adminToken}` } })
    const payload = await response.json()
    expect(response.status).toBe(200)
    expect(validateJob(payload), JSON.stringify(validateJob.errors)).toBe(true)
    expect(payload.data).not.toHaveProperty('actorScope')
    expect(payload.data).not.toHaveProperty('requestHash')
    expect(response.headers.get('cache-control')).toBe('no-store, private')
  })

  it('does not serialize arbitrary persisted job diagnostic text', async () => {
    jobService.getIngestionJob.mockResolvedValueOnce({ ...job, status: 'failed', error: { code: 'private', message: 'mongodb://user:secret@private/db', retryable: true, occurredAt: '2026-08-10T00:00:00.000Z' } })
    const response = await fetch(`${origin}/api/v1/admin/ingestion-jobs/${job.id}`, { headers: { Cookie: `__Host-techpulse_session=${adminToken}` } })
    const payload = await response.json()
    expect(response.status).toBe(200)
    expect(payload.data.error.message).toBe('Ingestion job did not complete safely')
    expect(JSON.stringify(payload)).not.toContain('secret')
    expect(JSON.stringify(payload)).not.toContain('mongodb://')
  })

  it('enforces admin, CSRF and Idempotency-Key on manual job creation', async () => {
    const regular = await fetch(`${origin}/api/v1/admin/ingestion-jobs`, { method: 'POST', headers: { Origin: 'http://localhost:3000', Cookie: `__Host-techpulse_session=${userToken}`, 'X-CSRF-Token': 'csrf', 'Idempotency-Key': 'step4-job-key-0002', 'Content-Type': 'application/json' }, body: JSON.stringify({ sourceId: job.sourceId }) })
    expect(regular.status).toBe(403)
    const missingKey = await fetch(`${origin}/api/v1/admin/ingestion-jobs`, { method: 'POST', headers: { Origin: 'http://localhost:3000', Cookie: `__Host-techpulse_session=${adminToken}`, 'X-CSRF-Token': 'csrf', 'Content-Type': 'application/json' }, body: JSON.stringify({ sourceId: job.sourceId }) })
    expect(missingKey.status).toBe(400)
    expect(jobService.createIngestionJob).not.toHaveBeenCalled()
  })

  it('serializes list/create/retry/cancel success paths and validates bodies', async () => {
    const cookie = `__Host-techpulse_session=${adminToken}`
    const headers = { Origin: 'http://localhost:3000', Cookie: cookie, 'X-CSRF-Token': 'csrf', 'Content-Type': 'application/json' }
    const listResponse = await fetch(`${origin}/api/v1/admin/ingestion-jobs?status=queued&limit=20`, { headers: { Cookie: cookie } })
    const listPayload = await listResponse.json()
    expect(listResponse.status).toBe(200)
    expect(validateJobList(listPayload), JSON.stringify(validateJobList.errors)).toBe(true)

    const createResponse = await fetch(`${origin}/api/v1/admin/ingestion-jobs`, { method: 'POST', headers: { ...headers, 'Idempotency-Key': 'step4-valid-create-key' }, body: JSON.stringify({ sourceId: job.sourceId, batchSize: 20 }) })
    expect(createResponse.status).toBe(202)
    expect(validateJob(await createResponse.json())).toBe(true)
    const retryResponse = await fetch(`${origin}/api/v1/admin/ingestion-jobs/${job.id}/retries`, { method: 'POST', headers: { ...headers, 'Idempotency-Key': 'step4-valid-retry-key' }, body: JSON.stringify({ reasonCode: 'job_retry_requested' }) })
    expect(retryResponse.status).toBe(202)
    const cancelResponse = await fetch(`${origin}/api/v1/admin/ingestion-jobs/${job.id}/cancellation`, { method: 'POST', headers, body: JSON.stringify({ reasonCode: 'job_cancel_requested' }) })
    expect(cancelResponse.status).toBe(200)
    expect(jobService.createIngestionJob).toHaveBeenCalledWith(expect.objectContaining({ idempotencyKey: 'step4-valid-create-key' }))
    expect(jobService.retryIngestionJob).toHaveBeenCalledWith(expect.objectContaining({ reasonCode: 'job_retry_requested' }))
    expect(jobService.cancelIngestionJob).toHaveBeenCalledWith(expect.objectContaining({ reasonCode: 'job_cancel_requested' }))

    const invalid = await fetch(`${origin}/api/v1/admin/ingestion-jobs/${job.id}/cancellation`, { method: 'POST', headers, body: JSON.stringify({ reasonCode: 'wrong' }) })
    expect(invalid.status).toBe(422)
  })

  it('accepts only the dedicated bearer on cron and emits all fixed summaries', async () => {
    const adminCookie = await fetch(`${origin}/api/internal/cron/due-work`, { headers: { Cookie: `__Host-techpulse_session=${adminToken}` } })
    expect(adminCookie.status).toBe(401)
    const response = await fetch(`${origin}/api/internal/cron/due-work`, { headers: { Authorization: 'Bearer step4-machine-secret' } })
    const payload = await response.json()
    expect(response.status).toBe(202)
    expect(validateCron(payload), JSON.stringify(validateCron.errors)).toBe(true)
    expect(Object.keys(payload.data.queues)).toEqual(['ingestion', 'indexing', 'accountDeletion'])
  })

  it('lets an admin with CSRF run bounded due work without exposing the cron bearer', async () => {
    const headers = {
      Origin: 'http://localhost:3000',
      Cookie: `__Host-techpulse_session=${adminToken}`,
      'X-CSRF-Token': 'csrf',
    }
    const response = await fetch(`${origin}/api/v1/admin/due-work-runs`, { method: 'POST', headers })
    const payload = await response.json()

    expect(response.status).toBe(202)
    expect(validateCron(payload), JSON.stringify(validateCron.errors)).toBe(true)
    expect(payload.data.runId).toBe('run-admin-step4')
    expect(payload.data).not.toHaveProperty('privateDiagnostic')
    expect(response.headers.get('cache-control')).toBe('no-store, private')
    expect(jobService.runDueWork).toHaveBeenCalledWith(expect.objectContaining({ auth: expect.objectContaining({ user: expect.objectContaining({ role: 'admin' }) }) }))

    jobService.runDueWork.mockClear()
    const regular = await fetch(`${origin}/api/v1/admin/due-work-runs`, {
      method: 'POST',
      headers: { ...headers, Cookie: `__Host-techpulse_session=${userToken}` },
    })
    expect(regular.status).toBe(403)
    expect(jobService.runDueWork).not.toHaveBeenCalled()

    const polluted = await fetch(`${origin}/api/v1/admin/due-work-runs`, {
      method: 'POST',
      headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({ maxJobs: 100 }),
    })
    expect(polluted.status).toBe(422)
    expect(jobService.runDueWork).not.toHaveBeenCalled()

    jobService.runDueWork.mockRejectedValueOnce(new JobError(429, 'rate_limit_exceeded', 'Request rate limit exceeded', { retryAfter: 41 }))
    const limited = await fetch(`${origin}/api/v1/admin/due-work-runs`, { method: 'POST', headers })
    expect(limited.status).toBe(429)
    expect(limited.headers.get('retry-after')).toBe('41')
  })

  it('fails closed for machine-route aliases before a runner can execute', async () => {
    dueWorkRunner.mockClear()
    maintenanceRunner.run.mockClear()
    for (const request of [
      fetch(`${origin}/api/internal/cron/due-work`, { method: 'HEAD' }),
      fetch(`${origin}/api/internal/cron/due-work/`),
      fetch(`${origin}/api/internal/maintenance/purge-ingestion-jobs/`),
      fetch(`${origin}/api/internal/unknown`),
    ]) {
      const response = await request
      expect([401, 404, 405]).toContain(response.status)
    }
    expect(dueWorkRunner).not.toHaveBeenCalled()
    expect(maintenanceRunner.run).not.toHaveBeenCalled()
    maintenanceRunner.run.mockClear()
  })

  it('rejects caller maintenance predicates and returns a safe fixed-task aggregate', async () => {
    const rejected = await fetch(`${origin}/api/internal/maintenance/purge-ingestion-jobs?filter=all`, { headers: { Authorization: 'Bearer step4-machine-secret' } })
    expect(rejected.status).toBe(400)
    expect(maintenanceRunner.run).not.toHaveBeenCalled()
    const response = await fetch(`${origin}/api/internal/maintenance/purge-ingestion-jobs`, { headers: { Authorization: 'Bearer step4-machine-secret' } })
    const payload = await response.json()
    expect(response.status).toBe(202)
    expect(validateMaintenance(payload), JSON.stringify(validateMaintenance.errors)).toBe(true)
    expect(payload.data).not.toHaveProperty('cursor')
  })

  it('keeps every Step 11 maintenance task behind the fixed machine boundary', async () => {
    for (const taskName of ['purge-takedown-pii', 'purge-takedown-workflows', 'purge-account-deletion-workflows', 'purge-audit-ip-hmac']) {
      maintenanceRunner.run.mockClear()
      const browser = await fetch(`${origin}/api/internal/maintenance/${taskName}`, { headers: { Cookie: `__Host-techpulse_session=${adminToken}` } })
      expect(browser.status).toBe(401)
      expect(maintenanceRunner.run).not.toHaveBeenCalled()

      const polluted = await fetch(`${origin}/api/internal/maintenance/${taskName}?cutoff=2099-01-01`, { headers: { Authorization: 'Bearer step4-machine-secret' } })
      expect(polluted.status).toBe(400)
      expect(maintenanceRunner.run).not.toHaveBeenCalled()
    }
  })

  it('does not widen the fixed maintenance boundary through method, path or bearer variants', async () => {
    for (const taskName of ['purge-takedown-pii', 'purge-takedown-workflows', 'purge-account-deletion-workflows', 'purge-audit-ip-hmac']) {
      maintenanceRunner.run.mockClear()
      const requests = [
        fetch(`${origin}/api/internal/maintenance/${taskName}`, { method: 'POST', headers: { Authorization: 'Bearer step4-machine-secret' } }),
        fetch(`${origin}/api/internal/maintenance/${taskName}/`, { headers: { Authorization: 'Bearer step4-machine-secret' } }),
        fetch(`${origin}/api/internal/maintenance/${taskName}`, { headers: { Authorization: 'Bearer step4-machine-secret-invalid' } }),
      ]
      for (const request of requests) expect([400, 401, 404, 405]).toContain((await request).status)
      expect(maintenanceRunner.run).not.toHaveBeenCalled()
    }
  })

  it('preserves fixed future-task conflict and unavailable-service failures', async () => {
    maintenanceRunner.run.mockRejectedValueOnce(Object.assign(new Error('not registered'), { status: 409, code: 'conflict' }))
    const future = await fetch(`${origin}/api/internal/maintenance/purge-indexing-jobs`, { headers: { Authorization: 'Bearer step4-machine-secret' } })
    expect(future.status).toBe(409)
    const unavailableApp = createApp({ authService, machineSecret: 'step4-machine-secret' })
    const listener = await new Promise((resolve) => { const instance = unavailableApp.listen(0, () => resolve(instance)) })
    try {
      const unavailableOrigin = `http://127.0.0.1:${listener.address().port}`
      const response = await fetch(`${unavailableOrigin}/api/v1/admin/ingestion-jobs`, { headers: { Cookie: `__Host-techpulse_session=${adminToken}` } })
      expect(response.status).toBe(503)
    } finally { await new Promise((resolve) => listener.close(resolve)) }
  })
})
