function iso(value) {
  if (value === null || value === undefined) return null
  return value instanceof Date ? value.toISOString() : String(value)
}

function safeError(error) {
  if (!error) return null
  return { code: 'job_failed', message: 'Indexing job did not complete safely', retryable: Boolean(error.retryable), occurredAt: iso(error.occurredAt), ...(Number.isInteger(error.upstreamStatus) ? { upstreamStatus: error.upstreamStatus } : {}) }
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
    error: safeError(job.error),
    createdAt: iso(job.createdAt),
    startedAt: iso(job.startedAt),
    finishedAt: iso(job.finishedAt),
  }
}
