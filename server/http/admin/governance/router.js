import { Router } from 'express'
import Ajv from 'ajv'
import addFormats from 'ajv-formats'
import { loadOpenApi } from '../../../../scripts/contracts/openapi-utils.js'
import { AdminGovernanceError, validateArticlePatch } from '../../../application/admin/service.js'
import { requireCsrf } from '../../middleware/csrf.js'
import { requireRole } from '../../middleware/require-role.js'

const OPENAPI = loadOpenApi()
const ajv = new Ajv({ allErrors: true, strict: false })
addFormats(ajv)
for (const [name, schema] of Object.entries(OPENAPI.components.schemas)) ajv.addSchema(schema, `#/components/schemas/${name}`)
const validators = new Map(['AdminArticleUpdateRequest', 'DuplicateMergeRequest', 'TakedownCreateRequest', 'TakedownUpdateRequest', 'AccountDeletionRetryRequest'].map((name) => [name, ajv.compile({ $ref: `#/components/schemas/${name}` })]))
const responseValidators = new Map(['AdminOverviewResponse', 'AdminArticleListResponse', 'AdminArticleDetailResponse', 'AdminArticleResponse', 'AuditLogListResponse', 'TakedownListResponse', 'TakedownResponse', 'AccountDeletionListResponse', 'AccountDeletionResponse'].map((name) => [name, ajv.compile({ $ref: `#/components/schemas/${name}` })]))
const IDEMPOTENCY_KEY = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/

