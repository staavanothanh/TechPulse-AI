import { sanitizeText } from '../domain/article/normalization.js'

const RICH_FIELDS = new Set(['titleVi', 'summaryVi', 'summaryParagraphsVi'])
const MIN_DETAIL_PARAGRAPHS = 2
const MAX_DETAIL_PARAGRAPHS = 5
const MIN_DETAIL_PARAGRAPH_CHARS = 20
const MAX_DETAIL_PARAGRAPH_CHARS = 2000
const MAX_DETAIL_TOTAL_CHARS = 6000
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

function hasExactFields(value, fields) {
  const keys = Object.keys(value)
  return keys.length === fields.size && keys.every((field) => fields.has(field))
}

function validateDetailParagraphs(value) {
  if (!Array.isArray(value) || value.length < MIN_DETAIL_PARAGRAPHS || value.length > MAX_DETAIL_PARAGRAPHS) throw new Error('Vietnamese summary paragraphs count is invalid')
  const paragraphs = value.map((paragraph) => {
    const safe = boundedVietnamese(paragraph, 'Vietnamese summary paragraph', MAX_DETAIL_PARAGRAPH_CHARS)
    if (Array.from(safe).length < MIN_DETAIL_PARAGRAPH_CHARS) throw new Error('Vietnamese summary paragraph length is invalid')
    return safe
  })
  if (paragraphs.reduce((total, paragraph) => total + Array.from(paragraph).length, 0) > MAX_DETAIL_TOTAL_CHARS) throw new Error('Vietnamese summary paragraphs total length is invalid')
  return Object.freeze(paragraphs)
}

export function validateVietnameseSummary(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || !hasExactFields(value, RICH_FIELDS)) throw new Error('summary output shape is invalid')
  const summaryVi = boundedVietnamese(value.summaryVi, 'Vietnamese summary', 4000)
  return Object.freeze({
    titleVi: boundedPlainText(value.titleVi, 'Summary title', 1000),
    summaryVi,
    summaryParagraphsVi: validateDetailParagraphs(value.summaryParagraphsVi),
  })
}
