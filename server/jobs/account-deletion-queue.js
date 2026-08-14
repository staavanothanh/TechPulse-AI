import { randomBytes } from 'node:crypto'
import { canCompleteDeletion, deletionCompletion } from '../application/account-deletion/service.js'

function cleanupFailure(now) {
  return { code: 'cleanup_incomplete', message: 'Account deletion cleanup did not complete safely', retryable: true, occurredAt: now }
}

export function createAccountDeletionQueueAdapter({ repository, ownerToken = () => randomBytes(32).toString('hex') } = {}) {
  if (!repository) throw new Error('Account deletion queue repository is required')
  for (const method of ['selectDue', 'claim', 'applyCleanup', 'complete', 'fail', 'recoverExpired', 'nextAvailableAt']) {
    if (typeof repository[method] !== 'function') throw new Error(`Account deletion repository ${method} is required`)
  }
  return Object.freeze({
    queueName: 'account-deletion',
    recoveryStrategy: 'same-request-requeue',
    selectDue: ({ now }) => repository.selectDue({ now }),
    recoverExpired: ({ now, limit }) => repository.recoverExpired({ now, limit }),
    nextAvailableAt: ({ now } = {}) => repository.nextAvailableAt({ now }),
    async claimAndExecute({ candidate, now = new Date() } = {}) {
      const job = await repository.claim({ candidate, now, ownerToken: ownerToken() })
      if (!job) return { claimed: false, status: 'deferred' }
      let completion
      try { completion = deletionCompletion(await repository.applyCleanup({ job, now })) } catch {
        await repository.fail({ job, error: cleanupFailure(now), now })
        return { claimed: true, status: 'failed' }
      }
      if (!canCompleteDeletion({ completion, error: null })) {
        await repository.fail({ job, completion, error: cleanupFailure(now), now })
        return { claimed: true, status: 'failed' }
      }
      const committed = await repository.complete({ job, completion, now })
      return committed ? { claimed: true, status: 'succeeded' } : { claimed: false, status: 'deferred' }
    },
  })
}
