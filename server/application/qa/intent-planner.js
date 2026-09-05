import { assertQaIntentProposal as assertDomainProposal } from '../../domain/qa/intent.js'

export const QA_TIME_ZONE = 'Asia/Ho_Chi_Minh'
export const QA_NORMALIZER_VERSION = 'qa-normalizer-v1'
export const QA_PLANNER_VERSION = 'qa-planner-v1'

const DAY_MS = 86_400_000
const MIN_QUESTION_LENGTH = 3
const MAX_QUESTION_LENGTH = 1_000
const WORD = '\\p{L}\\p{N}'
const BOUNDARY = `(?:^|[^${WORD}])`
const END_BOUNDARY = `(?=$|[^${WORD}])`

const TEMPORAL_CODES = Object.freeze({
  missingYear: 'qa_clarify_missing_year',
  ambiguous: 'qa_clarify_ambiguous_time',
  unsupported: 'qa_clarify_unsupported_time',
  conflicting: 'qa_clarify_conflicting_time',
  latest: 'qa_clarify_latest_unsupported',
  invalid: 'qa_clarify_invalid_date',
})

const TEMPORAL_MESSAGES = Object.freeze({
  [TEMPORAL_CODES.missingYear]: 'Vui lòng cho biết năm cụ thể của khoảng thời gian được hỏi.',
  [TEMPORAL_CODES.ambiguous]: 'Vui lòng nêu rõ một khoảng thời gian cụ thể để tìm kiếm.',
  [TEMPORAL_CODES.unsupported]: 'Khoảng thời gian này chưa được hỗ trợ; vui lòng nêu ngày, tháng hoặc năm cụ thể.',
  [TEMPORAL_CODES.conflicting]: 'Câu hỏi có nhiều khoảng thời gian khác nhau; vui lòng chọn một khoảng thời gian.',
  [TEMPORAL_CODES.latest]: 'Yêu cầu mới nhất cần một cách sắp xếp đã được kiểm chứng; vui lòng nêu khoảng thời gian cụ thể.',
  [TEMPORAL_CODES.invalid]: 'Ngày hoặc tháng trong câu hỏi không hợp lệ; vui lòng kiểm tra lại.',
})

const RELATIVE_PATTERNS = Object.freeze([
  { preset: 'today', regex: new RegExp(`${BOUNDARY}(?:hom\\s+nay|today)${END_BOUNDARY}`, 'giu') },
  { preset: 'yesterday', regex: new RegExp(`${BOUNDARY}(?:hom\\s+qua|yesterday)${END_BOUNDARY}`, 'giu') },
  { preset: 'this-week', regex: new RegExp(`${BOUNDARY}(?:tuan\\s+nay|this\\s+week)${END_BOUNDARY}`, 'giu') },
  { preset: 'last-week', regex: new RegExp(`${BOUNDARY}(?:tuan\\s+(?:qua|truoc)|last\\s+week)${END_BOUNDARY}`, 'giu') },
  { preset: 'this-month', regex: new RegExp(`${BOUNDARY}(?:thang\\s+nay|this\\s+month)${END_BOUNDARY}`, 'giu') },
  { preset: 'last-month', regex: new RegExp(`${BOUNDARY}(?:thang\\s+truoc|last\\s+month)${END_BOUNDARY}`, 'giu') },
  { preset: 'recent-30d', regex: new RegExp(`${BOUNDARY}(?:gan\\s+day|recently|recent)${END_BOUNDARY}`, 'giu') },
  { preset: 'latest', regex: new RegExp(`${BOUNDARY}(?:moi\\s+nhat|latest)${END_BOUNDARY}`, 'giu') },
])

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function freezeDeep(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value
  for (const nested of Object.values(value)) freezeDeep(nested)
  return Object.freeze(value)
}

function instantValue(value) {
  const date = value instanceof Date ? new Date(value.getTime()) : new Date(value)
  if (Number.isNaN(date.getTime())) throw new TypeError('QA reference instant is invalid')
  return date
}

