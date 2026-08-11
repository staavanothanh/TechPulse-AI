import { randomBytes } from 'node:crypto'
import { deriveLeaseKey } from '../domain/jobs/lease-keys.js'

function safeOutcomeError(error, now) {
  if (!error) return undefined
  return {
    code: typeof error.code === 'string' && /^[a-z0-9_:-]{1,128}$/.test(error.code) ? error.code : 'worker_failed',
    message: 'Indexing job did not complete safely', retryable: Boolean(error.retryable), occurredAt: now,
    ...(Number.isInteger(error.upstreamStatus) && error.upstreamStatus >= 100 && error.upstreamStatus <= 599 ? { upstreamStatus: error.upstreamStatus } : {}),
  }
}

export function createIndexingQueueAdapter({ jobRepository, leaseRepository, executor, leaseMs = 30_000, ownerToken = () => randomBytes(32).toString('hex') } = {}) {
  if (!jobRepository || !leaseRepository) throw new Error('Indexing job and lease repositories are required')
  return Object.freeze({
    queueName: 'indexing',
    recoveryStrategy: 'terminal-parent-linked-retry',
    selectDue: ({ now }) => jobRepository.selectDueIndexing({ now }),
    recoverExpired: ({ now, limit }) => jobRepository.recoverExpiredIndexing({ leaseRepository, now, limit }),
    nextAvailableAt: () => jobRepository.nextAvailableAt(),
    async claimAndExecute({ candidate, now = new Date() } = {}) {
      const token = ownerToken()
      let fence
      try { fence = await leaseRepository.acquire({ key: deriveLeaseKey('indexing', candidate.articleId), jobId: candidate.id, ownerToken: token, leaseMs }) } catch (error) {
        if (error?.status === 409 && error?.code === 'conflict') return { status: 'deferred', claimed: false }
        throw error
      }
      const claimed = await jobRepository.claimQueuedWithFence({ jobId: candidate.id, fence })
      if (!claimed) {
        await leaseRepository.release({ ...fence, ownerToken: token })
        return { status: 'deferred', claimed: false }
      }
      if (typeof executor !== 'function') {
        const deferred = await jobRepository.deferWithFence({ jobId: candidate.id, fence, delayMs: 5 * 60 * 1000 })
        return { status: deferred?.status === 'cancelled' ? 'partial' : 'deferred', claimed: true }
      }
      if (typeof jobRepository.cancellationRequestedWithFence === 'function' && await jobRepository.cancellationRequestedWithFence({ jobId: candidate.id, fence })) {
        await jobRepository.completeWithFence({ jobId: candidate.id, fence, status: 'cancelled' })
        return { status: 'partial', claimed: true }
      }
      let outcome
      try { outcome = await executor({ job: candidate, fence, ownerToken: token, now }) } catch (error) {
        outcome = { status: 'failed', error: { code: error?.code ?? 'worker_failed', retryable: Boolean(error?.retryable), upstreamStatus: error?.upstreamStatus } }
      }
      const status = ['succeeded', 'partial', 'failed', 'cancelled'].includes(outcome?.status) ? outcome.status : 'failed'
      const finishedAt = new Date()
      await jobRepository.completeWithFence({ jobId: candidate.id, fence, status, error: safeOutcomeError(outcome?.error, finishedAt), inputHash: outcome?.inputHash })
      return { status: status === 'cancelled' ? 'partial' : status, claimed: true }
    },
  })
}
