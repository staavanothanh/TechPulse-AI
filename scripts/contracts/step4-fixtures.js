import http from 'node:http'
import Ajv from 'ajv'
import addFormats from 'ajv-formats'
import { createApp } from '../../server/app.js'
import { JobError } from '../../server/application/jobs/service.js'
import { collectOperations, dereference } from './openapi-utils.js'

const NOW = '2026-08-10T00:00:00.000Z'
const ADMIN_TOKEN = 'step4-contract-admin-session'
const USER_TOKEN = 'step4-contract-user-session'
const CSRF_TOKEN = 'step4-contract-csrf'
const MACHINE_TOKEN = 'step4-contract-machine'
const JOB_ID = '507f1f77bcf86cd799439021'
const SOURCE_ID = '507f1f77bcf86cd799439011'
const JOB = Object.freeze({
  id: JOB_ID, idempotencyKey: 'step4-contract-job-key', sourceId: SOURCE_ID, connectorType: 'rss', expectedSourcePolicyVersion: 2,
  trigger: 'admin', status: 'queued', attempt: 1, availableAt: NOW, leaseGeneration: 0, batchSize: 20, parentJobId: null,
  counters: { fetched: 0, created: 0, updated: 0, duplicate: 0, skipped: 0, failed: 0 }, error: null,
  createdAt: NOW, startedAt: null, finishedAt: null,
})

function responseValidator(document) {
  const ajv = new Ajv({ allErrors: true, strict: false })
  addFormats(ajv)
  ajv.addSchema({ ...document, $id: 'techpulse-openapi-step4' })
  const operations = new Map(collectOperations(document).map(({ operation }) => [operation.operationId, operation]))
  return (operationId, status, body) => {
    const response = dereference(document, operations.get(operationId)?.responses?.[String(status)])
    const schema = response?.content?.['application/json']?.schema
    if (!schema) throw new Error(`No JSON schema for ${operationId} ${status}`)
    const validate = ajv.compile(schema.$ref ? { $ref: `techpulse-openapi-step4${schema.$ref}` } : schema)
    if (!validate(body)) throw new Error(`Invalid ${operationId} ${status}: ${ajv.errorsText(validate.errors)}`)
  }
}

function services() {
  const authService = {
    async authenticate({ token }) {
      if (![ADMIN_TOKEN, USER_TOKEN].includes(token)) throw new JobError(401, 'unauthorized', 'Session is invalid')
      return { user: { id: '507f1f77bcf86cd799439012', role: token === ADMIN_TOKEN ? 'admin' : 'user', status: 'active' }, session: { _id: '507f1f77bcf86cd799439013', userSessionVersion: 0 } }
    },
    async verifyCsrf({ token }) { if (token !== CSRF_TOKEN) throw new JobError(403, 'csrf_invalid', 'CSRF token is invalid') },
  }
  const jobService = {
    async listIngestionJobs() { return { jobs: [JOB], hasNext: false, nextCursor: null } },
    async getIngestionJob({ jobId }) { if (jobId === 'bad-id') throw new JobError(400, 'bad_request', 'Job id is invalid'); if (jobId === '507f1f77bcf86cd799439099') throw new JobError(404, 'not_found', 'Job not found'); return JOB },
    async createIngestionJob({ idempotencyKey }) { if (idempotencyKey === 'step4-conflict-job-key') throw new JobError(409, 'idempotency_mismatch', 'Idempotency mismatch'); return JOB },
    async retryIngestionJob({ jobId }) { if (jobId === '507f1f77bcf86cd799439098') throw new JobError(409, 'conflict', 'Job is not retryable'); return { ...JOB, trigger: 'retry', attempt: 2, parentJobId: JOB_ID } },
    async cancelIngestionJob() { return { ...JOB, status: 'cancelled', finishedAt: NOW } },
  }
  const dueWorkRunner = async () => ({
    runId: 'contract-run-step4', startedAt: new Date(NOW), finishedAt: new Date(NOW),
    recovery: { inspected: 0, recovered: 0, retriesCreated: 0, failed: 0 },
    queues: {
      ingestion: { claimed: 1, succeeded: 0, partial: 0, failed: 0, deferred: 1 },
      indexing: { claimed: 0, succeeded: 0, partial: 0, failed: 0, deferred: 0 },
      accountDeletion: { claimed: 0, succeeded: 0, partial: 0, failed: 0, deferred: 0 },
    }, nextAvailableAt: null,
  })
  const maintenanceRunner = { async run(taskName) {
    if (taskName !== 'purge-ingestion-jobs') throw new JobError(409, 'conflict', 'Task is not registered')
    return { taskName, inspected: 1, affected: 1, hasMore: false, completedAt: new Date(NOW) }
  } }
  return { authService, jobService, dueWorkRunner, maintenanceRunner, machineSecret: MACHINE_TOKEN }
}

