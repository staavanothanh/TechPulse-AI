import { randomBytes } from 'node:crypto'
import { deriveLeaseKey } from '../../domain/jobs/lease-keys.js'

export const RECONCILIATION_RETRY_BACKOFF_MS = 60_000

export function createReconciliationRunner({ repository, leaseRepository, now = () => new Date(), ownerToken = () => randomBytes(32).toString('hex'), maxPages = 10, pageLimit = 100, retryBackoffMs = RECONCILIATION_RETRY_BACKOFF_MS } = {}) {
  if (!repository || !leaseRepository || !Number.isInteger(maxPages) || maxPages < 1 || !Number.isInteger(pageLimit) || pageLimit < 1 || pageLimit > 100 || !Number.isInteger(retryBackoffMs) || retryBackoffMs < 1) throw new Error('Reconciliation runner configuration is invalid')
  return Object.freeze({
    async runDueSources() {
      const summary = { inspected: 0, created: 0, pages: 0, hasMore: false, failed: 0 }
      while (summary.pages < maxPages) {
        const source = await repository.selectPendingReconciliationSource({ now: now(), retryBackoffMs })
        if (!source) { summary.hasMore = false; break }
        const sourceId = String(source.id ?? source._id)
        const key = deriveLeaseKey('reconciliation', sourceId)
        const token = ownerToken()
        await leaseRepository.clearExpiredReconciliation?.({ key, now: now() })
        let fence
        try { fence = await leaseRepository.acquire({ key, jobId: sourceId, ownerToken: token }) } catch (error) {
          if (error?.status === 409 && error?.code === 'conflict') { summary.hasMore = true; break }
          throw error
        }
        let failed = false
        try {
          const page = await repository.materializeReconciliationPage({ sourceId, fence, limit: pageLimit, now: now() })
          summary.inspected += Number(page?.inspected ?? 0)
          summary.created += Number(page?.created ?? 0)
          summary.pages += 1
          summary.hasMore = Boolean(page?.hasMore)
        } catch (error) {
          const marked = await repository.markReconciliationFailure?.({
            sourceId, fence, now: now(), error: { code: typeof error?.code === 'string' ? error.code : 'reconciliation_failed', retryable: Boolean(error?.retryable) },
          })
          if (marked !== false) { summary.failed += 1; summary.hasMore = false; failed = true } else throw error
        } finally {
          await leaseRepository.release({ ...fence, ownerToken: token })
        }
        if (failed) break
        if (!summary.hasMore) continue
      }
      return summary
    },
  })
}
