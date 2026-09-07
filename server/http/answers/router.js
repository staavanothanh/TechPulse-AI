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

const REQUEST_ABORT_SIGNAL = Symbol('requestAbortSignal')

function bindEvent(target, event, listener) {
  if (typeof target?.on === 'function') target.on(event, listener)
}

function unbindEvent(target, event, listener) {
  if (typeof target?.removeListener === 'function') target.removeListener(event, listener)
  else if (typeof target?.off === 'function') target.off(event, listener)
}

function requestAbortMiddleware(req, res, next) {
  const controller = new globalThis.AbortController()
  const signal = controller.signal
  let cleanedUp = false
  const onRequestAborted = () => controller.abort()
  const onResponseClose = () => {
    if (!res.writableEnded) controller.abort()
    cleanup()
  }
  const cleanup = () => {
    if (cleanedUp) return
    cleanedUp = true
    unbindEvent(req, 'aborted', onRequestAborted)
    unbindEvent(res, 'close', onResponseClose)
    unbindEvent(res, 'finish', cleanup)
    unbindEvent(res, 'error', onResponseError)
  }
  const onResponseError = () => {
    controller.abort()
    cleanup()
  }
  res.locals[REQUEST_ABORT_SIGNAL] = signal
  bindEvent(req, 'aborted', onRequestAborted)
  bindEvent(res, 'close', onResponseClose)
  bindEvent(res, 'finish', cleanup)
  bindEvent(res, 'error', onResponseError)
  if (req.aborted || res.destroyed) controller.abort()
  try {
    next()
  } catch (error) {
    cleanup()
    throw error
  }
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

  router.post('/api/v1/answers', requestAbortMiddleware, requireAuthenticated, csrf, asyncContentRoute(async (req, res) => {
    noStoreContent(res)
    validateBody(req.body)
    const result = await service.createAnswer({
      auth: req.auth,
      question: req.body.question,
      scope: req.body.scope,
      scopeMode: req.body.scopeMode,
      scopeConfirmation: req.body.scopeConfirmation,
      chatSessionId: req.body.chatSessionId,
      idempotencyKey: idempotencyKey(req),
      request: req,
      signal: res.locals[REQUEST_ABORT_SIGNAL],
    })
    res.status(200).json({ data: validatePublicAnswerResponse(result?.answer ?? result) })
  }))

  return router
}
