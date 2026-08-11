import http from 'node:http'
import Ajv from 'ajv'
import addFormats from 'ajv-formats'
import { createApp } from '../../server/app.js'
import { JobError } from '../../server/application/indexing/service.js'
import { collectOperations, dereference } from './openapi-utils.js'

const ADMIN_TOKEN = 'step9-contract-admin-session'
const CSRF_TOKEN = 'step9-contract-csrf-token'
const ADMIN_ID = '507f1f77bcf86cd799439001'
const ARTICLE_ID = '507f1f77bcf86cd799439011'
const SOURCE_ID = '507f1f77bcf86cd799439021'
const JOB_ID = '507f1f77bcf86cd799439041'
const NOW = '2026-08-10T08:00:00.000Z'

const JOB = Object.freeze({
  id: JOB_ID, idempotencyKey: 'step9-contract-indexing-key', articleId: ARTICLE_ID, sourceId: SOURCE_ID,
  expectedSourcePolicyVersion: 4, task: 'embedding', trigger: 'admin', status: 'queued', attempt: 1,
  availableAt: NOW, leaseGeneration: 0, parentJobId: null, error: null, createdAt: NOW, startedAt: null, finishedAt: null,
})

function responseValidator(document) {
  const ajv = new Ajv({ allErrors: true, strict: false })
  addFormats(ajv)
  ajv.addSchema({ ...document, $id: 'techpulse-openapi-step9' })
  const operations = new Map(collectOperations(document).map(({ operation }) => [operation.operationId, operation]))
  return (operationId, status, body) => {
    const response = dereference(document, operations.get(operationId)?.responses?.[String(status)])
    const schema = response?.content?.['application/json']?.schema
    if (!schema) throw new Error(`No JSON schema for ${operationId} ${status}`)
    const validate = ajv.compile(schema.$ref ? { $ref: `techpulse-openapi-step9${schema.$ref}` } : schema)
    if (!validate(body)) throw new Error(`Invalid ${operationId} ${status}: ${ajv.errorsText(validate.errors)}`)
  }
}

function services() {
  const authService = {
    async authenticate({ token }) {
      if (token !== ADMIN_TOKEN) throw new JobError(401, 'unauthorized', 'Session is invalid')
      return { user: { id: ADMIN_ID, role: 'admin', status: 'active' }, session: { _id: '507f1f77bcf86cd799439002', userSessionVersion: 4 } }
    },
    async verifyCsrf({ token }) { if (token !== CSRF_TOKEN) throw new JobError(403, 'csrf_invalid', 'CSRF token is invalid') },
  }
  const indexingJobService = {
    async listIndexingJobs() { return { jobs: [JOB], hasNext: false, nextCursor: null } },
    async getIndexingJob({ jobId }) { if (jobId !== JOB_ID) throw new JobError(404, 'not_found', 'Indexing job not found'); return JOB },
    async createSummaryJob() { return { ...JOB, task: 'summary' } },
    async createIndexingJob({ input }) { return { ...JOB, task: input.task } },
    async retryIndexingJob() { return { ...JOB, trigger: 'retry', attempt: 2, parentJobId: JOB_ID } },
    async cancelIndexingJob() { return { ...JOB, status: 'cancelled', finishedAt: '2026-08-10T08:01:00.000Z' } },
  }
  return { authService, indexingJobService }
}

async function start(app) {
  const server = http.createServer(app)
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  return server
}

export async function runStep9IndexingContractFixtures({ document } = {}) {
  if (!document) throw new Error('OpenAPI document is required')
  const validate = responseValidator(document)
  const server = await start(createApp(services()))
  const origin = `http://127.0.0.1:${server.address().port}`
  const cookie = `__Host-techpulse_session=${ADMIN_TOKEN}`
  const headers = { Origin: 'http://localhost:3000', Cookie: cookie, 'X-CSRF-Token': CSRF_TOKEN, 'Content-Type': 'application/json' }
  let cases = 0
  async function request(operationId, path, init, expected) {
    const response = await globalThis.fetch(`${origin}${path}`, init)
    if (response.status !== expected) throw new Error(`${operationId} expected ${expected}, got ${response.status}`)
    validate(operationId, expected, await response.json())
    cases += 1
  }
  try {
    await request('listIndexingJobs', '/api/v1/admin/indexing-jobs?task=embedding&status=queued', { headers: { Cookie: cookie } }, 200)
    await request('getIndexingJob', `/api/v1/admin/indexing-jobs/${JOB_ID}`, { headers: { Cookie: cookie } }, 200)
    await request('getIndexingJob', '/api/v1/admin/indexing-jobs/507f1f77bcf86cd799439099', { headers: { Cookie: cookie } }, 404)
    await request('createSummaryJob', `/api/v1/admin/articles/${ARTICLE_ID}/summary-jobs`, { method: 'POST', headers: { ...headers, 'Idempotency-Key': 'step9-contract-summary-key' }, body: JSON.stringify({ reasonCode: 'artifact_regeneration_requested' }) }, 202)
    await request('createIndexingJob', `/api/v1/admin/articles/${ARTICLE_ID}/indexing-jobs`, { method: 'POST', headers: { ...headers, 'Idempotency-Key': 'step9-contract-embedding-key' }, body: JSON.stringify({ task: 'embedding', reasonCode: 'artifact_regeneration_requested' }) }, 202)
    await request('retryIndexingJob', `/api/v1/admin/indexing-jobs/${JOB_ID}/retries`, { method: 'POST', headers: { ...headers, 'Idempotency-Key': 'step9-contract-retry-key' }, body: JSON.stringify({ reasonCode: 'job_retry_requested' }) }, 202)
    await request('cancelIndexingJob', `/api/v1/admin/indexing-jobs/${JOB_ID}/cancellation`, { method: 'POST', headers, body: JSON.stringify({ reasonCode: 'job_cancel_requested' }) }, 200)
    await request('createSummaryJob', `/api/v1/admin/articles/${ARTICLE_ID}/summary-jobs`, { method: 'POST', headers, body: JSON.stringify({ reasonCode: 'artifact_regeneration_requested' }) }, 400)
    await request('createIndexingJob', `/api/v1/admin/articles/${ARTICLE_ID}/indexing-jobs`, { method: 'POST', headers: { ...headers, 'Idempotency-Key': 'step9-contract-invalid-key' }, body: JSON.stringify({ task: 'summary', reasonCode: 'artifact_regeneration_requested' }) }, 422)
  } finally { await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())) }
  return { cases }
}
