const IDENTITY = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/
const VERSION = /^(?:v|version[-_ ]?)?\d+(?:\.\d+){0,3}$/i
const SAFE_PLANNER_VERSION = /^[a-z0-9][a-z0-9._-]{0,63}$/i

export const QA_PLANNER_INPUT_VERSION = 'qa-planner-input-v1'
export const QA_INTENT_PROPOSAL_VERSION = 'qa-intent-proposal-v1'
export const QA_EXECUTION_PLAN_VERSION = 'qa-execution-plan-v1'
export const QA_PLANNER_VERSION = 'qa-planner-v1'
export const QA_NORMALIZER_VERSION = 'qa-normalizer-v1'

export const QA_CLARIFICATION_CODES = Object.freeze([
  'qa_clarify_missing_year',
  'qa_clarify_ambiguous_time',
  'qa_clarify_unsupported_time',
  'qa_clarify_conflicting_time',
  'qa_clarify_latest_unsupported',
  'qa_clarify_invalid_date',
])

export const QA_CLARIFICATION_FIELDS = Object.freeze([
  '/question',
  '/scope',
  '/scope/publishedAfter',
  '/scope/publishedBefore',
])

const PROPOSAL_KEYS = Object.freeze([
  'proposalVersion', 'language', 'normalizedQuery', 'intent', 'entities', 'temporal',
  'scopeHints', 'queryVariants', 'clarification', 'confidence', 'provenance',
])
const PLANNER_INPUT_KEYS = Object.freeze(['version', 'question', 'explicitScope', 'referenceInstant', 'timeZone'])
const TEMPORAL_KEYS = Object.freeze(['kind', 'preset', 'field', 'from', 'to', 'fromInclusive', 'toInclusive'])
const SCOPE_HINT_KEYS = Object.freeze(['articleId', 'articleIds', 'topics', 'publishedAfter', 'publishedBefore'])
const ENTITY_KEYS = Object.freeze(['mention', 'kind', 'version', 'provenance', 'start', 'end'])
const CLARIFICATION_KEYS = Object.freeze(['code', 'field', 'message'])
const PROVENANCE_KEYS = Object.freeze(['plannerVersion', 'source'])

function fail(message) {
  throw new TypeError(`QA intent ${message}`)
}

function exactObject(value, keys, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(`${label} must be an object`)
  const unknown = Object.keys(value).find((key) => !keys.includes(key))
  if (unknown) fail(`${label} contains unknown field ${unknown}; schema is closed`)
}

function boundedString(value, label, { min = 0, max = 1000 } = {}) {
  if (typeof value !== 'string' || value.length < min || value.length > max) fail(`${label} is invalid`)
  return value
}

function boundedArray(value, label, maximum) {
  if (!Array.isArray(value) || value.length > maximum) fail(`${label} is invalid`)
  return value
}

function dateString(value, label) {
  boundedString(value, label, { min: 1, max: 64 })
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) fail(`${label} is invalid`)
  return value
}

function freezeClone(value) {
  if (Array.isArray(value)) return Object.freeze(value.map(freezeClone))
  if (!value || typeof value !== 'object') return value
  return Object.freeze(Object.fromEntries(Object.entries(value).map(([key, item]) => [key, freezeClone(item)])))
}

function validateExplicitScope(scope, label = 'explicitScope') {
  exactObject(scope, ['articleId', 'topics', 'publishedAfter', 'publishedBefore'], label)
  if (scope.articleId !== undefined) boundedString(String(scope.articleId), `${label}.articleId`, { min: 1, max: 128 })
  if (scope.topics !== undefined) {
    boundedArray(scope.topics, `${label}.topics`, 10)
    if (scope.topics.some((topic) => typeof topic !== 'string' || topic.trim().length < 1 || topic.trim().length > 100)) fail(`${label}.topics is invalid`)
  }
  if (scope.publishedAfter !== undefined) dateString(scope.publishedAfter, `${label}.publishedAfter`)
  if (scope.publishedBefore !== undefined) dateString(scope.publishedBefore, `${label}.publishedBefore`)
  if ((scope.publishedAfter === undefined) !== (scope.publishedBefore === undefined)) fail(`${label} date range is invalid`)
  if (scope.publishedAfter !== undefined && new Date(scope.publishedAfter) > new Date(scope.publishedBefore)) fail(`${label} date range is invalid`)
  return scope
}

