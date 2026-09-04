/**
 * Versioned, explicit-pattern-only temporal scope resolution for grounded Q&A.
 *
 * The resolver intentionally derives a range only when the caller already
 * selected a non-empty article or topic scope. This keeps the existing
 * AnswerScope route contract intact; natural-language-only questions remain
 * invalid until a caller supplies an explicit source constraint.
 *
 * Supported phrases are deliberately small and calendar-based:
 * Vietnamese: "tháng <1..12> này", "tháng này", "tháng trước",
 * "hôm nay", "hôm qua", "tuần này", "tuần qua".
 * English: "this month", "last month", "today", "yesterday",
 * "this week", "last week".
 * Month-number phrases use the injected clock's UTC year. Weeks run
 * Monday-Sunday. Multiple supported phrases, unknown variants, and invalid
 * clocks fail closed by leaving the supplied scope unchanged.
 */

export const QA_TEMPORAL_RESOLVER_VERSION = 'qa-temporal-v1'

const DAY_MS = 86_400_000
const WORD_BOUNDARY = '(?=$|[^\\p{L}\\p{N}])'
const PREFIX_BOUNDARY = '(?:^|[^\\p{L}\\p{N}])'

const TEMPORAL_PATTERNS = Object.freeze([
  { id: 'vi-month-number', pattern: new RegExp(`${PREFIX_BOUNDARY}tháng\\s+(1[0-2]|[1-9])\\s+này${WORD_BOUNDARY}`, 'iu') },
  { id: 'vi-month-current', pattern: new RegExp(`${PREFIX_BOUNDARY}tháng\\s+này${WORD_BOUNDARY}`, 'iu') },
  { id: 'vi-month-previous', pattern: new RegExp(`${PREFIX_BOUNDARY}tháng\\s+trước${WORD_BOUNDARY}`, 'iu') },
  { id: 'vi-day-current', pattern: new RegExp(`${PREFIX_BOUNDARY}hôm\\s+nay${WORD_BOUNDARY}`, 'iu') },
  { id: 'vi-day-previous', pattern: new RegExp(`${PREFIX_BOUNDARY}hôm\\s+qua${WORD_BOUNDARY}`, 'iu') },
  { id: 'vi-week-current', pattern: new RegExp(`${PREFIX_BOUNDARY}tuần\\s+này${WORD_BOUNDARY}`, 'iu') },
  { id: 'vi-week-previous', pattern: new RegExp(`${PREFIX_BOUNDARY}tuần\\s+qua${WORD_BOUNDARY}`, 'iu') },
  { id: 'en-month-current', pattern: new RegExp(`${PREFIX_BOUNDARY}this\\s+month${WORD_BOUNDARY}`, 'iu') },
  { id: 'en-month-previous', pattern: new RegExp(`${PREFIX_BOUNDARY}last\\s+month${WORD_BOUNDARY}`, 'iu') },
  { id: 'en-day-current', pattern: new RegExp(`${PREFIX_BOUNDARY}today${WORD_BOUNDARY}`, 'iu') },
  { id: 'en-day-previous', pattern: new RegExp(`${PREFIX_BOUNDARY}yesterday${WORD_BOUNDARY}`, 'iu') },
  { id: 'en-week-current', pattern: new RegExp(`${PREFIX_BOUNDARY}this\\s+week${WORD_BOUNDARY}`, 'iu') },
  { id: 'en-week-previous', pattern: new RegExp(`${PREFIX_BOUNDARY}last\\s+week${WORD_BOUNDARY}`, 'iu') },
])

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function hasSourceConstraint(scope) {
  const articleId = scope.articleId
  const hasArticle = articleId !== undefined && articleId !== null && String(articleId).trim().length > 0
  const hasTopics = Array.isArray(scope.topics) && scope.topics.length > 0
  return hasArticle || hasTopics
}

function hasExplicitDateBound(scope) {
  return Object.hasOwn(scope, 'publishedAfter') || Object.hasOwn(scope, 'publishedBefore')
}

function clockDate(now) {
  const value = typeof now === 'function' ? now() : now
  if (value === null || value === undefined || value === '') return null
  const date = value instanceof Date ? new Date(value.getTime()) : new Date(value)
  return Number.isNaN(date.getTime()) ? null : date
}

function dayRange(start) {
  const startMs = Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), start.getUTCDate())
  return {
    publishedAfter: new Date(startMs).toISOString(),
    publishedBefore: new Date(startMs + DAY_MS - 1).toISOString(),
  }
}

function monthRange(year, month, offset = 0) {
  const startMs = Date.UTC(year, month + offset, 1)
  const endMs = Date.UTC(year, month + offset + 1, 1) - 1
  return {
    publishedAfter: new Date(startMs).toISOString(),
    publishedBefore: new Date(endMs).toISOString(),
  }
}

function weekRange(current, offsetWeeks = 0) {
  const dayOfWeek = current.getUTCDay()
  const daysSinceMonday = (dayOfWeek + 6) % 7
  const mondayMs = Date.UTC(
    current.getUTCFullYear(),
    current.getUTCMonth(),
    current.getUTCDate() - daysSinceMonday + offsetWeeks * 7,
  )
  return {
    publishedAfter: new Date(mondayMs).toISOString(),
    publishedBefore: new Date(mondayMs + DAY_MS * 7 - 1).toISOString(),
  }
}

function rangeForPattern(pattern, match, current) {
  const year = current.getUTCFullYear()
  const month = current.getUTCMonth()
  if (pattern.id === 'vi-month-number') return monthRange(year, Number(match[1]) - 1)
  if (pattern.id === 'vi-month-current' || pattern.id === 'en-month-current') return monthRange(year, month)
  if (pattern.id === 'vi-month-previous' || pattern.id === 'en-month-previous') return monthRange(year, month, -1)
  if (pattern.id === 'vi-day-current' || pattern.id === 'en-day-current') return dayRange(current)
  if (pattern.id === 'vi-day-previous' || pattern.id === 'en-day-previous') return dayRange(new Date(current.getTime() - DAY_MS))
  if (pattern.id === 'vi-week-current' || pattern.id === 'en-week-current') return weekRange(current)
  if (pattern.id === 'vi-week-previous' || pattern.id === 'en-week-previous') return weekRange(current, -1)
  return null
}

function resolveRange(question, current) {
  if (typeof question !== 'string' || question.trim().length === 0) return null
  const matches = TEMPORAL_PATTERNS.flatMap((pattern) => {
    const globalPattern = new RegExp(pattern.pattern.source, `${pattern.pattern.flags}g`)
    return [...question.matchAll(globalPattern)].map((match) => ({ pattern, match }))
  })
  if (matches.length !== 1) return null
  return rangeForPattern(matches[0].pattern, matches[0].match, current)
}

/**
 * Resolve one explicit temporal phrase into canonical UTC bounds.
 *
 * @param {{question?: unknown, scope?: object, now?: Date|string|number|(() => Date|string|number)}} input
 * @returns {object} a new scope object; unsupported input is returned unchanged
 */
export function resolveQaTemporalScope({ question, scope = {}, now = new Date() } = {}) {
  if (!isObject(scope)) return scope
  const nextScope = { ...scope }
  if (!hasSourceConstraint(scope) || hasExplicitDateBound(scope)) return nextScope
  const current = clockDate(now)
  if (!current) return nextScope
  const range = resolveRange(question, current)
  return range ? { ...nextScope, ...range } : nextScope
}
