import {
  QA_NORMALIZER_VERSION,
  QA_PLANNER_VERSION,
  QA_TIME_ZONE,
  analyzeQaTemporal,
  assertQaIntentProposal,
  explicitScopeValid,
  freezeDeep,
  instantValue,
  monthRange,
  normalizedText,
  relativeRange,
  validateTimeZone,
} from './intent-planner.js'

const PLAN_VERSION = 'qa-execution-plan-v1'
const POLICY_VERSION = 'qa-policy-v1'
const DAY_MS = 86_400_000

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function hasExplicitDate(scope) {
  return scope?.publishedAfter !== undefined || scope?.publishedBefore !== undefined
}

function asIso(value, label) {
  const date = value instanceof Date ? new Date(value.getTime()) : new Date(value)
  if (Number.isNaN(date.getTime())) throw new TypeError(`${label} is invalid`)
  return date.toISOString()
}

function dateRangeFromProposal(temporal, reference, timeZone) {
  if (!isObject(temporal)) throw new TypeError('QA temporal proposal is invalid')
  if (temporal.kind === 'none' || temporal.kind === 'latest') return null
  if (temporal.kind === 'relative') {
    if (temporal.preset === 'calendar-month' && Number.isInteger(temporal.month)) {
      const local = new Intl.DateTimeFormat('en-US', { timeZone, year: 'numeric' }).formatToParts(reference)
      const year = Number(local.find(({ type }) => type === 'year')?.value)
      return monthRange(year, temporal.month, timeZone)
    }
    return relativeRange(temporal.preset, reference, timeZone)
  }
  if (temporal.kind === 'absolute') {
    if (typeof temporal.from !== 'string' || typeof temporal.to !== 'string') throw new TypeError('QA absolute temporal proposal is invalid')
    return { publishedAfter: asIso(temporal.from, 'QA temporal start'), publishedBefore: asIso(temporal.to, 'QA temporal end') }
  }
  return null
}

function effectiveScope(scope, range) {
  const result = { ...scope }
  if (range && !hasExplicitDate(scope)) return { ...result, publishedAfter: range.publishedAfter, publishedBefore: range.publishedBefore }
  return result
}

const MAX_QUERY_VARIANTS = 3
const MODEL_TOKEN_PATTERN = /[A-Za-z][A-Za-z0-9]*(?:[._-][A-Za-z0-9]+)*|\d+(?:\.\d+)*(?:[A-Za-z][A-Za-z0-9]*)?/gu
const MODEL_VERSION_PATTERN = /^v?\d+(?:\.\d+)+(?:[A-Za-z][A-Za-z0-9]*)?$|^v?\d+[A-Za-z][A-Za-z0-9]*$/iu
const MODEL_FAMILY_NAMES = new Set(['gpt', 'claude', 'gemini', 'llama', 'qwen'])
const MODEL_VARIANT_WORDS = new Set([
  'base',
  'chat',
  'coder',
  'flash',
  'haiku',
  'instruct',
  'large',
  'lite',
  'max',
  'mini',
  'opus',
  'pro',
  'reasoning',
  'small',
  'sonnet',
  'turbo',
  'ultra',
])
const MODEL_BOUNDARY_WORDS = new Set([
  'a',
  'about',
  'after',
  'all',
  'an',
  'and',
  'any',
  'are',
  'as',
  'at',
  'before',
  'be',
  'been',
  'by',
  'can',
  'co',
  'day',
  'days',
  'date',
  'did',
  'does',
  'for',
  'from',
  'find',
  'gi',
  'gan',
  'hom',
  'how',
  'in',
  'instead',
  'is',
  'latest',
  'mean',
  'meaning',
  'means',
  'model',
  'models',
  'month',
  'months',
  'moi',
  'nam',
  'nay',
  'new',
  'news',
  'ngay',
  'nhat',
  'of',
  'on',
  'or',
  'published',
  'question',
  'qua',
  'recent',
  'search',
  'security',
  'september',
  'show',
  'the',
  'this',
  'thang',
  'tin',
  'to',
  'today',
  'tuan',
  'tuần',
  'use',
  've',
  'version',
  'was',
  'were',
  'what',
  'when',
  'where',
  'which',
  'who',
  'why',
  'with',
  'week',
  'weeks',
  'year',
  'years',
])

