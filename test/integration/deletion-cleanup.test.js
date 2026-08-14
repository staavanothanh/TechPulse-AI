import { describe, expect, it } from 'vitest'
import { ObjectId } from 'mongodb'
import { canCompleteDeletion, deletionCompletion } from '../../server/application/account-deletion/service.js'
import { createTakedownRepository } from '../../server/application/takedowns/repository.js'

describe('Step 11 deletion cleanup integration', () => {
  it('requires all seven deletion flags before terminal completion', () => {
    const partial = deletionCompletion({ sessionsRevoked: true, sessionsDeleted: true, savedArticlesDeleted: true })
    expect(canCompleteDeletion({ completion: partial, error: null })).toBe(false)
    const complete = Object.fromEntries(Object.keys(partial).map((flag) => [flag, true]))
    expect(canCompleteDeletion({ completion: complete, error: null })).toBe(true)
    expect(canCompleteDeletion({ completion: complete, error: { code: 'cleanup_failed' } })).toBe(false)
  })

  it('redacts a bounded citation page and returns a stable continuation cursor', async () => {
    const sourceId = new ObjectId('507f1f77bcf86cd799439020')
    const rows = Array.from({ length: 3 }, (_, index) => ({
      _id: new ObjectId(`507f1f77bcf86cd79943902${index + 1}`), updatedAt: new Date('2026-08-13T00:00:00.000Z'), messageCount: 1,
      messages: [{ id: `message-${index}`, role: 'assistant', status: 'answered', citations: [{ id: `C${index}`, status: 'available', sourceId, originalUrl: 'https://example.com/private', titleOriginal: 'Private', publishedAt: new Date() }] }],
    }))
    const updates = []
    const chatCollection = {
      find: () => ({ hint: () => ({ sort: () => ({ limit: () => ({ toArray: async () => rows }) }) }) }),
      updateOne: async (filter, update) => { updates.push({ filter, update }); return { matchedCount: 1, modifiedCount: 1 } },
    }
    const repository = createTakedownRepository({ collection: {}, now: () => new Date('2026-08-13T00:01:00.000Z') })
    const result = await repository.redactBatch({ targetType: 'source', targetIds: [sourceId], chatCollection, limit: 2 })

    expect(result).toEqual({ inspected: 2, affected: 2, hasMore: true, nextCursor: rows[1]._id.toHexString() })
    expect(updates).toHaveLength(2)
    for (const { filter, update } of updates) {
      expect(filter).toEqual(expect.objectContaining({ updatedAt: rows[0].updatedAt, messageCount: 1 }))
      expect(update.$set.messages[0].citations[0]).toEqual(expect.objectContaining({ status: 'unavailable', unavailableReason: 'takedown' }))
      expect(update.$set.messages[0].citations[0]).not.toHaveProperty('originalUrl')
    }
  })
})
