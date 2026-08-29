import { createReconciliationRunner, RECONCILIATION_RETRY_BACKOFF_MS } from './reconciliation.js'

const SOURCE_ID = /^[a-f0-9]{24}$/i
const MAX_PAGE_LIMIT = 100
const MAX_PAGES = 10
const RECONCILIATION_STATUSES = new Set(['pending', 'processing', 'failed'])

function normalizeSourceId(value) {
  if (typeof value !== 'string' || !SOURCE_ID.test(value)) throw new Error('Source identifier is invalid')
  return value.toLowerCase()
}

function pageLimit(value) {
  const result = Number(value)
  if (!Number.isInteger(result) || result < 1 || result > MAX_PAGE_LIMIT) throw new Error('Reconciliation page limit is invalid')
  return result
}

function maxPages(value) {
  const result = Number(value)
  if (!Number.isInteger(result) || result < 1 || result > MAX_PAGES) throw new Error('Reconciliation max pages is invalid')
  return result
}

function safeMarker(marker = {}) {
  return {
    status: marker.status ?? 'idle',
    requiredPolicyVersion: marker.requiredPolicyVersion ?? null,
    completedPolicyVersion: marker.completedPolicyVersion ?? null,
    requestedAt: marker.requestedAt ?? null,
    error: marker.error
      ? {
          code: typeof marker.error.code === 'string' ? marker.error.code : 'reconciliation_failed',
          message: typeof marker.error.message === 'string' ? marker.error.message : 'Reconciliation did not complete safely',
          retryable: Boolean(marker.error.retryable),
          occurredAt: marker.error.occurredAt ?? null,
        }
      : null,
  }
}

function sourceSummary(source) {
  return {
    sourceId: source?.id ?? null,
    sourceKey: source?.sourceKey ?? null,
    policyVersion: source?.policyVersion ?? null,
    requiredPolicyVersion: source?.reconciliation?.requiredPolicyVersion ?? null,
    operationalStatus: source?.operationalStatus ?? null,
    reconciliation: source?.reconciliation ? safeMarker(source.reconciliation) : null,
  }
}

function isRetryBackoffActive(source, at, retryBackoffMs) {
  const occurredAt = source.reconciliation?.error?.occurredAt
  if (source.reconciliation?.status !== 'failed' || !(occurredAt instanceof Date || typeof occurredAt === 'string')) return false
  const timestamp = new Date(occurredAt).getTime()
  return Number.isFinite(timestamp) && timestamp > at.getTime() - retryBackoffMs
}

function reportBase(source, mode) {
  return {
    outcome: 'completed',
    mode,
    ...sourceSummary(source),
    inspected: 0,
    wouldCreate: 0,
    created: 0,
    pages: 0,
    hasMore: false,
    staleArticleCount: 0,
    jobs: [],
    skippedReasons: [],
    failedReasons: [],
  }
}

function skipped(source, mode, reason) {
  return { ...reportBase(source, mode), outcome: 'skipped', skippedReasons: [reason] }
}

function targetRepository(indexingJobRepository, sourceId) {
  return {
    selectPendingReconciliationSource: (input) => indexingJobRepository.selectPendingReconciliationSource({ ...input, sourceId }),
    materializeReconciliationPage: (input) => indexingJobRepository.materializeReconciliationPage(input),
    markReconciliationFailure: (input) => indexingJobRepository.markReconciliationFailure(input),
  }
}