function modelTokens(value) {
  const text = normalizedText(value)
  return [...text.matchAll(MODEL_TOKEN_PATTERN)].map((match) => ({ text: match[0], index: match.index ?? 0 }))
}

function canonicalModelToken(value) {
  return normalizedText(value).toLowerCase().replaceAll(/[\s_-]+/gu, '').replace(/^v(?=\d)/u, '')
}

function isKnownModelFamily(value) {
  return MODEL_FAMILY_NAMES.has(canonicalModelToken(value))
}

function isModelVersion(value) {
  return MODEL_VERSION_PATTERN.test(value)
}

function isBareModelVersion(value) {
  return /^v?\d+$/iu.test(value)
}

function isMixedModelToken(value) {
  return /[A-Za-z]/u.test(value) && /\d/u.test(value)
}

function isModelContextWord(value) {
  const token = canonicalModelToken(value)
  return /^[a-z]+$/u.test(token) && !MODEL_BOUNDARY_WORDS.has(token)
}

function isAdjacentModelToken(value, left, right) {
  return /^[\s]*$/u.test(value.slice(left.index + left.text.length, right.index))
}

function isPotentialModelVersion(tokens, index) {
  const token = tokens[index]?.text ?? ''
  if (isModelVersion(token)) return true
  if (!isBareModelVersion(token)) return false
  const previous = tokens[index - 1]
  return Boolean(previous && (isKnownModelFamily(previous.text) || isModelContextWord(previous.text)))
}

function isModelSuffix(value) {
  return isModelVersion(value) || MODEL_VARIANT_WORDS.has(canonicalModelToken(value))
}

function extendModelSignature(value, tokens, start, end) {
  let signatureEnd = end
  let suffixCount = 0
  while (signatureEnd + 1 < tokens.length && suffixCount < 2) {
    const next = tokens[signatureEnd + 1]
    if (!isAdjacentModelToken(value, tokens[signatureEnd], next) || !isModelSuffix(next.text)) break
    signatureEnd += 1
    suffixCount += 1
  }
  return { start, end: signatureEnd }
}

function modelSignatureFromMixedToken(value, tokens, index) {
  return extendModelSignature(value, tokens, index, index)
}

function modelSignatureFromFamily(value, tokens, start) {
  const family = tokens[start]
  if (!family || (!isKnownModelFamily(family.text) && !isMixedModelToken(family.text))) return null
  if (isMixedModelToken(family.text)) return modelSignatureFromMixedToken(value, tokens, start)

  let contextEnd = start
  for (let index = start + 1; index < Math.min(tokens.length, start + 5); index += 1) {
    if (!isAdjacentModelToken(value, tokens[index - 1], tokens[index])) break
    if (isPotentialModelVersion(tokens, index)) return extendModelSignature(value, tokens, start, index)
    if (!isModelContextWord(tokens[index].text)) break
    contextEnd = index
  }
  return { start, end: contextEnd }
}

function modelSignatureFromVersion(value, tokens, index) {
  if (!isPotentialModelVersion(tokens, index)) return null
  let start = index - 1
  let contextWords = 0
  while (start >= 0 && contextWords < 3 && isAdjacentModelToken(value, tokens[start], tokens[start + 1]) && isModelContextWord(tokens[start].text)) {
    start -= 1
    contextWords += 1
  }
  start += 1
  if (start === index) return null
  return extendModelSignature(value, tokens, start, index)
}

function canonicalModelSignature(tokens, { start, end }) {
  return tokens.slice(start, end + 1).map(({ text }) => canonicalModelToken(text)).join('')
}

