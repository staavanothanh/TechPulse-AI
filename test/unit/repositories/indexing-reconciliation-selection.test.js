import { describe, expect, it } from 'vitest'
import { ObjectId } from 'mongodb'
import { createStep11Mongo } from '../../helpers/step11-mongo.js'
import { MongoIndexingJobRepository } from '../../../server/repositories/mongo/indexing-job-repository.js'

const now = new Date('2026-08-29T01:00:00.000Z')
const eligibleId = new ObjectId('507f1f77bcf86cd799439011')
const archivedId = new ObjectId('507f1f77bcf86cd799439012')
const recentFailedId = new ObjectId('507f1f77bcf86cd799439013')

function marker(status, error = null) {
  return { status, requiredPolicyVersion: 8, completedPolicyVersion: null, requestedAt: now, error }
}

describe('Mongo reconciliation source selection', () => {
  it('targets the requested source, excludes archived sources, and honors failed backoff', async () => {
    const mongo = createStep11Mongo({
      app: {
        sources: [
          { _id: eligibleId, operationalStatus: 'paused', policyVersion: 8, reconciliation: marker('pending') },
          { _id: archivedId, operationalStatus: 'archived', policyVersion: 8, reconciliation: marker('pending') },
          { _id: recentFailedId, operationalStatus: 'paused', policyVersion: 8, reconciliation: marker('failed', { code: 'temporary_failure', message: 'safe', retryable: true, occurredAt: new Date(now.getTime() - 59_000) }) },
        ],
      },
    })
    const repository = new MongoIndexingJobRepository({ db: mongo.db, client: mongo.client, now: () => now })

    await expect(repository.selectPendingReconciliationSource({ sourceId: archivedId, now })).resolves.toBeNull()
    await expect(repository.selectPendingReconciliationSource({ sourceId: recentFailedId, now })).resolves.toBeNull()
    await expect(repository.selectPendingReconciliationSource({ sourceId: eligibleId, now })).resolves.toEqual({ id: eligibleId.toHexString(), policyVersion: 8 })
    await expect(repository.selectPendingReconciliationSource({ sourceId: recentFailedId, now: new Date(now.getTime() + 61_000) })).resolves.toEqual({ id: recentFailedId.toHexString(), policyVersion: 8 })
  })
})
