const ARTICLE_ID_PATTERN = /^[0-9a-fA-F]{24}$/

const REFUSAL_REASONS = new Set(['sensitive-input', 'insufficient-evidence', 'policy-blocked', 'provider-unavailable'])

export const refusalCopy = (reason) => {
  const copy = {
    'sensitive-input': { title: 'Thông tin nhạy cảm chưa được gửi', body: 'Câu hỏi có thể chứa thông tin nhạy cảm. Hãy xóa thông tin đó rồi viết lại.', reason },
    'insufficient-evidence': { title: 'Chưa đủ bằng chứng', body: 'Chưa có đủ nguồn phù hợp để trả lời chắc chắn trong phạm vi hiện tại.', reason },
    'policy-blocked': { title: 'Nguồn không được phép dùng', body: 'Phạm vi hiện tại không có nguồn phù hợp. Hãy chọn phạm vi khác.', reason },
    'provider-unavailable': { title: 'Dịch vụ trả lời tạm chưa khả dụng', body: 'Hệ thống chưa nhận được kết quả an toàn. Bạn có thể thử lại sau.', reason },
  }
  if (reason === 'community-only' || reason === 'media-only' || reason === 'unsupported' || reason === 'uncertain') return { ...copy['insufficient-evidence'], reason: 'insufficient-evidence' }
  return copy[reason] ?? copy['insufficient-evidence']
}

const invalid = (firstInvalid, message) => ({ valid: false, firstInvalid, message })
export function hasQaScope(scope = {}) {
  if (!scope || typeof scope !== 'object' || Array.isArray(scope)) return false
  const articleId = scope.articleId
  const hasArticle = typeof articleId === 'string' && ARTICLE_ID_PATTERN.test(articleId)
  const articleProvided = articleId !== undefined && articleId !== null && (typeof articleId !== 'string' || articleId.trim().length > 0)
  if (articleProvided && !hasArticle) return false
  const topics = scope.topics === undefined ? [] : scope.topics
  const normalizedTopics = Array.isArray(topics) ? topics.map((topic) => typeof topic === 'string' ? topic.trim().toLowerCase() : topic) : []
  const topicsValid = Array.isArray(topics) && topics.length <= 10 && new Set(normalizedTopics).size === topics.length && topics.every((topic) => typeof topic === 'string' && topic.trim().length > 0 && topic.trim().length <= 100)
  if (!topicsValid) return false
  const hasAfter = Boolean(scope.publishedAfter)
  const hasBefore = Boolean(scope.publishedBefore)
  if (hasAfter !== hasBefore) return false
  if (hasAfter) {
    const after = Date.parse(scope.publishedAfter)
    const before = Date.parse(scope.publishedBefore)
    if (Number.isNaN(after) || Number.isNaN(before) || after > before) return false
  }
  return Boolean(hasArticle || topics.length > 0 || hasAfter)
}

const QA_FIELD_ORDER = Object.freeze(['question', 'articleId', 'topics', 'publishedAfter', 'publishedBefore', 'scope'])

export function firstQaFieldError(errors = {}) {
  return QA_FIELD_ORDER.find((field) => typeof errors[field] === 'string' && errors[field]) ?? null
}

export function boundedQaCooldown(error) {
  if (![429, 503].includes(error?.status)) return 0
  const seconds = Number(error.retryAfter)
  return Number.isInteger(seconds) && seconds > 0 ? Math.min(seconds, 300) : 60
}

export function appendSessionPage(current = [], next = []) {
  const existing = new Set(current.map((session) => session.id))
  return [...current, ...next.filter((session) => !existing.has(session.id))]
}