function validateTimeZone(timeZone) {
  if (typeof timeZone !== 'string' || timeZone.length < 1 || timeZone.length > 100) throw new TypeError('QA time zone is invalid')
  try {
    const resolved = new Intl.DateTimeFormat('en-US', { timeZone }).resolvedOptions().timeZone
    if (!resolved) throw new Error('unresolved')
  } catch {
    throw new TypeError('QA time zone is invalid')
  }
  return timeZone
}

function normalizedText(value) {
  return String(value ?? '').normalize('NFD').replaceAll(/[\u0300-\u036f]/g, '').replaceAll(/đ/gi, 'd').replaceAll(/\s+/gu, ' ').trim()
}

function languageFor(question) {
  const text = normalizedText(question).toLocaleLowerCase('vi')
  const vietnamese = /\b(?:tin|hom|qua|nay|tuan|thang|gan|day|moi|nhat|co|gi|ve|bai)\b/u.test(text)
  const english = /\b(?:what|any|news|today|yesterday|this|last|week|month|recent|recently|latest|about|how|why)\b/u.test(text)
  if (vietnamese && english) return 'mixed'
  if (vietnamese) return 'vi'
  if (english) return 'en'
  return 'unknown'
}

function clarification(code) {
  return { code, field: '/question', message: TEMPORAL_MESSAGES[code] ?? TEMPORAL_MESSAGES[TEMPORAL_CODES.unsupported] }
}

function allMatches(text, regex) {
  return [...text.matchAll(new RegExp(regex.source, regex.flags.replace('g', '') + 'g'))]
}

function civilParts(date, timeZone) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(date)
  const values = Object.fromEntries(parts.filter(({ type }) => type !== 'literal').map(({ type, value }) => [type, value]))
  return { year: Number(values.year), month: Number(values.month), day: Number(values.day), hour: Number(values.hour), minute: Number(values.minute), second: Number(values.second) }
}

function offsetMinutes(date, timeZone) {
  const value = new Intl.DateTimeFormat('en-US', { timeZone, timeZoneName: 'longOffset' }).formatToParts(date).find(({ type }) => type === 'timeZoneName')?.value ?? 'GMT'
  if (value === 'GMT' || value === 'UTC') return 0
  const match = value.match(/^GMT([+-])(\d{1,2})(?::?(\d{2}))?$/u)
  if (!match) throw new TypeError('QA time zone offset is invalid')
  const minutes = Number(match[2]) * 60 + Number(match[3] ?? 0)
  return (match[1] === '-' ? -1 : 1) * minutes
}

function zonedCivilInstant({ year, month, day, hour = 0, minute = 0, second = 0, millisecond = 0 }, timeZone) {
  const naive = Date.UTC(year, month - 1, day, hour, minute, second, millisecond)
  let candidate = naive
  for (let index = 0; index < 4; index += 1) {
    const next = naive - offsetMinutes(new Date(candidate), timeZone) * 60_000
    if (next === candidate) return next
    candidate = next
  }
  return candidate
}

function civilDateAdd(civil, days) {
  const value = new Date(Date.UTC(civil.year, civil.month - 1, civil.day) + days * DAY_MS)
  return { year: value.getUTCFullYear(), month: value.getUTCMonth() + 1, day: value.getUTCDate() }
}

function rangeFromCivil(start, end, timeZone) {
  const startMs = zonedCivilInstant(start, timeZone)
  const endMs = zonedCivilInstant(end, timeZone)
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs <= startMs) throw new TypeError('QA temporal range is invalid')
  return { publishedAfter: new Date(startMs).toISOString(), publishedBefore: new Date(endMs - 1).toISOString() }
}

