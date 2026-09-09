import { safeErrorCode, safeSequence } from '../../../jobs/runtime-trace.js'

function iso(value) {
  if (value === null || value === undefined) return null
  const date = value instanceof Date ? value : new Date(value)
  return Number.isNaN(date.getTime()) ? null : date.toISOString()
}

function safeError(error) {
  if (!error) return null
  const occurredAt = iso(error.occurredAt)
  return {
    code: safeErrorCode(error.code),
    retryable: Boolean(error.retryable),
    occurredAt,
    ...(Number.isInteger(error.upstreamStatus) && error.upstreamStatus >= 100 && error.upstreamStatus <= 599
      ? { upstreamStatus: error.upstreamStatus }
      : {}),
  }
}
const MATERIALIZATION_REASONS = new Set(['materialized', 'already_materialized', 'no_eligible_sources', 'deferred', 'failed'])
const MATERIALIZATION_OUTCOMES = new Set(['completed', 'deferred', 'failed'])
const SAFE_TOKEN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/

function safePeriod(value) { return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) ? value : null }
function safeOrigin(value) { return typeof value === 'string' && SAFE_TOKEN.test(value) ? value : null }

export function serializeLifecycleEventResponse(event) {
  return {
    eventId: event.eventId,
    version: event.version ?? 1,
    runId: event.runId ?? null,
    queueName: event.queueName ?? null,
    task: event.task ?? null,
    jobId: event.jobId ?? null,
    articleId: event.articleId ?? null,
    sourceId: event.sourceId ?? null,
    sourceKey: event.sourceKey ?? null,
    sequence: safeSequence(event.sequence) ?? null,
    leaseGeneration: event.leaseGeneration ?? null,
    remainingClaims: event.remainingClaims ?? null,
    profileMaxJobs: event.profileMaxJobs ?? null,
    period: safePeriod(event.period),
    periodTimezone: event.periodTimezone === 'UTC' ? 'UTC' : null,
    materializationReason: MATERIALIZATION_REASONS.has(event.materializationReason) ? event.materializationReason : null,
    outcome: MATERIALIZATION_OUTCOMES.has(event.outcome) ? event.outcome : null,
    alreadyMaterialized: typeof event.alreadyMaterialized === 'boolean' ? event.alreadyMaterialized : null,
    completedAt: iso(event.completedAt),
    eligibleSourceCount: Number.isSafeInteger(event.eligibleSourceCount) && event.eligibleSourceCount >= 0 ? event.eligibleSourceCount : null,
    invocationOrigin: safeOrigin(event.invocationOrigin),
    stage: event.stage,
    eventType: event.eventType ?? 'phase',
    status: event.status,
    elapsedMs: event.elapsedMs ?? null,
    occurredAt: iso(event.occurredAt),
    counters: event.counters ? { ...event.counters } : null,
    error: safeError(event.error),
  }
}
