function iso(value) {
  if (value === null || value === undefined) return null
  return value instanceof Date ? value.toISOString() : String(value)
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
    error: job.error ? { ...job.error, occurredAt: iso(job.error.occurredAt) } : null,
    createdAt: iso(job.createdAt),
    startedAt: iso(job.startedAt),
    finishedAt: iso(job.finishedAt),
  }
}