export function validateQuestionScope(question, scope = {}) {
  const value = typeof question === 'string' ? question.trim() : ''
  if (value.length < 3) return invalid('question', 'Câu hỏi cần ít nhất 3 ký tự.')
  if (value.length > 1000) return invalid('question', 'Câu hỏi tối đa 1.000 ký tự.')
  if (!scope || typeof scope !== 'object' || Array.isArray(scope)) return invalid('scope', 'Chọn ít nhất một phạm vi nguồn.')
  if (scope.articleId !== undefined && scope.articleId !== null && (typeof scope.articleId !== 'string' || (scope.articleId.trim().length > 0 && !ARTICLE_ID_PATTERN.test(scope.articleId)))) return invalid('articleId', 'Mã bài viết không hợp lệ.')
  const topics = scope.topics === undefined ? [] : scope.topics
  const normalizedTopics = Array.isArray(topics) ? topics.map((topic) => typeof topic === 'string' ? topic.trim().toLowerCase() : topic) : []
  if (!Array.isArray(topics) || topics.length > 10 || new Set(normalizedTopics).size !== topics.length || topics.some((topic) => typeof topic !== 'string' || topic.trim().length === 0 || topic.trim().length > 100)) return invalid('topics', 'Chọn tối đa 10 chủ đề khác nhau.')
  const hasAfter = Boolean(scope.publishedAfter)
  const hasBefore = Boolean(scope.publishedBefore)
  if (hasAfter !== hasBefore) return invalid(hasAfter ? 'publishedBefore' : 'publishedAfter', 'Cần nhập đủ hai mốc thời gian.')
  if (hasAfter && (Number.isNaN(Date.parse(scope.publishedAfter)) || Number.isNaN(Date.parse(scope.publishedBefore)))) return invalid('publishedAfter', 'Mốc thời gian không hợp lệ.')
  if (hasAfter && Date.parse(scope.publishedAfter) > Date.parse(scope.publishedBefore)) return invalid('publishedAfter', 'Mốc bắt đầu phải trước mốc kết thúc.')
  if (!hasQaScope(scope)) return invalid('scope', 'Chọn bài viết, chủ đề hoặc một khoảng thời gian.')
  return { valid: true, firstInvalid: null, message: '' }
}

function answerFromPayload(payload) {
  return payload?.data ?? payload
}

export function validateAnswerPayload(payload) {
  const answer = answerFromPayload(payload)
  if (!answer || typeof answer !== 'object' || !['answered', 'refused'].includes(answer.status)) return { valid: false, reason: 'shape' }
  if (answer.status === 'refused') {
    return { valid: Array.isArray(answer.paragraphs) && answer.paragraphs.length === 0 && Array.isArray(answer.citations) && answer.citations.length === 0 && REFUSAL_REASONS.has(answer.refusalReason), answer, reason: 'shape' }
  }
  if (!Array.isArray(answer.paragraphs) || answer.paragraphs.length < 1 || answer.paragraphs.length > 12 || !Array.isArray(answer.citations) || answer.citations.length < 1 || answer.citations.length > 50 || answer.refusalReason !== null) return { valid: false, answer, reason: 'shape' }
  const citations = new Set(answer.citations.map((citation) => citation?.id))
  const paragraphsValid = answer.paragraphs.every((paragraph) => typeof paragraph?.text === 'string' && paragraph.text.length > 0 && paragraph.text.length <= 2000 && Array.isArray(paragraph.citationIds) && paragraph.citationIds.length > 0 && paragraph.citationIds.length <= 10 && new Set(paragraph.citationIds).size === paragraph.citationIds.length && paragraph.citationIds.every((id) => citations.has(id)))
  return { valid: paragraphsValid, answer, reason: 'shape' }
}

export function validateSessionDetail(detail) {
  if (!detail || typeof detail !== 'object' || !Array.isArray(detail.messages) || detail.messages.length > 30 || detail.messageCount !== detail.messages.length) return { valid: false }
  const messages = detail.messages
  const valid = messages.every((message) => {
    if (message?.role === 'user') return typeof message.text === 'string' && message.text.length > 0
    return validateAnswerPayload({ data: message }).valid
  })
  return { valid, detail }
}

export function safeDate(value) {
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? '' : date.toLocaleString('vi-VN', { dateStyle: 'medium', timeStyle: 'short' })
}
