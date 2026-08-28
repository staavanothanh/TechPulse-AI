function iso(value) {
  if (value === null || value === undefined) return null
  return value instanceof Date ? value.toISOString() : String(value)
}

function safeError(error) {
  if (!error) return null
  return { code: 'job_failed', message: 'Ingestion job did not complete safely', retryable: Boolean(error.retryable), occurredAt: iso(error.occurredAt), ...(Number.isInteger(error.upstreamStatus) ? { upstreamStatus: error.upstreamStatus } : {}) }
}

export function serializeIngestionJobResponse(job) {
  return {
    id: job.id,
    idempotencyKey: job.idempotencyKey,
    sourceId: job.sourceId,
    connectorType: job.connectorType,
    expectedSourcePolicyVersion: job.expectedSourcePolicyVersion,
    trigger: job.trigger,
    status: job.status,
    attempt: job.attempt,
    availableAt: iso(job.availableAt),
    leaseGeneration: job.leaseGeneration,
    batchSize: job.batchSize,
    parentJobId: job.parentJobId ?? null,
    counters: { ...job.counters },
    retryAvailable: Boolean(job.retryAvailable),
    error: safeError(job.error),
    createdAt: iso(job.createdAt),
    startedAt: iso(job.startedAt),
    finishedAt: iso(job.finishedAt),
  }
}