async function start(app) {
  const server = http.createServer(app)
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  return server
}

export async function runStep4ContractFixtures({ document } = {}) {
  if (!document) throw new Error('OpenAPI document is required')
  const validate = responseValidator(document)
  const server = await start(createApp(services()))
  const origin = `http://127.0.0.1:${server.address().port}`
  const adminCookie = `__Host-techpulse_session=${ADMIN_TOKEN}`
  const userCookie = `__Host-techpulse_session=${USER_TOKEN}`
  const jsonHeaders = { Origin: 'http://localhost:3000', Cookie: adminCookie, 'X-CSRF-Token': CSRF_TOKEN, 'Content-Type': 'application/json' }
  let cases = 0
  const request = async (operationId, path, init, expected) => {
    const response = await globalThis.fetch(`${origin}${path}`, init)
    const body = await response.json()
    if (response.status !== expected) throw new Error(`${operationId} expected ${expected}, got ${response.status}`)
    validate(operationId, expected, body)
    cases += 1
  }
  try {
    await request('listIngestionJobs', '/api/v1/admin/ingestion-jobs', { headers: { Cookie: adminCookie } }, 200)
    await request('listIngestionJobs', '/api/v1/admin/ingestion-jobs?status=unknown', { headers: { Cookie: adminCookie } }, 400)
    await request('listIngestionJobs', '/api/v1/admin/ingestion-jobs', { headers: { Cookie: userCookie } }, 403)
    await request('createIngestionJob', '/api/v1/admin/ingestion-jobs', { method: 'POST', headers: { ...jsonHeaders, 'Idempotency-Key': 'step4-create-job-key' }, body: JSON.stringify({ sourceId: SOURCE_ID, batchSize: 20 }) }, 202)
    await request('createIngestionJob', '/api/v1/admin/ingestion-jobs', { method: 'POST', headers: { ...jsonHeaders, 'Idempotency-Key': 'step4-create-job-key' }, body: JSON.stringify({ sourceId: SOURCE_ID, unexpected: true }) }, 422)
    await request('createIngestionJob', '/api/v1/admin/ingestion-jobs', { method: 'POST', headers: { ...jsonHeaders, 'Idempotency-Key': 'step4-conflict-job-key' }, body: JSON.stringify({ sourceId: SOURCE_ID }) }, 409)
    await request('getIngestionJob', `/api/v1/admin/ingestion-jobs/${JOB_ID}`, { headers: { Cookie: adminCookie } }, 200)
    await request('getIngestionJob', '/api/v1/admin/ingestion-jobs/bad-id', { headers: { Cookie: adminCookie } }, 400)
    await request('getIngestionJob', '/api/v1/admin/ingestion-jobs/507f1f77bcf86cd799439099', { headers: { Cookie: adminCookie } }, 404)
    await request('retryIngestionJob', `/api/v1/admin/ingestion-jobs/${JOB_ID}/retries`, { method: 'POST', headers: { ...jsonHeaders, 'Idempotency-Key': 'step4-retry-job-key' }, body: JSON.stringify({ reasonCode: 'job_retry_requested' }) }, 202)
    await request('retryIngestionJob', '/api/v1/admin/ingestion-jobs/507f1f77bcf86cd799439098/retries', { method: 'POST', headers: { ...jsonHeaders, 'Idempotency-Key': 'step4-retry-job-key-2' }, body: JSON.stringify({ reasonCode: 'job_retry_requested' }) }, 409)
    await request('cancelIngestionJob', `/api/v1/admin/ingestion-jobs/${JOB_ID}/cancellation`, { method: 'POST', headers: jsonHeaders, body: JSON.stringify({ reasonCode: 'job_cancel_requested' }) }, 200)
    await request('runDueWork', '/api/internal/cron/due-work', { headers: { Authorization: `Bearer ${MACHINE_TOKEN}` } }, 202)
    await request('runDueWork', '/api/internal/cron/due-work?maxJobs=100', { headers: { Authorization: `Bearer ${MACHINE_TOKEN}` } }, 400)
    await request('runDueWork', '/api/internal/cron/due-work', {}, 401)
    await request('runMaintenanceTask', '/api/internal/maintenance/purge-ingestion-jobs', { headers: { Authorization: `Bearer ${MACHINE_TOKEN}` } }, 202)
    await request('runMaintenanceTask', '/api/internal/maintenance/purge-ingestion-jobs?filter=all', { headers: { Authorization: `Bearer ${MACHINE_TOKEN}` } }, 400)
    await request('runMaintenanceTask', '/api/internal/maintenance/purge-indexing-jobs', { headers: { Authorization: `Bearer ${MACHINE_TOKEN}` } }, 409)
  } finally { await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())) }
  return { cases }
}