function relativeRange(preset, reference, timeZone) {
  const local = civilParts(reference, timeZone)
  const today = { year: local.year, month: local.month, day: local.day }
  if (preset === 'recent-30d') return { publishedAfter: new Date(reference.getTime() - 30 * DAY_MS).toISOString(), publishedBefore: reference.toISOString() }
  if (preset === 'today') return rangeFromCivil(today, civilDateAdd(today, 1), timeZone)
  if (preset === 'yesterday') { const start = civilDateAdd(today, -1); return rangeFromCivil(start, today, timeZone) }
  if (preset === 'this-month') return rangeFromCivil({ year: today.year, month: today.month, day: 1 }, today.month === 12 ? { year: today.year + 1, month: 1, day: 1 } : { year: today.year, month: today.month + 1, day: 1 }, timeZone)
  if (preset === 'last-month') {
    const currentStart = { year: today.year, month: today.month, day: 1 }
    const previousStart = today.month === 1 ? { year: today.year - 1, month: 12, day: 1 } : { year: today.year, month: today.month - 1, day: 1 }
    return rangeFromCivil(previousStart, currentStart, timeZone)
  }
  if (!['this-week', 'last-week'].includes(preset)) throw new TypeError('QA relative temporal preset is unsupported')
  const daysSinceMonday = (new Date(Date.UTC(today.year, today.month - 1, today.day)).getUTCDay() + 6) % 7
  const monday = civilDateAdd(today, -daysSinceMonday + (preset === 'last-week' ? -7 : 0))
  return rangeFromCivil(monday, civilDateAdd(monday, 7), timeZone)
}

function monthRange(year, month, timeZone) {
  const start = { year, month, day: 1 }
  const end = month === 12 ? { year: year + 1, month: 1, day: 1 } : { year, month: month + 1, day: 1 }
  return rangeFromCivil(start, end, timeZone)
}

function absoluteDateRange(year, month, day, timeZone) {
  const start = { year, month, day }
  const candidate = new Date(Date.UTC(year, month - 1, day))
  if (candidate.getUTCFullYear() !== year || candidate.getUTCMonth() + 1 !== month || candidate.getUTCDate() !== day) throw new TypeError('QA date is invalid')
  return rangeFromCivil(start, civilDateAdd(start, 1), timeZone)
}

function monthIntent(text) {
  const explicit = allMatches(text, new RegExp(`${BOUNDARY}thang\\s+(1[0-2]|[1-9])\\s+nam\\s+(20\\d{2})${END_BOUNDARY}`, 'giu'))
  if (explicit.length > 1) return { kind: 'ambiguous', clarification: clarification(TEMPORAL_CODES.conflicting) }
  if (explicit.length === 1) return { kind: 'absolute-month', month: Number(explicit[0][1]), year: Number(explicit[0][2]) }
  const current = allMatches(text, new RegExp(`${BOUNDARY}thang\\s+(1[0-2]|[1-9])\\s+nay${END_BOUNDARY}`, 'giu'))
  if (current.length > 1) return { kind: 'ambiguous', clarification: clarification(TEMPORAL_CODES.conflicting) }
  if (current.length === 1) return { kind: 'current-month-number', month: Number(current[0][1]) }
  const anyMonth = allMatches(text, new RegExp(`${BOUNDARY}thang\\s+(\\d{1,2})${END_BOUNDARY}`, 'giu'))
  if (anyMonth.length > 0) {
    const month = Number(anyMonth[0][1])
    return month >= 1 && month <= 12 ? { kind: 'ambiguous', clarification: clarification(TEMPORAL_CODES.missingYear) } : { kind: 'ambiguous', clarification: clarification(TEMPORAL_CODES.invalid) }
  }
  return null
}

function absoluteDateIntent(text) {
  const dates = allMatches(text, new RegExp(`${BOUNDARY}(20\\d{2})-(\\d{2})-(\\d{2})${END_BOUNDARY}`, 'giu'))
  if (dates.length > 1) return { kind: 'ambiguous', clarification: clarification(TEMPORAL_CODES.conflicting) }
  if (dates.length === 0) return null
  return { kind: 'absolute-date', year: Number(dates[0][1]), month: Number(dates[0][2]), day: Number(dates[0][3]) }
}

