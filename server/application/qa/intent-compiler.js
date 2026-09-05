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

function clarificationPlan(proposal, clarificationValue, reference, timeZone, plannerVersion) {
  return freezeDeep({
    planVersion: PLAN_VERSION,
    decision: 'clarify',
    effectiveScope: {},
    retrievalQuery: normalizedText(proposal.normalizedQuery),
    temporal: { state: 'ambiguous', field: 'publishedAt', referenceInstant: reference.toISOString(), timeZone },
    ordering: ['relevance'],
    plannerVersion,
    normalizerVersion: QA_NORMALIZER_VERSION,
    budget: { maxPlannerCalls: 1, maxQueryVariants: 3, deadlineMs: 30_000 },
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

  const explicitDates = hasExplicitDate(explicitScope)
  const explicitRange = explicitDates
    ? { publishedAfter: asIso(explicitScope.publishedAfter, 'QA explicit temporal start'), publishedBefore: asIso(explicitScope.publishedBefore, 'QA explicit temporal end') }
    : null
  const analysis = !explicitDates && typeof question === 'string' && question.trim().length > 0
    ? analyzeQaTemporal({ question, referenceInstant: reference, timeZone: zone })
    : null
  const unsupportedTemporalKind = ['ambiguous', 'unsupported', 'conflicting'].includes(checkedProposal.temporal.kind)
  if (analysis?.kind === 'ambiguous' || !explicitDates && (unsupportedTemporalKind || checkedProposal.clarification)) {
    const fallbackCode = checkedProposal.temporal.kind === 'conflicting' ? 'qa_clarify_conflicting_time' : checkedProposal.temporal.kind === 'unsupported' ? 'qa_clarify_unsupported_time' : 'qa_clarify_ambiguous_time'
    const clarificationValue = analysis?.clarification ?? checkedProposal.clarification ?? { code: fallbackCode, field: '/question', message: 'Vui long neu ro mot khoang thoi gian cu the de tim kiem.' }
    return clarificationPlan(checkedProposal, clarificationValue, reference, zone, planner)
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
    ? { state: 'range', field: 'publishedAt', publishedAfter: range.publishedAfter, publishedBefore: range.publishedBefore, referenceInstant: reference.toISOString(), timeZone: zone }
    : latest
      ? { state: 'latest', field: 'publishedAt', referenceInstant: reference.toISOString(), timeZone: zone }
      : { state: 'none', field: 'publishedAt', referenceInstant: reference.toISOString(), timeZone: zone }
  const disclosure = temporal.state === 'range' && checkedProposal.temporal.kind === 'relative' && checkedProposal.temporal.preset === 'recent-30d'
    ? 'Gan day duoc hieu la 30 ngay gan nhat; thoi diem tham chieu do may chu quan ly.'
    : 'Khoang thoi gian va truong publication duoc may chu xac dinh theo mui gio da kiem chung.'

  return freezeDeep({
    planVersion: PLAN_VERSION,
    decision: 'execute',
    effectiveScope: scope,
    retrievalQuery: normalizedText(checkedProposal.normalizedQuery),
    temporal,
    ordering,
    plannerVersion: planner,
    normalizerVersion: normalizer,
    budget: { maxPlannerCalls: 1, maxQueryVariants: Math.min(3, checkedProposal.queryVariants.length), deadlineMs: 30_000 },
    disclosure,
    provenance: { policyVersion: POLICY_VERSION, source: 'deterministic-compiler', proposalVersion: checkedProposal.proposalVersion },
  })
}

export { PLAN_VERSION, POLICY_VERSION, DAY_MS }
