import { Router } from 'express'
import Ajv from 'ajv'
import addFormats from 'ajv-formats'
import { loadOpenApi } from '../../../scripts/contracts/openapi-utils.js'
import { requireCsrf } from '../middleware/csrf.js'
import { asyncContentRoute, noStoreContent, requireAuthenticated } from '../articles/authenticated.js'

const openApi = loadOpenApi()
const ajv = new Ajv({ allErrors: true, strict: false })
addFormats(ajv)
for (const [name, schema] of Object.entries(openApi.components.schemas)) ajv.addSchema(schema, `#/components/schemas/${name}`)
const validateAnswerRequest = ajv.compile({ $ref: '#/components/schemas/AnswerRequest' })
const validateAnswerResponse = ajv.compile({ $ref: '#/components/schemas/AnswerResponse' })
const IDEMPOTENCY_KEY = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/

function validationError(message, details) {
  return Object.assign(new Error(message), { status: 422, code: 'validation_error', details })
}

function validateBody(body) {
  if (validateAnswerRequest(body)) return
  throw validationError('Request body is invalid', validateAnswerRequest.errors?.map(({ instancePath, message, keyword }) => ({
    field: instancePath || 'body',
    message,
    code: `invalid_${keyword}`,
  })))
}

function idempotencyKey(req) {
  const value = req.get('Idempotency-Key')
  if (!value || !IDEMPOTENCY_KEY.test(value)) {
    throw Object.assign(new Error('Idempotency-Key is invalid'), { status: 400, code: 'bad_request' })
  }
  return value
}

function unavailable() {
  throw Object.assign(new Error('Grounded answer service is not configured'), { status: 503, code: 'service_unavailable' })
}

export function validatePublicAnswer(answer) {
  if (!answer || typeof answer !== 'object') throw new Error('Public answer is invalid')
  if (answer.status === 'refused') {
    if (!Array.isArray(answer.paragraphs) || answer.paragraphs.length !== 0 || !Array.isArray(answer.citations) || answer.citations.length !== 0) throw new Error('Public refusal is invalid')
    return answer
  }
  if (answer.status !== 'answered' || !Array.isArray(answer.paragraphs) || answer.paragraphs.length < 1 || !Array.isArray(answer.citations) || answer.citations.length < 1) throw new Error('Public answer is invalid')
  const citationIds = new Set(answer.citations.map((citation) => citation?.id))
  if (citationIds.has(undefined) || answer.paragraphs.some((paragraph) => !Array.isArray(paragraph?.citationIds) || paragraph.citationIds.length < 1 || paragraph.citationIds.some((id) => !citationIds.has(id)))) throw new Error('Public answer citations are invalid')
  return answer
}

export function validatePublicAnswerResponse(answer) {
  const data = validatePublicAnswer(answer)
  const payload = { data }
  if (!validateAnswerResponse(payload)) throw new Error('Public AnswerResponse is invalid')
  return data
}

export function createAnswersRouter({ qaService, authService } = {}) {
  const router = Router()
  const service = qaService ?? { createAnswer: unavailable }
  const csrf = requireCsrf(authService)

  router.post('/api/v1/answers', requireAuthenticated, csrf, asyncContentRoute(async (req, res) => {
    validateBody(req.body)
    const result = await service.createAnswer({
      auth: req.auth,
      question: req.body.question,
      scope: req.body.scope,
      chatSessionId: req.body.chatSessionId,
      idempotencyKey: idempotencyKey(req),
      request: req,
    })
    noStoreContent(res)
    res.status(200).json({ data: validatePublicAnswerResponse(result?.answer ?? result) })
  }))

  return router
}
