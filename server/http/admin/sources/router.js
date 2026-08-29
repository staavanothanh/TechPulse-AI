import { Router } from 'express'
import Ajv from 'ajv'
import addFormats from 'ajv-formats'
import { loadOpenApi } from '../../../../scripts/contracts/openapi-utils.js'
import { SourceError } from '../../../application/sources/service.js'
import { requireCsrf } from '../../middleware/csrf.js'
import { requireRole } from '../../middleware/require-role.js'
import { serializeSource } from './serializer.js'

const OPENAPI = loadOpenApi()
const ajv = new Ajv({ allErrors: true, strict: false })
addFormats(ajv)
for (const [name, schema] of Object.entries(OPENAPI.components.schemas)) ajv.addSchema(schema, `#/components/schemas/${name}`)
const validators = new Map(['SourceCreateRequest', 'SourceUpdateRequest', 'TechnicalCheckRequest', 'PolicyReviewRequest', 'SourcePolicyReReviewRequest', 'SourcePolicyReconciliationRequest'].map((name) => [name, ajv.compile({ $ref: `#/components/schemas/${name}` })]))

function validateBody(name, body) {
  const validate = validators.get(name)
  if (validate(body)) return
  throw new SourceError(422, 'validation_error', 'Request body is invalid', { details: validate.errors?.map(({ instancePath, message, keyword }) => ({ field: instancePath || 'body', message, code: `invalid_${keyword}` })) })
}

function noStore(res) { res.set('Cache-Control', 'no-store, private') }
function asyncRoute(handler) { return (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next) }
function unavailable() { throw new SourceError(503, 'service_unavailable', 'Source Registry service is not configured') }
function reconciliationUnavailable() { throw new SourceError(503, 'service_unavailable', 'Source policy reconciliation service is not configured') }

export function createAdminSourcesRouter({ sourceService, sourcePolicyReconciliationService, authService } = {}) {
  const router = Router()
  const service = sourceService ?? { list: unavailable, get: unavailable, create: unavailable, update: unavailable, reviewPolicy: unavailable, requestReReview: unavailable, runTechnicalCheck: unavailable }
  const reconciliation = sourcePolicyReconciliationService ?? { preview: reconciliationUnavailable, execute: reconciliationUnavailable }
  const admin = requireRole('admin')
  const csrf = requireCsrf(authService)
  const idempotencyKey = (req) => {
    const value = req.get('Idempotency-Key')
    if (!value || !/^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/.test(value)) throw new SourceError(400, 'bad_request', 'Idempotency-Key is invalid')
    return value
  }

  router.get('/api/v1/admin/sources', admin, asyncRoute(async (req, res) => {
    const result = await service.list({ auth: req.auth, query: req.query })
    noStore(res)
    res.status(200).json({ data: (result.sources ?? []).map(serializeSource), meta: { hasNext: Boolean(result.hasNext), nextCursor: result.nextCursor ?? null } })
  }))
  router.post('/api/v1/admin/sources', admin, csrf, asyncRoute(async (req, res) => {
    validateBody('SourceCreateRequest', req.body)
    const source = await service.create({ auth: req.auth, input: req.body, request: req })
    noStore(res)
    res.status(201).json({ data: serializeSource(source) })
  }))
  router.get('/api/v1/admin/sources/:sourceId', admin, asyncRoute(async (req, res) => {
    const source = await service.get({ auth: req.auth, sourceId: req.params.sourceId })
    noStore(res)
    res.status(200).json({ data: serializeSource(source) })
  }))
  router.get('/api/v1/admin/sources/:sourceId/reconciliation', admin, asyncRoute(async (req, res) => {
    const result = await reconciliation.preview({ auth: req.auth, sourceId: req.params.sourceId, limit: req.query.limit })
    noStore(res)
    res.status(200).json({ data: result })
  }))
  router.post('/api/v1/admin/sources/:sourceId/reconciliation', admin, csrf, asyncRoute(async (req, res) => {
    validateBody('SourcePolicyReconciliationRequest', req.body)
    const result = await reconciliation.execute({
      auth: req.auth, sourceId: req.params.sourceId, limit: req.body.limit, maxPages: req.body.maxPages,
      reasonCode: req.body.reasonCode, idempotencyKey: idempotencyKey(req), request: req,
    })
    noStore(res)
    res.status(202).json({ data: result })
  }))
  router.patch('/api/v1/admin/sources/:sourceId', admin, csrf, asyncRoute(async (req, res) => {
    validateBody('SourceUpdateRequest', req.body)
    const source = await service.update({ auth: req.auth, sourceId: req.params.sourceId, patch: req.body, request: req })
    noStore(res)
    res.status(200).json({ data: serializeSource(source) })
  }))
  router.post('/api/v1/admin/sources/:sourceId/technical-checks', admin, csrf, asyncRoute(async (req, res) => {
    validateBody('TechnicalCheckRequest', req.body)
    const result = await service.runTechnicalCheck({ auth: req.auth, sourceId: req.params.sourceId, request: req })
    noStore(res)
    res.status(200).json({ data: result })
  }))
  router.post('/api/v1/admin/sources/:sourceId/policy-reviews', admin, csrf, asyncRoute(async (req, res) => {
    validateBody('PolicyReviewRequest', req.body)
    const source = await service.reviewPolicy({ auth: req.auth, sourceId: req.params.sourceId, review: req.body, request: req })
    noStore(res)
    res.status(200).json({ data: serializeSource(source) })
  }))
  router.post('/api/v1/admin/sources/:sourceId/re-review-requests', admin, csrf, asyncRoute(async (req, res) => {
    validateBody('SourcePolicyReReviewRequest', req.body)
    const idempotencyKey = req.get('Idempotency-Key')
    if (!idempotencyKey || !/^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/.test(idempotencyKey)) throw new SourceError(400, 'bad_request', 'Idempotency-Key is invalid')
    const source = await service.requestReReview({ auth: req.auth, sourceId: req.params.sourceId, request: req, idempotencyKey })
    noStore(res)
    res.status(202).json({ data: serializeSource(source) })
  }))
  return router
}
