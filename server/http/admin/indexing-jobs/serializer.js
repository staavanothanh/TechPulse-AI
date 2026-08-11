function iso(value) {
  if (value === null || value === undefined) return null
  return value instanceof Date ? value.toISOString() : String(value)
}

export function serializeIndexingJobResponse(job) {
  return {
    id: job.id,
    idempotencyKey: job.idempotencyKey,
    articleId: job.articleId,
    sourceId: job.sourceId,
    expectedSourcePolicyVersion: job.expectedSourcePolicyVersion,
    task: job.task,
    trigger: job.trigger,
    status: job.status,
    attempt: job.attempt,
    availableAt: iso(job.availableAt),
    leaseGeneration: job.leaseGeneration,
    parentJobId: job.parentJobId ?? null,
    error: job.error ? { ...job.error, occurredAt: iso(job.error.occurredAt) } : null,
    createdAt: iso(job.createdAt),
    startedAt: iso(job.startedAt),
    finishedAt: iso(job.finishedAt),
  }
}