export function createSourcePolicyReconciliationWorker({
  sourceRepository,
  indexingJobRepository,
  leaseRepository,
  now = () => new Date(),
  ownerToken,
  maxPages: configuredMaxPages = MAX_PAGES,
  retryBackoffMs = RECONCILIATION_RETRY_BACKOFF_MS,
} = {}) {
  if (!sourceRepository || typeof sourceRepository.findSourceById !== 'function' || !indexingJobRepository || typeof indexingJobRepository.previewReconciliationPage !== 'function' || typeof indexingJobRepository.selectPendingReconciliationSource !== 'function' || typeof indexingJobRepository.materializeReconciliationPage !== 'function' || typeof indexingJobRepository.markReconciliationFailure !== 'function' || !leaseRepository) {
    throw new Error('Source policy reconciliation dependencies are required')
  }
  const boundedMaxPages = maxPages(configuredMaxPages)
  if (!Number.isInteger(retryBackoffMs) || retryBackoffMs < 1 || retryBackoffMs > 24 * 60 * 60 * 1000) throw new Error('Source policy reconciliation retry backoff is invalid')

  async function loadSource(sourceId) {
    const source = await sourceRepository.findSourceById(sourceId)
    if (!source) return null
    if (source.id !== sourceId) throw new Error('Source repository returned a mismatched source')
    return source
  }

  async function run({ sourceId: rawSourceId, dryRun = true, limit = MAX_PAGE_LIMIT, maxPages: requestedMaxPages = boundedMaxPages } = {}) {
    const sourceId = normalizeSourceId(rawSourceId)
    const boundedLimit = pageLimit(limit)
    const boundedPages = maxPages(requestedMaxPages)
    const source = await loadSource(sourceId)
    if (!source) return { ...reportBase({ id: sourceId }, dryRun ? 'dry-run' : 'execute'), outcome: 'skipped', skippedReasons: ['source_not_found'] }
    const mode = dryRun ? 'dry-run' : 'execute'
    if (source.operationalStatus === 'archived') return skipped(source, mode, 'source_archived')
    if (!RECONCILIATION_STATUSES.has(source.reconciliation?.status)) return skipped(source, mode, 'reconciliation_not_pending')
    if (source.policyVersion !== source.reconciliation?.requiredPolicyVersion) return skipped(source, mode, 'policy_version_drift')
    const at = now()
    if (!(at instanceof Date) || Number.isNaN(at.getTime())) throw new Error('Source policy reconciliation clock is invalid')
    if (isRetryBackoffActive(source, at, retryBackoffMs)) return skipped(source, mode, 'retry_backoff')

    if (dryRun) {
      const preview = await indexingJobRepository.previewReconciliationPage({ sourceId, limit: boundedLimit, now: at, retryBackoffMs })
      if (preview?.outcome === 'skipped') return skipped(source, mode, preview.reason ?? 'reconciliation_not_pending')
      const report = {
        ...reportBase(source, mode),
        inspected: Number(preview?.inspected ?? 0),
        wouldCreate: Number(preview?.wouldCreate ?? 0),
        staleArticleCount: Number(preview?.staleArticleCount ?? 0),
        hasMore: Boolean(preview?.hasMore),
        pages: preview ? 1 : 0,
        jobs: Array.isArray(preview?.wouldCreateJobs) ? preview.wouldCreateJobs : [],
      }
      return report
    }

    const runner = createReconciliationRunner({
      repository: targetRepository(indexingJobRepository, sourceId),
      leaseRepository,
      now,
      ...(ownerToken ? { ownerToken } : {}),
      maxPages: boundedPages,
      pageLimit: boundedLimit,
      retryBackoffMs,
    })
    const result = await runner.runDueSources()
    const outcome = result.failed > 0 ? 'failed' : result.hasMore ? 'partial' : result.pages === 0 ? 'skipped' : 'completed'
    const refreshedSource = await loadSource(sourceId) ?? source
    return {
      ...reportBase(refreshedSource, mode),
      outcome,
      inspected: result.inspected,
      created: result.created,
      pages: result.pages,
      hasMore: result.hasMore,
      skippedReasons: outcome === 'skipped' ? ['reconciliation_not_pending'] : result.hasMore && result.pages === 0 ? ['lease_conflict'] : [],
      failedReasons: result.failed > 0 ? ['reconciliation_failed'] : [],
    }
  }

  return Object.freeze({ run })
}

export const SOURCE_POLICY_RECONCILIATION_LIMIT = MAX_PAGE_LIMIT
export const SOURCE_POLICY_RECONCILIATION_MAX_PAGES = MAX_PAGES
