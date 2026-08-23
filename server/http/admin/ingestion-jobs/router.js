import { Router } from 'express'
import Ajv from 'ajv'
import addFormats from 'ajv-formats'
import { loadOpenApi } from '../../../../scripts/contracts/openapi-utils.js'
import { JobError } from '../../../application/jobs/service.js'
import { requireCsrf } from '../../middleware/csrf.js'
import { requireRole } from '../../middleware/require-role.js'
import { serializeIngestionJobResponse } from './serializer.js'

const openApi = loadOpenApi()
const ajv = new Ajv({ allErrors: true, strict: false })
addFormats(ajv)
for (const [name, schema] of Object.entries(openApi.components.schemas)) ajv.addSchema(schema, `#/components/schemas/${name}`)
const validators = new Map(['IngestionJobCreateRequest', 'JobRetryRequest', 'JobCancellationRequest'].map((name) => [name, ajv.compile({ $ref: `#/components/schemas/${name}` })]))
const IDEMPOTENCY_KEY = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/

function validateBody(name, body) {
  const validate = validators.get(name)
  if (validate(body)) return
  throw new JobError(422, 'validation_error', 'Request body is invalid')
}

function idempotencyKey(req) {
  const value = req.get('Idempotency-Key')
  if (!value || !IDEMPOTENCY_KEY.test(value)) throw new JobError(400, 'bad_request', 'Idempotency-Key is invalid')
  return value
}

function asyncRoute(handler) { return (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next) }
function noStore(res) { res.set('Cache-Control', 'no-store, private') }
function unavailable() { throw new JobError(503, 'service_unavailable', 'Durable job service is not configured') }
function iso(value) { return value instanceof Date ? value.toISOString() : value }

function counters(value = {}) {
  return Object.fromEntries(['claimed', 'succeeded', 'partial', 'failed', 'deferred'].map((key) => [key, Number(value[key] ?? 0)]))
}

function serializeDueWorkRun(result) {
  return {
    runId: String(result.runId),
    startedAt: iso(result.startedAt),
    finishedAt: iso(result.finishedAt),
    recovery: Object.fromEntries(['inspected', 'recovered', 'retriesCreated', 'failed'].map((key) => [key, Number(result.recovery?.[key] ?? 0)])),
    queues: {
      ingestion: counters(result.queues?.ingestion),
      indexing: counters(result.queues?.indexing),
      accountDeletion: counters(result.queues?.accountDeletion),
    },
    nextAvailableAt: result.nextAvailableAt ? iso(result.nextAvailableAt) : null,
  }
}

export function createAdminIngestionJobsRouter({ jobService, authService } = {}) {
  const router = Router()
  const service = jobService ?? { listIngestionJobs: unavailable, getIngestionJob: unavailable, createIngestionJob: unavailable, retryIngestionJob: unavailable, cancelIngestionJob: unavailable, runDueWork: unavailable }
  const admin = requireRole('admin')
  const csrf = requireCsrf(authService)

  router.get('/api/v1/admin/ingestion-jobs', admin, asyncRoute(async (req, res) => {
    const result = await service.listIngestionJobs({ auth: req.auth, query: req.query })
    noStore(res)
    res.status(200).json({ data: (result.jobs ?? []).map(serializeIngestionJobResponse), meta: { hasNext: Boolean(result.hasNext), nextCursor: result.nextCursor ?? null } })
  }))
  router.post('/api/v1/admin/ingestion-jobs', admin, csrf, asyncRoute(async (req, res) => {
    validateBody('IngestionJobCreateRequest', req.body)
    const job = await service.createIngestionJob({ auth: req.auth, input: req.body, idempotencyKey: idempotencyKey(req), request: req })
    noStore(res)
    res.status(202).json({ data: serializeIngestionJobResponse(job) })
  }))
  router.get('/api/v1/admin/ingestion-jobs/:jobId', admin, asyncRoute(async (req, res) => {
    const job = await service.getIngestionJob({ auth: req.auth, jobId: req.params.jobId })
    noStore(res)
    res.status(200).json({ data: serializeIngestionJobResponse(job) })
  }))
  router.post('/api/v1/admin/ingestion-jobs/:jobId/retries', admin, csrf, asyncRoute(async (req, res) => {
    validateBody('JobRetryRequest', req.body)
    const job = await service.retryIngestionJob({ auth: req.auth, jobId: req.params.jobId, reasonCode: req.body.reasonCode, idempotencyKey: idempotencyKey(req), request: req })
    noStore(res)
    res.status(202).json({ data: serializeIngestionJobResponse(job) })
  }))
  router.post('/api/v1/admin/ingestion-jobs/:jobId/cancellation', admin, csrf, asyncRoute(async (req, res) => {
    validateBody('JobCancellationRequest', req.body)
    const job = await service.cancelIngestionJob({ auth: req.auth, jobId: req.params.jobId, reasonCode: req.body.reasonCode, request: req })
    noStore(res)
    res.status(200).json({ data: serializeIngestionJobResponse(job) })
  }))
  router.post('/api/v1/admin/due-work-runs', admin, csrf, asyncRoute(async (req, res) => {
    if (req.body && Object.keys(req.body).length > 0) throw new JobError(422, 'validation_error', 'Request body must be empty')
    const result = await service.runDueWork({ auth: req.auth, request: req })
    noStore(res)
    res.status(202).json({ data: serializeDueWorkRun(result) })
  }))
  return router
}
