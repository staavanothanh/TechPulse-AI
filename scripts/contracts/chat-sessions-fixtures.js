import Ajv from 'ajv'
import addFormats from 'ajv-formats'
import { collectOperations, dereference } from './openapi-utils.js'

const NOW = '2026-08-12T00:00:00.000Z'
const ARTICLE_ID = '507f1f77bcf86cd799439011'
const SOURCE_ID = '507f1f77bcf86cd799439021'
const SESSION_ID = '507f1f77bcf86cd799439031'

function responseValidator(document) {
  const ajv = new Ajv({ allErrors: true, strict: false })
  addFormats(ajv)
  ajv.addSchema({ ...document, $id: 'techpulse-openapi-chat-sessions' })
  const operations = new Map(collectOperations(document).map(({ operation }) => [operation.operationId, operation]))
  return (operationId, status, body) => {
    const operation = operations.get(operationId)
    const response = dereference(document, operation?.responses?.[String(status)])
    const schema = response?.content?.['application/json']?.schema
    if (!schema) throw new Error(`No JSON schema for ${operationId} ${status}`)
    const validate = ajv.compile(schema.$ref ? { $ref: `techpulse-openapi-chat-sessions${schema.$ref}` } : schema)
    if (!validate(body)) throw new Error(`Invalid ${operationId} ${status}: ${ajv.errorsText(validate.errors)}`)
    return validate
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

function successfulDetail() {
  return {
    data: {
      id: SESSION_ID,
      title: null,
      scope: { articleId: ARTICLE_ID },
      messageCount: 3,
      messages: [
        {
          id: 'message-user-001',
          role: 'user',
          text: 'Hãy tóm tắt các điểm chính của bài viết này.',
          createdAt: NOW,
        },
        {
          id: 'message-answer-001',
          role: 'assistant',
          status: 'answered',
          paragraphs: [
            {
              text: 'Bài viết mô tả cách xây dựng hệ thống truy xuất có kiểm chứng.',
              citationIds: ['citation-available-001', 'citation-unavailable-001'],
            },
          ],
          citations: [
            {
              id: 'citation-available-001',
              status: 'available',
              articleId: ARTICLE_ID,
              sourceId: SOURCE_ID,
              originalUrl: 'https://example.com/grounded-history',
              titleOriginal: 'Grounded retrieval for technology systems',
              publishedAt: NOW,
            },
            {
              id: 'citation-unavailable-001',
              status: 'unavailable',
              articleId: ARTICLE_ID,
              sourceId: SOURCE_ID,
              unavailableReason: 'takedown',
            },
          ],
          refusalReason: null,
          createdAt: NOW,
        },
        {
          id: 'message-refused-001',
          role: 'assistant',
          status: 'refused',
          paragraphs: [],
          citations: [],
          refusalReason: 'insufficient-evidence',
          createdAt: NOW,
        },
      ],
      createdAt: NOW,
      updatedAt: NOW,
    },
  }
}

function nonDisclosureError(requestId) {
  return {
    error: {
      code: 'not_found',
      message: 'Resource not found',
      requestId,
    },
  }
}

export async function runChatSessionsContractFixtures({ document } = {}) {
  if (!document) throw new Error('OpenAPI document is required')
  const operation = collectOperations(document).find(({ operation: candidate }) => candidate.operationId === 'getChatSession')
  assert(operation?.route === '/api/v1/chat-sessions/{chatSessionId}', 'getChatSession path drifted')
  assert(operation.method === 'get', 'getChatSession method drifted')

  const validate = responseValidator(document)
  const detail = successfulDetail()
  validate('getChatSession', 200, detail)
  assert(detail.data.messageCount === detail.data.messages.length, 'messageCount must equal bounded message length')
  assert(detail.data.messages.length <= 30, 'chat detail fixture must stay within 30 persisted messages')
  const answered = detail.data.messages.find((message) => message.status === 'answered')
  const unavailable = answered.citations.find((citation) => citation.status === 'unavailable')
  assert(answered.paragraphs.every((paragraph) => paragraph.citationIds.every((id) => answered.citations.some((citation) => citation.id === id))), 'historical citation IDs must resolve')
  assert(!('originalUrl' in unavailable) && !('titleOriginal' in unavailable) && !('publishedAt' in unavailable), 'unavailable historical citation must not contain source facts')

  const tooManyMessages = structuredClone(detail)
  tooManyMessages.data.messageCount = 31
  tooManyMessages.data.messages = Array.from({ length: 31 }, (_, index) => ({
    id: `message-over-bound-${index}`,
    role: 'user',
    text: 'Bound test question',
    createdAt: NOW,
  }))
  let boundRejected = false
  try {
    validate('getChatSession', 200, tooManyMessages)
  } catch {
    boundRejected = true
  }
  assert(boundRejected, 'chat detail schema must reject more than 30 messages')

  validate('getChatSession', 401, { error: { code: 'unauthorized', message: 'Authentication required', requestId: 'req_chat_unauth' } })

  const nonDisclosureCases = [
    ['cross-user', nonDisclosureError('req_chat_cross_user')],
    ['missing', nonDisclosureError('req_chat_missing')],
    ['expired', nonDisclosureError('req_chat_expired')],
  ]
  const normalized = []
  for (const [label, body] of nonDisclosureCases) {
    validate('getChatSession', 404, body)
    normalized.push({ label, status: 404, code: body.error.code, message: body.error.message })
  }
  assert(new Set(normalized.map((item) => JSON.stringify({ status: item.status, code: item.code, message: item.message }))).size === 1, 'ownership, missing and expiry cases must share one non-disclosure response')

  const forbiddenLeak = structuredClone(detail)
  forbiddenLeak.data.messages[1].provider = 'must-not-render'
  const leakCheck = responseValidator(document)
  let leakRejected = false
  try {
    leakCheck('getChatSession', 200, forbiddenLeak)
  } catch {
    leakRejected = true
  }
  assert(leakRejected, 'chat detail schema must reject internal provider fields')

  return { cases: 7 }
}
