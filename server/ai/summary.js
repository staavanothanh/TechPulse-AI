import { sanitizeText } from '../domain/article/normalization.js'

const EXACT_FIELDS = new Set(['titleVi', 'summaryVi'])
const VIETNAMESE_SIGNAL = /[ăâđêôơưáàảãạấầẩẫậắằẳẵặéèẻẽẹếềểễệíìỉĩịóòỏõọốồổỗộớờởỡợúùủũụứừửữựýỳỷỹỵ]|\b(?:và|của|được|một|những|trong|với|giúp|nghiên cứu|công nghệ)\b/iu

function bounded(value, label, maximum) {
  if (typeof value !== 'string' || value.trim().length < 3 || Array.from(value).length > maximum) throw new Error(`${label} length is invalid`)
  const safe = sanitizeText(value, maximum)
  if (!safe || safe !== value.trim() || !VIETNAMESE_SIGNAL.test(safe)) throw new Error(`${label} must be plain Vietnamese text`)
  return safe
}

export function validateVietnameseSummary(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some((field) => !EXACT_FIELDS.has(field)) || Object.keys(value).length !== 2) throw new Error('summary output shape is invalid')
  return Object.freeze({
    titleVi: bounded(value.titleVi, 'Vietnamese summary title', 1000),
    summaryVi: bounded(value.summaryVi, 'Vietnamese summary', 4000),
  })
}