function canonicalModelMentions(value) {
  const text = normalizedText(value)
  const tokens = modelTokens(text)
  const signatures = []
  let consumedUntil = -1
  tokens.forEach((_, index) => {
    if (index <= consumedUntil) return
    const signature = modelSignatureFromFamily(text, tokens, index) ?? modelSignatureFromVersion(text, tokens, index)
    if (!signature) return
    signatures.push(canonicalModelSignature(tokens, signature))
    consumedUntil = signature.end
  })
  return signatures.sort()
}

function modelMentionsMatch(requiredMentions, candidateMentions) {
  return requiredMentions.length === candidateMentions.length && requiredMentions.every((mention, index) => mention === candidateMentions[index])
}

function boundedQueryVariants(question, proposalVariants) {
  const requiredMentions = canonicalModelMentions(question)
  const retained = []
  const seen = new Set()
  for (const candidate of [question, ...proposalVariants]) {
    const normalized = normalizedText(candidate)
    if (!normalized || seen.has(normalized)) continue
    if (!modelMentionsMatch(requiredMentions, canonicalModelMentions(normalized))) continue
    retained.push(normalized)
    seen.add(normalized)
    if (retained.length >= MAX_QUERY_VARIANTS) break
  }
  return retained

}

function queryMetadata(question, proposal) {
  const sourceQuestion = question === undefined ? proposal.normalizedQuery : question
  const retrievalQuery = normalizedText(sourceQuestion)
  return { retrievalQuery, queryVariants: boundedQueryVariants(retrievalQuery, proposal.queryVariants) }
}

function clarificationPlan(proposal, clarificationValue, reference, timeZone, plannerVersion, normalizerVersion, queryPlan) {
  return freezeDeep({
    planVersion: PLAN_VERSION,
    decision: 'clarify',
    effectiveScope: {},
    retrievalQuery: queryPlan.retrievalQuery,
    queryVariants: queryPlan.queryVariants,
    temporal: {
      state: 'ambiguous',
      field: 'publishedAt',
      referenceInstant: reference.toISOString(),
      timeZone,
      provenance: { source: 'deterministic', plannerVersion, normalizerVersion },
    },
    ordering: ['relevance'],
    plannerVersion,
    normalizerVersion,
    budget: { maxPlannerCalls: 1, maxQueryVariants: queryPlan.queryVariants.length, deadlineMs: 30_000 },
    disclosure: 'Khong truy xuat du lieu cho den khi khoang thoi gian duoc lam ro.',
    provenance: { policyVersion: POLICY_VERSION, source: 'deterministic-compiler', clarification: clarificationValue },
  })
}

