import { randomBytes } from 'node:crypto'
import { deriveLeaseKey } from '../../domain/jobs/lease-keys.js'

export const RECONCILIATION_RETRY_BACKOFF_MS = 60_000

function isControlFlowError(error, signal, deadline, now) {
  if (signal?.aborted || error?.name === 'AbortError' || error?.code === 'aborted') return true
  if (typeof error?.code === 'string' && error.code.startsWith('runtime_')) return true
  if (deadline === undefined) return false
  const deadlineAt = new Date(deadline).getTime()
  const currentAt = now()?.getTime?.()
  return Number.isFinite(deadlineAt) && Number.isFinite(currentAt) && currentAt >= deadlineAt
}
function cleanupDeadline({ now, deadline, settlementDeadline } = {}) {
  const current = now()
  const currentAt = current?.getTime?.()
  if (!Number.isFinite(currentAt)) throw new Error('Reconciliation cleanup clock is invalid')
  const hasGlobalDeadline = deadline !== undefined
  const hasBoundedDeadline = settlementDeadline !== undefined
  if (!hasGlobalDeadline && !hasBoundedDeadline) return { available: true, value: undefined }
  const globalAt = hasGlobalDeadline ? new Date(deadline).getTime() : Number.POSITIVE_INFINITY
  const boundedAt = hasBoundedDeadline ? new Date(settlementDeadline).getTime() : Number.POSITIVE_INFINITY
  if (!Number.isFinite(globalAt) && globalAt !== Number.POSITIVE_INFINITY) throw new Error('Reconciliation global deadline is invalid')
  if (!Number.isFinite(boundedAt) && boundedAt !== Number.POSITIVE_INFINITY) throw new Error('Reconciliation settlement deadline is invalid')
  const candidateAt = hasBoundedDeadline && boundedAt > currentAt ? Math.min(globalAt, boundedAt) : globalAt
  if (candidateAt <= currentAt) return { available: false, value: undefined }
  return { available: true, value: new Date(candidateAt) }
}

export function createReconciliationRunner({ repository, leaseRepository, now = () => new Date(), ownerToken = () => randomBytes(32).toString('hex'), maxPages = 10, pageLimit = 100, retryBackoffMs = RECONCILIATION_RETRY_BACKOFF_MS } = {}) {
  if (!repository || !leaseRepository || !Number.isInteger(maxPages) || maxPages < 1 || !Number.isInteger(pageLimit) || pageLimit < 1 || pageLimit > 100 || !Number.isInteger(retryBackoffMs) || retryBackoffMs < 1) throw new Error('Reconciliation runner configuration is invalid')
  return Object.freeze({
    async runDueSources({ signal, deadline, settlementDeadline = deadline } = {}) {
      const summary = { inspected: 0, created: 0, pages: 0, hasMore: false, failed: 0 }
      while (summary.pages < maxPages) {
        signal?.throwIfAborted?.()
        const source = await repository.selectPendingReconciliationSource({ now: now(), retryBackoffMs, ...(signal ? { signal } : {}), ...(deadline !== undefined ? { deadline } : {}) })
        if (!source) { summary.hasMore = false; break }
        const sourceId = String(source.id ?? source._id)
        const key = deriveLeaseKey('reconciliation', sourceId)
        const token = ownerToken()
        await leaseRepository.clearExpiredReconciliation?.({ key, now: now(), ...(signal ? { signal } : {}), ...(deadline !== undefined ? { deadline } : {}) })
        let fence
        try {
          fence = await leaseRepository.acquire({ key, jobId: sourceId, ownerToken: token, ...(signal ? { signal } : {}), ...(deadline !== undefined ? { deadline } : {}) })
        } catch (error) {
          if (error?.status === 409 && error?.code === 'conflict') { summary.hasMore = true; break }
          throw error
        }
        let failed = false
        try {
          const page = await repository.materializeReconciliationPage({ sourceId, fence, limit: pageLimit, now: now(), ...(signal ? { signal } : {}), ...(deadline !== undefined ? { deadline } : {}), ...(settlementDeadline !== undefined ? { settlementDeadline } : {}) })
          summary.inspected += Number(page?.inspected ?? 0)
          summary.created += Number(page?.created ?? 0)
          summary.pages += 1
          summary.hasMore = Boolean(page?.hasMore)
        } catch (error) {
          if (isControlFlowError(error, signal, deadline, now)) {
            summary.hasMore = true
            failed = true
          } else {
            const marked = await repository.markReconciliationFailure?.({
              sourceId, fence, now: now(), ...(signal ? { signal } : {}), ...(deadline !== undefined ? { deadline } : {}), ...(settlementDeadline !== undefined ? { settlementDeadline } : {}), error: { code: typeof error?.code === 'string' ? error.code : 'reconciliation_failed', retryable: Boolean(error?.retryable) },
            })
            if (marked !== false) { summary.failed += 1; summary.hasMore = false; failed = true } else throw error
          }
        } finally {
          const cleanup = cleanupDeadline({ now, deadline, settlementDeadline })
          if (!cleanup.available) {
            summary.hasMore = true
            failed = true
          } else {
            await leaseRepository.release({ ...fence, ownerToken: token, ...(cleanup.value !== undefined ? { deadline: cleanup.value } : {}) })
          }
        }
        if (failed) break
        if (!summary.hasMore) continue
      }
      return summary
    },
  })
}
