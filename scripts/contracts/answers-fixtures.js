import Ajv from 'ajv'
import addFormats from 'ajv-formats'
import { collectOperations, dereference } from './openapi-utils.js'

const NOW = '2026-08-12T00:00:00.000Z'
const OBJECT_ID = '507f1f77bcf86cd799439011'

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

function validators(document) {
  const ajv = new Ajv({ allErrors: true, strict: false })
  addFormats(ajv)
  ajv.addSchema({ ...document, $id: 'techpulse-openapi-answers' })
  const compile = (schema) => ajv.compile(schema.$ref ? { $ref: `techpulse-openapi-answers${schema.$ref}` } : schema)
  const operations = new Map(collectOperations(document).map(({ operation }) => [operation.operationId, operation]))
  return {
    response(operationId, status) {
      const response = dereference(document, operations.get(operationId)?.responses?.[String(status)])
      const schema = response?.content?.['application/json']?.schema
      if (!schema) throw new Error(`No JSON schema for ${operationId} ${status}`)
      return compile(schema)
    },
    request(operationId) {
      const operation = operations.get(operationId)
      return compile(operation.requestBody.content['application/json'].schema)
    },
    parameter(name) {
      return compile(document.components.parameters[name].schema)
    },
  }
}

function error(code, requestId) {
  return { error: { code, message: 'Safe contract error', requestId } }
}

function answered() {
  return {
    data: {
      id: 'answer-1', status: 'answered',
      paragraphs: [{ text: 'Kết luận có căn cứ.', citationIds: ['C1'] }],
      citations: [{ id: 'C1', articleId: OBJECT_ID, sourceId: OBJECT_ID, sourceName: 'Example', titleOriginal: 'Grounded result', originalUrl: 'https://example.com/article', author: null, publishedAt: NOW, sourceLanguage: 'vi' }],
      refusalReason: null, chatSessionId: OBJECT_ID, createdAt: NOW,
    },
  }
}

function refused() {
  return { data: { id: 'answer-2', status: 'refused', paragraphs: [], citations: [], refusalReason: 'insufficient-evidence', chatSessionId: OBJECT_ID, createdAt: NOW } }
}

function answerInvariants(body) {
  const answer = body?.data
  if (answer?.status === 'answered') {
    const ids = new Set(answer.citations?.map((citation) => citation.id))
    return answer.paragraphs?.every((paragraph) => paragraph.citationIds?.every((id) => ids.has(id))) === true
  }
  return answer?.status === 'refused' && answer.paragraphs?.length === 0 && answer.citations?.length === 0
}

export async function runAnswersContractFixtures({ document } = {}) {
  if (!document) throw new Error('OpenAPI document is required')
  const operation = collectOperations(document).find(({ operation: candidate }) => candidate.operationId === 'createGroundedAnswer')
  assert(operation?.route === '/api/v1/answers' && operation.method === 'post', 'createGroundedAnswer route drifted')
  const validate = validators(document)

  const validAnswered = answered()
  assert(validate.response('createGroundedAnswer', 200)(validAnswered), 'answered fixture must be public-contract valid')
  assert(answerInvariants(validAnswered), 'answered citation IDs must resolve')
  const validRefused = refused()
  assert(validate.response('createGroundedAnswer', 200)(validRefused) && answerInvariants(validRefused), 'refused fixture must be public-contract valid')

  for (const invalid of [
    { ...answered(), data: { ...answered().data, paragraphs: [] } },
    { ...refused(), data: { ...refused().data, paragraphs: [{ text: 'Leak', citationIds: ['C1'] }] } },
    { ...refused(), data: { ...refused().data, provider: 'forbidden' } },
  ]) assert(!validate.response('createGroundedAnswer', 200)(invalid), 'invalid answer branch/public field must be rejected')
  const unresolved = answered()
  unresolved.data.paragraphs[0].citationIds = ['C-missing']
  assert(validate.response('createGroundedAnswer', 200)(unresolved) && !answerInvariants(unresolved), 'fixture must detect unresolved public citation IDs')

  const canonicalErrors = new Map([
    [400, 'bad_request'], [401, 'unauthorized'], [404, 'not_found'], [409, 'idempotency_mismatch'],
    [413, 'payload_too_large'], [415, 'unsupported_media_type'],
  ])
  for (const [status, code] of canonicalErrors) assert(validate.response('createGroundedAnswer', status)(error(code, `req_answer_${status}`)), `answer ${status} must use canonical error envelope`)
  for (const [status, responseName] of [[400, 'BadRequest'], [401, 'Unauthorized'], [404, 'NotFound'], [409, 'Conflict'], [413, 'PayloadTooLarge'], [415, 'UnsupportedMediaType']]) {
    assert(operation.operation.responses[String(status)].$ref === `#/components/responses/${responseName}`, `answer ${status} must reference canonical ${responseName}`)
  }

  const request = validate.request('createGroundedAnswer')
  assert(request({ question: 'Câu hỏi hợp lệ?', scope: { topics: ['ai'] }, chatSessionId: OBJECT_ID }), 'canonical continuation ObjectId must be accepted')
  assert(!request({ question: 'Câu hỏi hợp lệ?', scope: { topics: ['ai'] }, chatSessionId: 'chat-1' }), 'non-ObjectId continuation must be rejected')
  assert(request({ question: 'Câu hỏi hợp lệ?', scope: { articleId: OBJECT_ID } }), 'canonical article ObjectId must be accepted')
  assert(!request({ question: 'Câu hỏi hợp lệ?', scope: { articleId: 'article-1' } }), 'non-ObjectId article scope must be rejected')
  const path = validate.parameter('ChatSessionIdPath')
  assert(path(OBJECT_ID) && !path('chat-1'), 'ChatSessionIdPath must accept only canonical Mongo ObjectIds')
  for (const operationId of ['getChatSession', 'deleteChatSession']) {
    assert(validate.response(operationId, 400)(error('bad_request', `req_${operationId}_path`)), `${operationId} must declare canonical invalid-path behavior`)
  }

  return { cases: 12 }
}