function validateTemporal(value) {
  exactObject(value, TEMPORAL_KEYS, 'proposal.temporal')
  const allowedKinds = new Set(['none', 'latest', 'relative', 'absolute', 'ambiguous', 'unsupported', 'conflicting'])
  const allowedPresets = new Set(['today', 'yesterday', 'this-week', 'last-week', 'this-month', 'last-month', 'recent-30d'])
  if (!allowedKinds.has(value.kind)) fail('temporal.kind is invalid')
  if (value.preset !== undefined && !allowedPresets.has(value.preset)) fail('temporal.preset is invalid')
  if (value.field !== undefined && value.field !== 'publishedAt') fail('temporal.field is invalid')
  if (value.from !== undefined) dateString(value.from, 'temporal.from')
  if (value.to !== undefined) dateString(value.to, 'temporal.to')
  if (value.fromInclusive !== undefined && typeof value.fromInclusive !== 'boolean') fail('temporal.fromInclusive is invalid')
  if (value.toInclusive !== undefined && typeof value.toInclusive !== 'boolean') fail('temporal.toInclusive is invalid')
  if (value.kind === 'relative' && (!allowedPresets.has(value.preset) || value.field !== undefined || value.from !== undefined || value.to !== undefined)) fail('relative temporal shape is invalid')
  if (value.kind === 'absolute' && (value.field !== 'publishedAt' || typeof value.from !== 'string' || typeof value.to !== 'string')) fail('absolute temporal bounds are required')
  if (['none', 'latest', 'ambiguous', 'unsupported', 'conflicting'].includes(value.kind) && Object.keys(value).length !== 1) fail('temporal shape is invalid')
  return value
}

