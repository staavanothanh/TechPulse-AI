import { MongoClient, ObjectId } from 'mongodb'
import { describe, expect, it } from 'vitest'
import { configureDns } from '../../../scripts/configure-dns.js'
import { databaseNameForSuite, dropTestDatabase } from '../../../scripts/atlas-test-safety.js'
import { createMongoContext } from '../../../server/repositories/mongo/connection.js'
import { CHAT_SESSION_SOURCE_NAME_VALIDATOR } from '../../../scripts/migrations/chat-sessions-source-name-v1.js'
import { historicalCitationDocument } from '../../../server/repositories/mongo/chat-repository.js'

const hasMongo = Boolean(process.env.MONGODB_TEST_URI)
const describeMongo = hasMongo ? describe : describe.skip

const NOW = new Date('2026-08-12T00:00:00.000Z')
const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000

function persistedCitation() {
  return historicalCitationDocument({
    id: 'C1',
    status: 'available',
    articleId: new ObjectId('507f1f77bcf86cd799439204').toHexString(),
    sourceId: new ObjectId('507f1f77bcf86cd799439205').toHexString(),
    sourceName: 'Nguon editorial',
    titleOriginal: 'Bai viet',
    originalUrl: 'https://example.test/articles/one',
    publishedAt: NOW.toISOString(),
  })
}

function sessionDocument(citation) {
  const current = new Date(NOW)
  return {
    _id: new ObjectId(),
    userId: new ObjectId(),
    title: null,
    scope: { topics: ['ai'] },
    messages: [
      { id: 'u1', role: 'user', text: 'Cau hoi?', createdAt: current },
      {
        id: 'a1',
        role: 'assistant',
        status: 'answered',
        paragraphs: [{ text: 'Ket luan co can cu.', citationIds: ['C1'] }],
        citations: [citation],
        refusalReason: null,
        createdAt: current,
      },
    ],
    messageCount: 2,
    expiresAt: new Date(current.getTime() + THIRTY_DAYS_MS),
    createdAt: current,
    updatedAt: current,
  }
}

describeMongo('QA 121 live Mongo integration: named-source citation insert', () => {
  it('inserts an answered session carrying a named-source citation under successor validator', async () => {
    configureDns()
    const client = new MongoClient(process.env.MONGODB_TEST_URI, { serverSelectionTimeoutMS: 5000 })
    await client.connect()
    const database = databaseNameForSuite('qa121')
    const context = createMongoContext({ client, database })
    const collectionName = 'chatSessions'
    try {
      await context.db.createCollection(collectionName, {
        validator: CHAT_SESSION_SOURCE_NAME_VALIDATOR,
        validationLevel: 'strict',
        validationAction: 'error',
      })
      const collection = context.db.collection(collectionName)

      const plain = persistedCitation()
      delete plain.sourceName
      const plainResult = await collection.insertOne(sessionDocument(plain))
      expect(plainResult.acknowledged).toBe(true)

      const namedResult = await collection.insertOne(sessionDocument(persistedCitation()))
      expect(namedResult.acknowledged).toBe(true)
    } finally {
      await dropTestDatabase({ context, expectedDatabase: database })
      await client.close()
    }
  }, 30000)
})
