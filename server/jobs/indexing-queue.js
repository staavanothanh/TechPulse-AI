import { randomBytes } from 'node:crypto'
import { deriveLeaseKey } from '../domain/jobs/lease-keys.js'

function safeOutcomeError(error, now) {
  if (!error) return undefined
  return {
    code: typeof error.code === 'string' && /^[a-z0-9_:-]{1,128}$/.test(error.code) ? error.code : 'worker_failed',
    message: 'Indexing job did not complete safely', retryable: Boolean(error.retryable) || error.code === 'lease_fence_stale', occurredAt: now,
    ...(Number.isInteger(error.upstreamStatus) && error.upstreamStatus >= 100 && error.upstreamStatus <= 599 ? { upstreamStatus: error.upstreamStatus } : {}),
  }
}

const MIN_DEFER_MS = 1_000
const MAX_DEFER_MS = 15 * 60 * 1_000
const DEFAULT_DEFER_MS = 5 * 60 * 1_000

function deferDelayMs(value) {
  const seconds = Number(value)
  if (!Number.isFinite(seconds) || seconds <= 0) return DEFAULT_DEFER_MS
  return Math.max(MIN_DEFER_MS, Math.min(MAX_DEFER_MS, Math.ceil(seconds * 1_000)))
}

function externalAttempts(error) {
  if (Number.isInteger(error?.externalAttempts) && error.externalAttempts >= 0) return error.externalAttempts
  if (Number.isInteger(error?.metadata?.externalAttempts) && error.metadata.externalAttempts >= 0) return error.metadata.externalAttempts
  return undefined
}

function shouldDeferOutcome(outcome) {
  if (outcome?.status === 'deferred') return true
  const attempts = externalAttempts(outcome?.error)
  return Boolean(outcome?.error?.retryable) && attempts === 0
}

function startLeaseHeartbeat({ leaseRepository, fence, ownerToken, leaseMs }) {
  if (typeof leaseRepository?.heartbeat !== 'function') return () => {}
  const intervalMs = Math.max(100, Math.floor(Number(leaseMs) / 3) || 100)
  let stopped = false
  let inFlight = false
  const timer = globalThis.setInterval(() => {
    if (stopped || inFlight) return
    inFlight = true
    Promise.resolve()
      .then(() => leaseRepository.heartbeat({ key: fence.key, jobId: fence.jobId, leaseGeneration: fence.leaseGeneration, ownerToken, leaseMs }))
      .catch(() => {})
      .finally(() => { inFlight = false })
  }, intervalMs)
  timer.unref?.()
  return () => { stopped = true; globalThis.clearInterval(timer) }
}

export function createIndexingQueueAdapter({ jobRepository, leaseRepository, executor, leaseMs = 30_000, ownerToken = () => randomBytes(32).toString('hex') } = {}) {
  if (!jobRepository || !leaseRepository) throw new Error('Indexing job and lease repositories are required')
  return Object.freeze({
    queueName: 'indexing',
    recoveryStrategy: 'terminal-parent-linked-retry',
    selectDue: ({ now, task, tasks, excludeArticleIds } = {}) => jobRepository.selectDueIndexing({ now, task, tasks, excludeArticleIds }),
    recoverExpired: ({ now, limit }) => jobRepository.recoverExpiredIndexing({ leaseRepository, now, limit }),
    nextAvailableAt: () => jobRepository.nextAvailableAt(),
    async claimAndExecute({ candidate, now = new Date(), deadline } = {}) {
      const token = ownerToken()
      let fence
      try { fence = await leaseRepository.acquire({ key: deriveLeaseKey('indexing', candidate.articleId), jobId: candidate.id, ownerToken: token, now, leaseMs }) } catch (error) {
        if (error?.status === 409 && error?.code === 'conflict') return { status: 'deferred', claimed: false }
        throw error
      }
      const claimed = await jobRepository.claimQueuedWithFence({ jobId: candidate.id, fence })
      if (!claimed) {
        await leaseRepository.release({ ...fence, ownerToken: token })
        return { status: 'deferred', claimed: false }
      }
      if (typeof executor !== 'function') {
        const deferred = await jobRepository.deferWithFence({ jobId: candidate.id, fence, delayMs: DEFAULT_DEFER_MS })
        return { status: deferred?.status === 'cancelled' ? 'partial' : 'deferred', claimed: true }
      }
      if (typeof jobRepository.cancellationRequestedWithFence === 'function' && await jobRepository.cancellationRequestedWithFence({ jobId: candidate.id, fence })) {
        await jobRepository.completeWithFence({ jobId: candidate.id, fence, status: 'cancelled' })
        return { status: 'partial', claimed: true }
      }
      const stopHeartbeat = startLeaseHeartbeat({ leaseRepository, fence, ownerToken: token, leaseMs })
      try {
        let outcome
        try {
          outcome = await executor({
            job: { ...candidate, leaseGeneration: fence.leaseGeneration },
            fence,
            ownerToken: token,
            now,
            deadline,
          })
        } catch (error) {
          if (shouldDeferOutcome({ error })) {
            const delayMs = deferDelayMs(error.retryAfterSeconds)
            const deferred = await jobRepository.deferWithFence({ jobId: candidate.id, fence, delayMs })
            return { status: deferred?.status === 'cancelled' ? 'partial' : 'deferred', claimed: true, retryAfterSeconds: Math.ceil(delayMs / 1_000) }
          }
          outcome = { status: 'failed', error: { code: error?.code ?? 'worker_failed', retryable: Boolean(error?.retryable), upstreamStatus: error?.upstreamStatus } }
        }
        if (shouldDeferOutcome(outcome)) {
          const delayMs = deferDelayMs(outcome.retryAfterSeconds ?? outcome.error?.retryAfterSeconds)
          const deferred = await jobRepository.deferWithFence({ jobId: candidate.id, fence, delayMs })
          return { status: deferred?.status === 'cancelled' ? 'partial' : 'deferred', claimed: true, retryAfterSeconds: Math.ceil(delayMs / 1_000) }
        }
        const status = ['succeeded', 'partial', 'failed', 'cancelled'].includes(outcome?.status) ? outcome.status : 'failed'
        const finishedAt = new Date()
        await jobRepository.completeWithFence({ jobId: candidate.id, fence, status, error: safeOutcomeError(outcome?.error, finishedAt), inputHash: outcome?.inputHash })
        return { status: status === 'cancelled' ? 'partial' : status, claimed: true }
      } finally {
        stopHeartbeat()
      }
    },
  })
}
