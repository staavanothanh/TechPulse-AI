import { qaClarificationMessage } from './qa-validation.js'

function retryAfterValue(response) {
  const value = Number(response.headers.get('Retry-After'))
  return Number.isInteger(value) && value > 0 ? value : null
}

function queryPairs(query = {}) {
  return Object.entries(query).filter(([, value]) => value !== undefined && value !== null && value !== '').flatMap(([key, value]) => [[key, Array.isArray(value) ? value.join(',') : String(value)]])
}
function normalizeDateTime(value) {
  if (typeof value !== 'string' || value.trim() === '') return value
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? value : date.toISOString()
}

export function normalizeAnswerBody(body) {
  const scope = body?.scope
  if (!body || typeof body !== 'object' || !scope || typeof scope !== 'object' || Array.isArray(scope)) return body
  const normalizedScope = Object.fromEntries(
    Object.entries(scope)
      .filter(([key, value]) => {
        if (key === 'topics') return Array.isArray(value) && value.length > 0
        if (['articleId', 'publishedAfter', 'publishedBefore'].includes(key)) return value !== undefined && value !== null && value !== ''
        return true
      })
      .map(([key, value]) => [
        key,
        ['publishedAfter', 'publishedBefore'].includes(key) ? normalizeDateTime(value) : value,
      ]),
  )
  return { ...body, scope: normalizedScope }
}

const FIELD_COPY = Object.freeze({
  question: 'Câu hỏi chưa hợp lệ.',
  articleId: 'Mã bài viết chưa hợp lệ.',
  topics: 'Danh sách chủ đề chưa hợp lệ.',
  publishedAfter: 'Mốc bắt đầu chưa hợp lệ.',
  publishedBefore: 'Mốc kết thúc chưa hợp lệ.',
  scope: 'Phạm vi nguồn chưa hợp lệ.',
})

function safeFieldErrors(details) {
  if (!Array.isArray(details)) return {}
  return Object.fromEntries(details.flatMap((detail) => {
    const field = String(detail?.field ?? '').split('/').filter(Boolean).at(-1)
    return FIELD_COPY[field] ? [[field, FIELD_COPY[field]]] : []
  }))
}

export function createQaApi(generatedApi, fetchImpl = globalThis.fetch) {
  async function invoke(operation, init = {}) {
    if (typeof operation !== 'function') throw new Error('Q&A operation is unavailable')
    let retryAfter = null
    const { query, ...rest } = init
    const managedFetch = async (input, requestInit = {}) => {
      const url = new URL(input, typeof window === 'undefined' ? 'http://localhost:3000' : window.location.origin)
      for (const [key, value] of queryPairs(query)) url.searchParams.set(key, value)
      const nextInit = { ...requestInit }
      delete nextInit.query
      const response = await fetchImpl(url, nextInit)
      retryAfter = retryAfterValue(response)
      return response
    }
    try {
      const result = await operation({ ...rest, credentials: 'same-origin', fetchImpl: managedFetch })
      if (result instanceof Response) {
        const payload = await result.json().catch(() => undefined)
        if (!result.ok) {
          const serverError = payload?.error
          const error = new Error(qaClarificationMessage(serverError) ?? serverError?.message ?? 'API request failed')
          error.status = result.status
          error.code = serverError?.code
          error.requestId = serverError?.requestId
          const fieldErrors = safeFieldErrors(serverError?.details)
          if (Object.keys(fieldErrors).length > 0) error.fieldErrors = fieldErrors
          throw error
        }
        return payload
      }
      return result
    } catch (error) {
      if (retryAfter !== null) error.retryAfter = Math.min(retryAfter, 300)
      throw error
    }
  }
  return Object.freeze({
    listSessions: (query) => invoke(generatedApi?.listChatSessions, { query }),
    getSession: (chatSessionId) => invoke(generatedApi?.getChatSession, { pathParams: { chatSessionId } }),
    createAnswer: (body, { csrfToken, idempotencyKey, chatSessionId } = {}) => invoke(generatedApi?.createGroundedAnswer, { body: JSON.stringify({ ...normalizeAnswerBody(body), ...(chatSessionId ? { chatSessionId } : {}) }), headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrfToken, 'Idempotency-Key': idempotencyKey } }),
    deleteSession: (chatSessionId, csrfToken) => invoke(generatedApi?.deleteChatSession, { pathParams: { chatSessionId }, headers: { 'X-CSRF-Token': csrfToken } }),
    clearSessions: (csrfToken) => invoke(generatedApi?.clearChatSessions, { headers: { 'X-CSRF-Token': csrfToken } }),
  })
}