function validateEntity(value, index) {
  exactObject(value, ENTITY_KEYS, `proposal.entities[${index}]`)
  const mention = boundedString(value.mention, `proposal.entities[${index}].mention`, { min: 1, max: 200 })
  if (!/^[\p{L}\p{N}][\p{L}\p{N} ._:/+\-#()]{0,199}$/u.test(mention)) fail(`entity ${index} is unsafe`)
  if (value.kind !== undefined && !['model', 'person', 'organization', 'topic', 'product', 'technology', 'unknown'].includes(value.kind)) fail(`entity ${index}.kind is invalid`)
  if (value.version !== undefined && (typeof value.version !== 'string' || !VERSION.test(value.version))) fail(`entity ${index}.version is invalid`)
  if (value.provenance !== undefined && !['deterministic', 'provider'].includes(value.provenance)) fail(`entity ${index}.provenance is invalid`)
  if (value.start !== undefined && (!Number.isInteger(value.start) || value.start < 0 || value.start > 1000)) fail(`entity ${index}.start is invalid`)
  if (value.end !== undefined && (!Number.isInteger(value.end) || value.end < 0 || value.end > 1000 || value.start !== undefined && value.end < value.start)) fail(`entity ${index}.end is invalid`)
  return value
}

function validateScopeHints(value) {
  exactObject(value, SCOPE_HINT_KEYS, 'proposal.scopeHints')
  if (value.articleId !== undefined) boundedString(String(value.articleId), 'proposal.scopeHints.articleId', { min: 1, max: 128 })
  if (value.articleIds !== undefined) {
    boundedArray(value.articleIds, 'proposal.scopeHints.articleIds', 20)
    if (value.articleIds.some((item) => typeof item !== 'string' || !IDENTITY.test(item))) fail('proposal.scopeHints.articleIds is invalid')
  }
  if (value.topics !== undefined) {
    boundedArray(value.topics, 'proposal.scopeHints.topics', 10)
    if (value.topics.some((item) => typeof item !== 'string' || item.trim().length < 1 || item.length > 100)) fail('proposal.scopeHints.topics is invalid')
  }
  if (value.publishedAfter !== undefined) dateString(value.publishedAfter, 'proposal.scopeHints.publishedAfter')
  if (value.publishedBefore !== undefined) dateString(value.publishedBefore, 'proposal.scopeHints.publishedBefore')
  return value
}

function validateClarification(value) {
  if (value === null) return value
  exactObject(value, CLARIFICATION_KEYS, 'proposal.clarification')
  if (!QA_CLARIFICATION_CODES.includes(value.code)) fail('clarification.code is invalid')
  if (!QA_CLARIFICATION_FIELDS.includes(value.field)) fail('clarification.field is invalid')
  boundedString(value.message, 'clarification.message', { min: 1, max: 500 })
  return value
}

function validateProvenance(value) {
  exactObject(value, PROVENANCE_KEYS, 'proposal.provenance')
  boundedString(value.plannerVersion, 'provenance.plannerVersion', { min: 1, max: 64 })
  if (!SAFE_PLANNER_VERSION.test(value.plannerVersion)) fail('provenance.plannerVersion is invalid')
  if (value.source !== undefined && !['deterministic', 'provider'].includes(value.source)) fail('provenance.source is invalid')
  return value
}

export function assertQaPlannerInput(value) {
  exactObject(value, PLANNER_INPUT_KEYS, 'planner input')
  if (value.version !== QA_PLANNER_INPUT_VERSION) fail('planner input version is invalid')
  boundedString(value.question, 'planner input question', { min: 3, max: 1000 })
  validateExplicitScope(value.explicitScope)
  dateString(value.referenceInstant, 'planner input referenceInstant')
  boundedString(value.timeZone, 'planner input timeZone', { min: 1, max: 100 })
  try { new Intl.DateTimeFormat('en-US', { timeZone: value.timeZone }).format() } catch { fail('planner input timeZone is invalid') }
  return freezeClone(value)
}

export function assertQaIntentProposal(value) {
  exactObject(value, PROPOSAL_KEYS, 'proposal')
  if (value.proposalVersion !== QA_INTENT_PROPOSAL_VERSION) fail('proposalVersion is invalid')
  if (!['vi', 'en', 'mixed', 'unknown'].includes(value.language)) fail('language is invalid')
  boundedString(value.normalizedQuery, 'normalizedQuery', { min: 1, max: 1000 })
  if (!['qna', 'recent-news', 'latest-news', 'answer'].includes(value.intent)) fail('intent is invalid')
  boundedArray(value.entities, 'entities', 20)
  value.entities.forEach(validateEntity)
  validateTemporal(value.temporal)
  validateScopeHints(value.scopeHints)
  boundedArray(value.queryVariants, 'queryVariants', 3)
  if (value.queryVariants.length < 1 || value.queryVariants.some((item) => typeof item !== 'string' || item.trim().length < 1 || item.length > 1000)) fail('queryVariants are invalid')
  if (new Set(value.queryVariants).size !== value.queryVariants.length) fail('queryVariants contain duplicates')
  validateClarification(value.clarification)
  if (typeof value.confidence !== 'number' || !Number.isFinite(value.confidence) || value.confidence < 0 || value.confidence > 1) fail('confidence is invalid')
  validateProvenance(value.provenance)
  return freezeClone(value)
}

export function clarificationForCode(code) {
  const messages = {
    qa_clarify_missing_year: 'Bạn vui lòng cho biết năm cụ thể của khoảng thời gian được hỏi.',
    qa_clarify_ambiguous_time: 'Bạn vui lòng nêu rõ một khoảng thời gian cụ thể để mình tìm kiếm.',
    qa_clarify_unsupported_time: 'Khoảng thời gian này chưa được hỗ trợ; bạn vui lòng nêu ngày, tháng hoặc năm cụ thể.',
    qa_clarify_conflicting_time: 'Câu hỏi có nhiều khoảng thời gian khác nhau; bạn vui lòng chọn một khoảng thời gian.',
    qa_clarify_latest_unsupported: 'Yêu cầu “mới nhất” chưa thể xác định an toàn; bạn vui lòng nêu khoảng thời gian cụ thể.',
    qa_clarify_invalid_date: 'Ngày hoặc tháng trong câu hỏi không hợp lệ; bạn vui lòng kiểm tra lại.',
  }
  return messages[code] ?? messages.qa_clarify_unsupported_time
}

export { PROPOSAL_KEYS, TEMPORAL_KEYS, validateExplicitScope }
