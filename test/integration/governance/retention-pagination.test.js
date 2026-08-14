import { describe, expect, it } from 'vitest'
import { ObjectId } from 'mongodb'
import { MongoTakedownRepository } from '../../../server/repositories/mongo/takedown-repository.js'
import { MongoAccountDeletionRepository } from '../../../server/repositories/mongo/account-deletion-repository.js'
import { createStep11Mongo } from '../../helpers/step11-mongo.js'

const cutoff = new Date('2026-08-14T00:00:00.000Z')
const deadline = new Date('2026-08-13T00:00:00.000Z')

describe('Step 11 governance retention pagination', () => {
  it('purges equal takedown workflow deadlines by stable _id pages', async () => {
    const ids = ['301', '302', '303', '304'].map((suffix) => new ObjectId(`507f1f77bcf86cd79943${suffix.padStart(4, '0')}`))
    const mongo = createStep11Mongo({ app: { takedownRequests: ids.map((_id) => ({ _id, status: 'completed', workflowPurgeAfter: deadline })) } })
    const repository = new MongoTakedownRepository({ db: mongo.db, client: mongo.client, now: () => cutoff })

    await expect(repository.purgeWorkflows({ cutoff, limit: 2 })).resolves.toEqual({ inspected: 2, affected: 2, hasMore: true })
    await expect(repository.purgeWorkflows({ cutoff, limit: 2 })).resolves.toEqual({ inspected: 2, affected: 2, hasMore: false })
    expect(await mongo.db.collection('takedownRequests').countDocuments({ status: 'completed', workflowPurgeAfter: { $lte: cutoff } })).toBe(0)
  })

  it('purges equal account-deletion deadlines without skipping the final page', async () => {
    const ids = ['401', '402', '403', '404'].map((suffix) => new ObjectId(`507f1f77bcf86cd79943${suffix.padStart(4, '0')}`))
    const mongo = createStep11Mongo({ app: { accountDeletionRequests: ids.map((_id) => ({ _id, status: 'completed', purgeAfter: deadline })) } })
    const repository = new MongoAccountDeletionRepository({
      db: mongo.db, client: mongo.client, quotaKeyring: { versions: [1], digest: () => 'q' }, governanceKeyring: { versions: [1], currentVersion: 1, digest: () => 's' }, now: () => cutoff,
    })

    await expect(repository.purge({ cutoff, limit: 2 })).resolves.toEqual({ inspected: 2, affected: 2, hasMore: true })
    await expect(repository.purge({ cutoff, limit: 2 })).resolves.toEqual({ inspected: 2, affected: 2, hasMore: false })
    expect(await mongo.db.collection('accountDeletionRequests').countDocuments({ status: 'completed', purgeAfter: { $lte: cutoff } })).toBe(0)
  })
})
