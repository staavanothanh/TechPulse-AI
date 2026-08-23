import { sanitizeText } from '../domain/article/normalization.js'

const EXACT_FIELDS = new Set(['titleVi', 'summaryVi'])
const VIETNAMESE_SIGNAL = /[ăâđêôơưáàảãạấầẩẫậắằẳẵặéèẻẽẹếềểễệíìỉĩịóòỏõọốồổỗộớờởỡợúùủũụứừửữựýỳỷỹỵ]|\b(?:và|của|được|một|những|trong|với|giúp|nghiên cứu|công nghệ)\b/iu

function boundedPlainText(value, label, maximum) {
  if (typeof value !== 'string' || value.trim().length < 3 || Array.from(value).length > maximum) throw new Error(`${label} length is invalid`)
  const normalized = value.normalize('NFKC').replace(/\s+/g, ' ').trim()
  const safe = sanitizeText(value, maximum)
  if (!safe || safe !== normalized) throw new Error(`${label} must be plain text`)
  return safe
}

function boundedVietnamese(value, label, maximum) {
  const safe = boundedPlainText(value, label, maximum)
  if (!VIETNAMESE_SIGNAL.test(safe)) throw new Error(`${label} must be Vietnamese text`)
  return safe
}

export function validateVietnameseSummary(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some((field) => !EXACT_FIELDS.has(field)) || Object.keys(value).length !== 2) throw new Error('summary output shape is invalid')
  return Object.freeze({
    titleVi: boundedPlainText(value.titleVi, 'Summary title', 1000),
    summaryVi: boundedVietnamese(value.summaryVi, 'Vietnamese summary', 4000),
  })
}
