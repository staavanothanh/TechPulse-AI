import { randomBytes } from 'node:crypto'
import { canCompleteDeletion, deletionCompletion } from '../application/account-deletion/service.js'

import { runtimeFailure, settleBeforeDeadline } from './runtime-bounds.js'
function cleanupFailure(now) {
  return { code: 'cleanup_incomplete', message: 'Account deletion cleanup did not complete safely', retryable: true, occurredAt: now }
}
function validDate(value, label) {
  const result = value instanceof Date ? new Date(value) : new Date(value)
  if (Number.isNaN(result.getTime())) throw new Error(`${label} is invalid`)
  return result
}

async function runBoundedOperation(operation, { deadline, signal, timeoutCode = 'account_deletion_deadline_exceeded', onLate } = {}) {
  const deadlineAt = deadline === undefined ? null : validDate(deadline, 'Account deletion deadline')
  const controller = new globalThis.AbortController()
  signal?.addEventListener?.('abort', () => controller.abort(signal.reason), { once: true })
  const remainingMs = deadlineAt === null ? Number.POSITIVE_INFINITY : Math.max(0, deadlineAt.getTime() - Date.now())
  const settled = await settleBeforeDeadline(
    Promise.resolve().then(() => operation({ signal: controller.signal, ...(deadlineAt ? { deadline: deadlineAt } : {}) })),
    remainingMs,
    {
      timeoutError: () => runtimeFailure(timeoutCode, 'Account deletion operation deadline was exceeded'),
      onTimeout: (error) => controller.abort(error),
      onLate: (result) => result.settled ? onLate?.(result.value) : undefined,
    },
  )
  if (settled.kind === 'deadline') return { kind: 'deadline', error: settled.error }
  if (!settled.settled) throw settled.error
  return { kind: 'operation', value: settled.value }
}

function isDeadlineResult(result) {
  return result?.kind === 'deadline'
}

export function createAccountDeletionQueueAdapter({ repository, ownerToken = () => randomBytes(32).toString('hex') } = {}) {
  if (!repository) throw new Error('Account deletion queue repository is required')
  for (const method of ['selectDue', 'claim', 'deferClaimed', 'applyCleanup', 'complete', 'fail', 'recoverExpired', 'nextAvailableAt']) {
    if (typeof repository[method] !== 'function') throw new Error(`Account deletion repository ${method} is required`)
  }
  return Object.freeze({
    queueName: 'account-deletion',
    recoveryStrategy: 'same-request-requeue',
    selectDue: ({ now, signal, deadline } = {}) => repository.selectDue({ now, ...(signal ? { signal } : {}), ...(deadline ? { deadline } : {}) }),
    recoverExpired: ({ now, limit, signal, deadline } = {}) => repository.recoverExpired({ now, limit, ...(signal ? { signal } : {}), ...(deadline ? { deadline } : {}) }),
    nextAvailableAt: ({ now, signal, deadline } = {}) => repository.nextAvailableAt({ now, ...(signal ? { signal } : {}), ...(deadline ? { deadline } : {}) }),
    async claimAndExecute({ candidate, now = new Date(), deadline, signal } = {}) {
      if (signal?.aborted) return { claimed: false, status: 'deferred' }
      const claimOwnerToken = ownerToken()
      const claimed = await runBoundedOperation(
        ({ signal: operationSignal, deadline: operationDeadline }) => repository.claim({ candidate, now, ownerToken: claimOwnerToken, signal: operationSignal, ...(operationDeadline ? { deadline: operationDeadline } : {}) }),
        {
          deadline,
          signal,
          onLate: (lateJob) => lateJob
            ? runBoundedOperation(
              ({ signal, deadline: operationDeadline }) => repository.deferClaimed({ job: lateJob, now, ownerToken: claimOwnerToken, delayMs: 5 * 60 * 1000, signal, deadline: operationDeadline }),
              { deadline: new Date(Date.now() + 5_000) },
            )
            : undefined,
        },
      )
      if (isDeadlineResult(claimed)) return { claimed: false, status: 'deferred' }
      const job = claimed.value
      if (!job) return { claimed: false, status: 'deferred' }
      let completion
      try {
        const cleaned = await runBoundedOperation(
          ({ signal, deadline: operationDeadline }) => repository.applyCleanup({ job, now, signal, ...(operationDeadline ? { deadline: operationDeadline } : {}) }),
          { deadline },
        )
        if (isDeadlineResult(cleaned)) return { claimed: true, status: 'deferred' }
        completion = deletionCompletion(cleaned.value)
      } catch (error) {
        const failed = await runBoundedOperation(
          ({ signal, deadline: operationDeadline }) => repository.fail({ job, error: cleanupFailure(now), now, signal, ...(operationDeadline ? { deadline: operationDeadline } : {}) }),
          { deadline },
        )
        if (isDeadlineResult(failed)) return { claimed: true, status: 'deferred' }
        return { claimed: true, status: 'failed' }
      }
      if (!canCompleteDeletion({ completion, error: null })) {
        const failed = await runBoundedOperation(
          ({ signal, deadline: operationDeadline }) => repository.fail({ job, completion, error: cleanupFailure(now), now, signal, ...(operationDeadline ? { deadline: operationDeadline } : {}) }),
          { deadline },
        )
        if (isDeadlineResult(failed)) return { claimed: true, status: 'deferred' }
        return { claimed: true, status: 'failed' }
      }
      const committed = await runBoundedOperation(
        ({ signal, deadline: operationDeadline }) => repository.complete({ job, completion, now, signal, ...(operationDeadline ? { deadline: operationDeadline } : {}) }),
        { deadline },
      )
      if (isDeadlineResult(committed)) return { claimed: true, status: 'deferred' }
      return committed.value ? { claimed: true, status: 'succeeded' } : { claimed: false, status: 'deferred' }
    },
  })
}
