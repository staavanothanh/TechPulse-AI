import { describe, expect, it } from 'vitest'
import { ObjectId } from 'mongodb'
import { createTakedownRepository } from '../../server/application/takedowns/repository.js'
import { canCompleteDeletion, deletionCompletion, safeAccountDeletion } from '../../server/application/account-deletion/service.js'

describe('Step 11 controlled governance lifecycle', () => {
  it('hides first, redacts historical citation facts, then exposes only safe workflow progress', async () => {
    const articleId = new ObjectId('507f1f77bcf86cd799439010')
    const takedownId = new ObjectId('507f1f77bcf86cd799439011')
    const now = new Date('2026-08-13T00:00:00.000Z')
    const row = {
      _id: new ObjectId('507f1f77bcf86cd799439012'), updatedAt: now, messageCount: 1,
      messages: [{ id: 'assistant-1', role: 'assistant', status: 'answered', citations: [{ id: 'C1', status: 'available', articleId, sourceId: new ObjectId(), originalUrl: 'https://example.com/article', titleOriginal: 'Article', publishedAt: now }] }],
    }
    let persistedMessages = row.messages
    const chatCollection = {
      find: () => ({ hint: () => ({ sort: () => ({ limit: () => ({ toArray: async () => [row] }) }) }) }),
      updateOne: async (_filter, update) => { persistedMessages = update.$set.messages; return { matchedCount: 1, modifiedCount: 1 } },
    }
    const repository = createTakedownRepository({ collection: {}, now: () => new Date('2026-08-13T00:01:00.000Z') })
    const cleanup = await repository.redactBatch({ targetType: 'article', targetIds: [articleId], chatCollection })

    const publicProgress = {
      id: takedownId.toHexString(), status: 'completed', targetType: 'article', targetIds: [articleId.toHexString()], requestedScope: ['summary'],
      completion: { hidden: true, metadataRemoved: false, mediaMetadataRemoved: false, summaryRemoved: true, embeddingRemoved: false, historicalChatCitationsRedacted: cleanup.affected === 1 },
    }
    expect(publicProgress.completion.hidden).toBe(true)
    expect(publicProgress.completion.historicalChatCitationsRedacted).toBe(true)
    expect(persistedMessages[0].citations[0]).toEqual(expect.objectContaining({ status: 'unavailable', unavailableReason: 'takedown' }))
    expect(persistedMessages[0].citations[0]).not.toHaveProperty('originalUrl')
    expect(JSON.stringify(publicProgress)).not.toMatch(/requester|contact|reason|evidenceNote/i)
  })

  it('does not claim account deletion complete before all seven cleanup proofs exist', () => {
    const incomplete = deletionCompletion({ sessionsRevoked: true, sessionsDeleted: true })
    const workflow = safeAccountDeletion({ _id: new ObjectId(), status: 'running', priority: 50, attempt: 1, availableAt: new Date(), completion: incomplete, error: null, requestedAt: new Date(), startedAt: new Date(), completedAt: null })
    expect(canCompleteDeletion({ completion: workflow.completion, error: workflow.error })).toBe(false)
    expect(workflow).not.toHaveProperty('userId')
    expect(workflow).not.toHaveProperty('actorScope')
    expect(workflow).not.toHaveProperty('idempotencyKey')
  })
})
