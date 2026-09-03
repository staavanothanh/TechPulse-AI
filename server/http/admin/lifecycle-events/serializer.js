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
    stage: event.stage,
    eventType: event.eventType ?? 'phase',
    status: event.status,
    elapsedMs: event.elapsedMs ?? null,
    occurredAt: iso(event.occurredAt),
    counters: event.counters ? { ...event.counters } : null,
    error: safeError(event.error),
  }
}
