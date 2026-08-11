export class ArticleError extends Error {
  constructor(code, message = 'Article operation failed safely', { retryable = false, status = 409, details } = {}) {
    super(message)
    this.name = 'ArticleError'
    this.code = code
    this.retryable = retryable
    this.status = status
    if (details !== undefined) this.details = details
  }
}

export function invalidCandidate(details) {
  return new ArticleError('candidate_invalid', 'Article candidate is invalid', { status: 422, details })
}

export function sourcePolicyBlocked() {
  return new ArticleError('source_policy_blocked', 'Source policy does not permit ingestion', { status: 409 })
}

export function policyVersionMismatch() {
  return new ArticleError('policy_version_mismatch', 'Source policy changed during ingestion', { status: 409 })
}

export function leaseFenceStale() {
  return new ArticleError('lease_fence_stale', 'Ingestion lease fence is stale or expired', { status: 409 })
}

export function articleConflict() {
  return new ArticleError('article_conflict', 'Article changed concurrently', { status: 409, retryable: true })
}