export function analyzeQaTemporal({ question, referenceInstant, timeZone = QA_TIME_ZONE } = {}) {
  const reference = instantValue(referenceInstant)
  const zone = validateTimeZone(timeZone)
  const text = normalizedText(question).toLocaleLowerCase('vi')
  if (!text) return Object.freeze({ kind: 'none' })
  const relative = RELATIVE_PATTERNS.flatMap((entry) => allMatches(text, entry.regex).map((match) => ({ kind: 'relative', preset: entry.preset, start: match.index ?? 0 })))
  const month = monthIntent(text)
  const absoluteDate = absoluteDateIntent(text)
  const explicit = [month, absoluteDate].filter(Boolean)
  const directClarification = explicit.find((item) => item.kind === 'ambiguous')
  if (directClarification) return Object.freeze({ kind: 'ambiguous', clarification: directClarification.clarification })
  const intents = [...relative, ...explicit]
  if (intents.length > 1) return Object.freeze({ kind: 'ambiguous', clarification: clarification(TEMPORAL_CODES.conflicting) })
  if (intents.length === 0) {
    const unknownTemporal = new RegExp(`${BOUNDARY}(?:ngay\\s+mai|tomorrow|date|quarter|quy|nam\\s+(?:nay|ngoai|truoc)|this\\s+year|last\\s+year|year\\s+20\\d{2}|thang|month|tuan|week)${END_BOUNDARY}`, 'iu').test(text)
    return Object.freeze(unknownTemporal ? { kind: 'ambiguous', clarification: clarification(TEMPORAL_CODES.unsupported) } : { kind: 'none' })
  }
  const intent = intents[0]
  if (intent.kind === 'relative') {
    if (intent.preset === 'latest') return Object.freeze({ kind: 'latest' })
    return Object.freeze({ kind: 'relative', preset: intent.preset, range: relativeRange(intent.preset, reference, zone) })
  }
  if (intent.kind === 'current-month-number') return Object.freeze({ kind: 'relative', preset: 'calendar-month', month: intent.month, range: monthRange(civilParts(reference, zone).year, intent.month, zone) })
  if (intent.kind === 'absolute-month') return Object.freeze({ kind: 'absolute', field: 'publishedAt', year: intent.year, month: intent.month, fromInclusive: true, toInclusive: true, range: monthRange(intent.year, intent.month, zone) })
  if (intent.kind === 'absolute-date') {
    try {
      return Object.freeze({ kind: 'absolute', field: 'publishedAt', year: intent.year, month: intent.month, day: intent.day, fromInclusive: true, toInclusive: true, range: absoluteDateRange(intent.year, intent.month, intent.day, zone) })
    } catch {
      return Object.freeze({ kind: 'ambiguous', clarification: clarification(TEMPORAL_CODES.invalid) })
    }
  }
  return Object.freeze({ kind: 'ambiguous', clarification: clarification(TEMPORAL_CODES.unsupported) })
}

function entityProposals(question) {
  const entities = []
  const pattern = /\b(?:GPT-\d+(?:\.\d+)?|Claude-\d+(?:\.\d+)?|Gemini(?:-\d+(?:\.\d+)?)?|Llama-\d+(?:\.\d+)?)\b/gu
  for (const match of question.matchAll(pattern)) {
    const mention = match[0]
    const version = mention.match(/(\d+(?:\.\d+)?)$/u)?.[1]
    entities.push({ mention, kind: 'model', ...(version ? { version } : {}), provenance: 'deterministic' })
  }
  return entities
}

