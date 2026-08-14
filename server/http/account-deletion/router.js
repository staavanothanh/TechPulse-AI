import { Router } from 'express'
import Ajv from 'ajv'
import addFormats from 'ajv-formats'
import { loadOpenApi } from '../../../scripts/contracts/openapi-utils.js'
import { requireCsrf } from '../middleware/csrf.js'
import { asyncContentRoute, noStoreContent, requireAuthenticated } from '../articles/authenticated.js'
import { serializeClearSessionCookie } from '../cookies.js'

const OPENAPI = loadOpenApi()
const ajv = new Ajv({ allErrors: true, strict: false })
addFormats(ajv)
for (const [name, schema] of Object.entries(OPENAPI.components.schemas)) ajv.addSchema(schema, `#/components/schemas/${name}`)
const validateResponse = ajv.compile({ $ref: '#/components/schemas/AccountDeletionAcceptedResponse' })
const IDEMPOTENCY_KEY = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/

function unavailable() { throw Object.assign(new Error('Account deletion service is not configured'), { status: 503, code: 'service_unavailable' }) }
function idempotencyKey(req) {
  const value = req.get('Idempotency-Key')
  if (!value || !IDEMPOTENCY_KEY.test(value)) throw Object.assign(new Error('Idempotency-Key is invalid'), { status: 400, code: 'bad_request' })
  return value
}
function sendValidated(res, payload) {
  if (!validateResponse({ data: payload })) throw Object.assign(new Error('Account deletion response failed contract validation'), { status: 500, code: 'internal_error' })
  noStoreContent(res)
  res.set('Set-Cookie', serializeClearSessionCookie())
  return res.status(202).json({ data: payload })
}

export function createAccountDeletionRouter({ accountDeletionService, authService } = {}) {
  const router = Router()
  const service = accountDeletionService ?? { request: unavailable }
  router.post('/api/v1/me/deletion-requests', requireAuthenticated, requireCsrf(authService), asyncContentRoute(async (req, res) => {
    const result = await service.request({ auth: req.auth, idempotencyKey: idempotencyKey(req), request: req })
    return sendValidated(res, result)
  }))
  return router
}
