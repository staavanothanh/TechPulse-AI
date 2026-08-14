import { describe, expect, it } from 'vitest'
import { ObjectId } from 'mongodb'
import { MongoTakedownRepository } from '../../../server/repositories/mongo/takedown-repository.js'
import { createStep11Mongo } from '../../helpers/step11-mongo.js'

const now = new Date('2026-08-14T00:00:00.000Z')

function fixture(targetType) {
  const articleId = new ObjectId(targetType === 'article' ? '507f1f77bcf86cd799439601' : '507f1f77bcf86cd799439611')
  const sourceId = new ObjectId(targetType === 'article' ? '507f1f77bcf86cd799439602' : '507f1f77bcf86cd799439612')
  const requestId = new ObjectId(targetType === 'article' ? '507f1f77bcf86cd799439603' : '507f1f77bcf86cd799439613')
  const targetId = targetType === 'article' ? articleId : sourceId
  const chats = Array.from({ length: 5 }, (_, index) => ({
    _id: new ObjectId(`507f1f77bcf86cd7994396${String(index + 20).padStart(2, '0')}`), updatedAt: now, messageCount: 1,
    messages: [{ id: `assistant-${index}`, role: 'assistant', status: 'answered', citations: [{ id: `C${index}`, status: 'available', ...(targetType === 'article' ? { articleId } : { sourceId }), originalUrl: `https://example.test/${index}`, titleOriginal: `Title ${index}`, publishedAt: now }] }],
  }))
  const mongo = createStep11Mongo({
    app: {
      articles: [{
        _id: articleId,
        sourceId,
        connectorType: 'rss',
        status: 'hidden',
        evidenceEligible: false,
        removalPolicyVersion: 3,
        canonicalUrlHash: 'a'.repeat(64),
        searchTextNormalized: 'private text',
        createdAt: now,
        updatedAt: now,
      }],
      sources: [{ _id: sourceId, operationalStatus: 'paused', policyVersion: 3, updatedAt: now }],
      chatSessions: chats,
      takedownRequests: [{ _id: requestId, status: 'approved', targetType, targetIds: [targetId], requestedScope: ['metadata'], updatedAt: now, completion: { hidden: true, metadataRemoved: false, mediaMetadataRemoved: false, summaryRemoved: false, embeddingRemoved: false, historicalChatCitationsRedacted: false } }],
    },
  })
  const repository = new MongoTakedownRepository({ db: mongo.db, client: mongo.client, governanceDb: mongo.governanceDb, governanceKeyring: { versions: [1], currentVersion: 1, digest: () => 'a'.repeat(64) }, now: () => now })
  return { mongo, repository, requestId, targetType, articleId, sourceId }
}

describe('Step 11 bounded takedown citation cleanup', () => {
  for (const targetType of ['article', 'source']) {
    it(`redacts ${targetType} citations across bounded pages and reaches target-specific zero-match`, async () => {
      const fixtureValue = fixture(targetType)
      let last
      do { last = await fixtureValue.repository.materializeCleanupBatch({ now, limit: 2 }) } while (last.hasMore)

      expect(last.processed).toBe(true)
      expect(last.completion).toEqual(expect.objectContaining({ metadataRemoved: true, historicalChatCitationsRedacted: true }))
      expect(fixtureValue.mongo.db.hints).toEqual(expect.arrayContaining([{ collection: 'chatSessions', hint: targetType === 'article' ? 'chat_sessions_citation_article' : 'chat_sessions_citation_source' }]))
      expect(await fixtureValue.mongo.db.collection('chatSessions').countDocuments({ messages: { $elemMatch: { role: 'assistant', status: 'answered', citations: { $elemMatch: { status: 'available', ...(targetType === 'article' ? { articleId: fixtureValue.articleId } : { sourceId: fixtureValue.sourceId }) } } } } })).toBe(0)
      const rows = await fixtureValue.mongo.db.collection('chatSessions').find({}).toArray()
      expect(rows).toHaveLength(5)
      for (const row of rows) {
        expect(row.messages[0].citations[0]).toEqual(expect.objectContaining({ status: 'unavailable', unavailableReason: 'takedown' }))
        expect(row.messages[0].citations[0]).not.toHaveProperty('originalUrl')
        expect(row.messages[0].citations[0]).not.toHaveProperty('titleOriginal')
      }
    })
  }
})