function explicitScopeValid(scope) {
  if (!isObject(scope)) return false
  const hasArticle = typeof scope.articleId === 'string' && scope.articleId.trim().length > 0
  const hasTopics = Array.isArray(scope.topics) && scope.topics.length > 0 && scope.topics.every((topic) => typeof topic === 'string' && topic.trim().length > 0)
  const hasAfter = scope.publishedAfter !== undefined
  const hasBefore = scope.publishedBefore !== undefined
  if (hasAfter !== hasBefore) return false
  if (hasAfter) {
    const after = new Date(scope.publishedAfter)
    const before = new Date(scope.publishedBefore)
    if (Number.isNaN(after.getTime()) || Number.isNaN(before.getTime()) || after > before) return false
  }
  return hasArticle || hasTopics || hasAfter
}

export function assertQaPlannerInput(value) {
  if (!isObject(value) || typeof value.question !== 'string' || value.question.trim().length < MIN_QUESTION_LENGTH || value.question.length > MAX_QUESTION_LENGTH || !explicitScopeValid(value.explicitScope)) throw new TypeError('QA planner input is invalid')
  instantValue(value.referenceInstant)
  validateTimeZone(value.timeZone ?? QA_TIME_ZONE)
  return freezeDeep({ ...value, timeZone: value.timeZone ?? QA_TIME_ZONE })
}

export function assertQaIntentProposal(value) {
  if (!isObject(value) || Object.hasOwn(value, 'chainOfThought') || Object.hasOwn(value, 'apiKey')) throw new TypeError('QA intent proposal contains forbidden data')
  const checked = assertDomainProposal(value)
  if (!Array.isArray(checked.entities) || checked.entities.length > 16 || !Array.isArray(checked.queryVariants) || checked.queryVariants.length > 3) throw new TypeError('QA intent proposal bounds are invalid')
  return checked
}

export function planQaIntent({ question, explicitScope, referenceInstant, timeZone = QA_TIME_ZONE } = {}) {
  const input = assertQaPlannerInput({ question, explicitScope, referenceInstant, timeZone })
  const reference = instantValue(input.referenceInstant)
  const hasExplicitDateScope = input.explicitScope.publishedAfter !== undefined && input.explicitScope.publishedBefore !== undefined
  const analysis = hasExplicitDateScope ? { kind: 'none' } : analyzeQaTemporal({ question: input.question, referenceInstant: reference, timeZone: input.timeZone })
  let temporal
  let intent = 'qna'
  let clarificationValue = null
  if (analysis.kind === 'ambiguous') {
    temporal = { kind: 'ambiguous' }
    clarificationValue = analysis.clarification
  } else if (analysis.kind === 'latest') {
    temporal = { kind: 'latest' }
    intent = 'latest-news'
  } else if (analysis.kind === 'relative') {
    temporal = analysis.preset === 'calendar-month'
      ? { kind: 'absolute', field: 'publishedAt', from: analysis.range.publishedAfter, to: analysis.range.publishedBefore, fromInclusive: true, toInclusive: true }
      : { kind: 'relative', preset: analysis.preset }
    if (analysis.preset === 'recent-30d') intent = 'recent-news'
  } else if (analysis.kind === 'absolute') {
    temporal = { kind: 'absolute', field: 'publishedAt', from: analysis.range.publishedAfter, to: analysis.range.publishedBefore, fromInclusive: true, toInclusive: true }
  } else {
    temporal = { kind: 'none' }
  }
  const normalizedQuery = normalizedText(input.question)
  return assertQaIntentProposal(freezeDeep({
    proposalVersion: 'qa-intent-proposal-v1',
    language: languageFor(input.question),
    normalizedQuery,
    intent,
    entities: entityProposals(input.question),
    temporal,
    scopeHints: {},
    queryVariants: [normalizedQuery],
    clarification: clarificationValue,
    confidence: 1,
    provenance: { plannerVersion: QA_PLANNER_VERSION, source: 'deterministic' },
  }))
}

export { clarification, explicitScopeValid, instantValue, monthRange, normalizedText, relativeRange, validateTimeZone, freezeDeep, TEMPORAL_CODES }