export function compileQaExecutionPlan({
  proposal,
  explicitScope,
  question,
  referenceInstant,
  timeZone = QA_TIME_ZONE,
  plannerVersion = QA_PLANNER_VERSION,
  normalizerVersion = QA_NORMALIZER_VERSION,
} = {}) {
  const checkedProposal = assertQaIntentProposal(proposal)
  if (!explicitScopeValid(explicitScope)) throw new TypeError('QA explicit scope is invalid')
  const reference = instantValue(referenceInstant)
  const zone = validateTimeZone(timeZone)
  const planner = typeof plannerVersion === 'string' && plannerVersion.length > 0 ? plannerVersion : QA_PLANNER_VERSION
  const normalizer = typeof normalizerVersion === 'string' && normalizerVersion.length > 0 ? normalizerVersion : QA_NORMALIZER_VERSION
  const queryPlan = queryMetadata(question, checkedProposal)

  const explicitDates = hasExplicitDate(explicitScope)
  const explicitRange = explicitDates
    ? { publishedAfter: asIso(explicitScope.publishedAfter, 'QA explicit temporal start'), publishedBefore: asIso(explicitScope.publishedBefore, 'QA explicit temporal end') }
    : null
  const analysis = !explicitDates && typeof question === 'string' && question.trim().length > 0
    ? analyzeQaTemporal({ question, referenceInstant: reference, timeZone: zone })
    : null
  const unsupportedTemporalKind = ['ambiguous', 'unsupported', 'conflicting'].includes(checkedProposal.temporal.kind)
  const providerTemporalMismatch = !explicitDates && analysis?.kind === 'none' && ['absolute', 'relative', 'latest'].includes(checkedProposal.temporal.kind)
  if (providerTemporalMismatch) {
    return clarificationPlan(checkedProposal, { code: 'qa_clarify_ambiguous_time', field: '/question', message: 'Vui long neu ro mot khoang thoi gian cu the de kiem tra.' }, reference, zone, planner, normalizer, queryPlan)
  }
  if (analysis?.kind === 'ambiguous' || !explicitDates && (unsupportedTemporalKind || checkedProposal.clarification)) {
    const fallbackCode = checkedProposal.temporal.kind === 'conflicting' ? 'qa_clarify_conflicting_time' : checkedProposal.temporal.kind === 'unsupported' ? 'qa_clarify_unsupported_time' : 'qa_clarify_ambiguous_time'
    const clarificationValue = analysis?.clarification ?? checkedProposal.clarification ?? { code: fallbackCode, field: '/question', message: 'Vui long neu ro mot khoang thoi gian cu the de tim kiem.' }
    return clarificationPlan(checkedProposal, clarificationValue, reference, zone, planner, normalizer, queryPlan)
  }

  const temporalSource = explicitDates
    ? { kind: 'absolute', from: explicitRange.publishedAfter, to: explicitRange.publishedBefore }
    : analysis
      ? (analysis.kind === 'latest' ? { kind: 'latest' } : analysis.kind === 'relative' ? { kind: 'relative', preset: analysis.preset, ...(analysis.month ? { month: analysis.month } : {}) } : analysis.kind === 'absolute' ? { kind: 'absolute', from: analysis.range.publishedAfter, to: analysis.range.publishedBefore } : { kind: 'none' })
      : checkedProposal.temporal
  const range = explicitRange ?? dateRangeFromProposal(temporalSource, reference, zone)
  const scope = effectiveScope(explicitScope, explicitDates ? null : range)
  const latest = temporalSource.kind === 'latest'
  const ordering = latest ? ['relevance', 'freshness'] : ['relevance']
  const temporal = range
    ? { state: 'range', field: 'publishedAt', publishedAfter: range.publishedAfter, publishedBefore: range.publishedBefore, referenceInstant: reference.toISOString(), timeZone: zone, provenance: { source: 'deterministic', plannerVersion: planner, normalizerVersion: normalizer } }
    : latest
      ? { state: 'latest', field: 'publishedAt', referenceInstant: reference.toISOString(), timeZone: zone, provenance: { source: 'deterministic', plannerVersion: planner, normalizerVersion: normalizer } }
      : { state: 'none', field: 'publishedAt', referenceInstant: reference.toISOString(), timeZone: zone, provenance: { source: 'deterministic', plannerVersion: planner, normalizerVersion: normalizer } }
  const disclosure = temporal.state === 'range' && checkedProposal.temporal.kind === 'relative' && checkedProposal.temporal.preset === 'recent-30d'
    ? 'Gan day duoc hieu la 30 ngay gan nhat; thoi diem tham chieu do may chu quan ly.'
    : 'Khoang thoi gian va truong publication duoc may chu xac dinh theo mui gio da kiem chung.'

  return freezeDeep({
    planVersion: PLAN_VERSION,
    decision: 'execute',
    effectiveScope: scope,
    retrievalQuery: queryPlan.retrievalQuery,
    queryVariants: queryPlan.queryVariants,
    temporal,
    ordering,
    plannerVersion: planner,
    normalizerVersion: normalizer,
    budget: { maxPlannerCalls: 1, maxQueryVariants: queryPlan.queryVariants.length, deadlineMs: 30_000 },
    disclosure,
    provenance: { policyVersion: POLICY_VERSION, source: 'deterministic-compiler', proposalVersion: checkedProposal.proposalVersion },
  })
}


export { PLAN_VERSION, POLICY_VERSION, DAY_MS }