function asyncRoute(handler) { return (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next) }
function noStore(res) { res.set('Cache-Control', 'no-store, private') }
function validateBody(name, body) {
  const validate = validators.get(name)
  if (validate?.(body)) return
  throw new AdminGovernanceError(422, 'validation_error', 'Request body is invalid', { details: (validate?.errors ?? []).map(({ instancePath, schemaPath, keyword, message, params }) => ({ field: instancePath?.replace(/^\//, '').replaceAll('/', '.') || 'body', message: message ?? 'Invalid value', code: `invalid_${keyword}`, ...(schemaPath || params ? {} : {}) })) })
}
function idempotencyKey(req) {
  const value = req.get('Idempotency-Key')
  if (!value || !IDEMPOTENCY_KEY.test(value)) throw new AdminGovernanceError(400, 'bad_request', 'Idempotency-Key is invalid')
  return value
}
function sendValidated(res, status, name, payload) {
  const validate = responseValidators.get(name)
  if (!validate?.(payload)) throw new AdminGovernanceError(500, 'internal_error', 'Admin response failed contract validation')
  noStore(res)
  return res.status(status).json(payload)
}
function unavailable() { throw new AdminGovernanceError(503, 'service_unavailable', 'Admin governance service is not configured') }

export function createAdminGovernanceRouter({ adminGovernanceService, authService } = {}) {
  const router = Router()
  const service = adminGovernanceService ?? {
    getAdminOverview: unavailable, listAdminArticles: unavailable, getAdminArticle: unavailable, updateAdminArticle: unavailable,
    mergeDuplicateArticles: unavailable, listAuditLogs: unavailable,
    listTakedownRequests: unavailable, createTakedownRequest: unavailable, getTakedownRequest: unavailable, updateTakedownRequest: unavailable,
    listAccountDeletionRequests: unavailable, getAccountDeletionRequest: unavailable, retryAccountDeletionRequest: unavailable,
  }
  const admin = requireRole('admin')
  const csrf = requireCsrf(authService)

  router.get('/api/v1/admin/overview', admin, asyncRoute(async (req, res) => {
    const data = await service.getAdminOverview({ auth: req.auth, request: req })
    sendValidated(res, 200, 'AdminOverviewResponse', { data })
  }))
  router.get('/api/v1/admin/articles', admin, asyncRoute(async (req, res) => {
    const result = await service.listAdminArticles({ auth: req.auth, query: req.query, request: req })
    sendValidated(res, 200, 'AdminArticleListResponse', { data: result.articles ?? [], meta: { hasNext: Boolean(result.hasNext), nextCursor: result.nextCursor ?? null } })
  }))
  router.get('/api/v1/admin/articles/:articleId', admin, asyncRoute(async (req, res) => {
    const data = await service.getAdminArticle({ auth: req.auth, articleId: req.params.articleId, request: req })
    sendValidated(res, 200, 'AdminArticleDetailResponse', { data })
  }))
  router.patch('/api/v1/admin/articles/:articleId', admin, csrf, asyncRoute(async (req, res) => {
    validateBody('AdminArticleUpdateRequest', req.body)
    validateArticlePatch(req.body)
    const key = idempotencyKey(req)
    const data = await service.updateAdminArticle({ auth: req.auth, articleId: req.params.articleId, patch: req.body, idempotencyKey: key, csrfToken: req.get('X-CSRF-Token'), request: req })
    sendValidated(res, 200, 'AdminArticleResponse', { data })
  }))
  router.post('/api/v1/admin/duplicate-merges', admin, csrf, asyncRoute(async (req, res) => {
    validateBody('DuplicateMergeRequest', req.body)
    const data = await service.mergeDuplicateArticles({ auth: req.auth, input: req.body, idempotencyKey: idempotencyKey(req), csrfToken: req.get('X-CSRF-Token'), request: req })
    sendValidated(res, 200, 'AdminArticleResponse', { data })
  }))
  router.get('/api/v1/admin/audit-logs', admin, asyncRoute(async (req, res) => {
    const result = await service.listAuditLogs({ auth: req.auth, query: req.query, request: req })
    sendValidated(res, 200, 'AuditLogListResponse', { data: result.logs ?? [], meta: { hasNext: Boolean(result.hasNext), nextCursor: result.nextCursor ?? null } })
  }))
  router.get('/api/v1/admin/takedown-requests', admin, asyncRoute(async (req, res) => {
    const result = await service.listTakedownRequests({ auth: req.auth, query: req.query, request: req })
    sendValidated(res, 200, 'TakedownListResponse', { data: result.requests ?? [], meta: { hasNext: Boolean(result.hasNext), nextCursor: result.nextCursor ?? null } })
  }))
  router.post('/api/v1/admin/takedown-requests', admin, csrf, asyncRoute(async (req, res) => {
    validateBody('TakedownCreateRequest', req.body)
    const data = await service.createTakedownRequest({ auth: req.auth, input: req.body, csrfToken: req.get('X-CSRF-Token'), request: req })
    sendValidated(res, 201, 'TakedownResponse', { data })
  }))
  router.get('/api/v1/admin/takedown-requests/:takedownRequestId', admin, asyncRoute(async (req, res) => {
    const data = await service.getTakedownRequest({ auth: req.auth, takedownRequestId: req.params.takedownRequestId, request: req })
    sendValidated(res, 200, 'TakedownResponse', { data })
  }))
  router.patch('/api/v1/admin/takedown-requests/:takedownRequestId', admin, csrf, asyncRoute(async (req, res) => {
    validateBody('TakedownUpdateRequest', req.body)
    const data = await service.updateTakedownRequest({ auth: req.auth, takedownRequestId: req.params.takedownRequestId, input: req.body, csrfToken: req.get('X-CSRF-Token'), request: req })
    sendValidated(res, 200, 'TakedownResponse', { data })
  }))
  router.get('/api/v1/admin/account-deletion-requests', admin, asyncRoute(async (req, res) => {
    const result = await service.listAccountDeletionRequests({ auth: req.auth, query: req.query, request: req })
    sendValidated(res, 200, 'AccountDeletionListResponse', { data: result.requests ?? [], meta: { hasNext: Boolean(result.hasNext), nextCursor: result.nextCursor ?? null } })
  }))
  router.get('/api/v1/admin/account-deletion-requests/:deletionRequestId', admin, asyncRoute(async (req, res) => {
    const data = await service.getAccountDeletionRequest({ auth: req.auth, deletionRequestId: req.params.deletionRequestId, request: req })
    sendValidated(res, 200, 'AccountDeletionResponse', { data })
  }))
  router.post('/api/v1/admin/account-deletion-requests/:deletionRequestId/retries', admin, csrf, asyncRoute(async (req, res) => {
    validateBody('AccountDeletionRetryRequest', req.body)
    const data = await service.retryAccountDeletionRequest({ auth: req.auth, deletionRequestId: req.params.deletionRequestId, input: req.body, idempotencyKey: idempotencyKey(req), csrfToken: req.get('X-CSRF-Token'), request: req })
    sendValidated(res, 202, 'AccountDeletionResponse', { data })
  }))
  return router
}

export { validateBody }
