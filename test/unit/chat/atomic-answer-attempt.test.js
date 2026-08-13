import { createHash } from 'node:crypto'
import { ObjectId } from 'mongodb'
import { describe, expect, it, vi } from 'vitest'
import { MongoChatRepository } from '../../../server/repositories/mongo/chat-repository.js'

describe('Step 10 atomic chat answer receipt', () => {
  it('commits an answered session append and terminal receipt in the same transaction', async () => {
    const now = new Date('2026-08-12T00:00:00.000Z')
    const userId = new ObjectId('507f1f77bcf86cd799439021')
    const loginSessionId = new ObjectId('507f1f77bcf86cd799439022')
    const attemptId = new ObjectId('507f1f77bcf86cd799439023')
    const articleId = new ObjectId('507f1f77bcf86cd799439024')
    const sourceId = new ObjectId('507f1f77bcf86cd799439025')
    let chatDocument
    const receiptUpdate = vi.fn(async (filter, update) => ({ value: { _id: attemptId, ...filter, ...update.$set } }))
    const db = { collection: (name) => ({
      findOne: async () => name === 'users' ? { _id: userId } : name === 'sessions' ? { _id: loginSessionId } : name === 'chatSessions' ? chatDocument ?? null : null,
      insertOne: async (document) => { if (name === 'chatSessions') chatDocument = document },
      findOneAndUpdate: async (_filter, update) => {
        if (name === 'answerAttempts') return receiptUpdate(_filter, update)
        chatDocument = { ...chatDocument, messages: [...chatDocument.messages, ...update.$push.messages.$each], messageCount: chatDocument.messageCount + update.$inc.messageCount, ...update.$set }
        return { value: chatDocument }
      },
    }) }
    const session = { withTransaction: async (work) => work(session), endSession: async () => undefined }
    const repository = new MongoChatRepository({ db, client: { startSession: () => session }, now: () => now })

    const result = await repository.appendAnswer({
      actor: { userId, actorFence: { sessionId: loginSessionId, sessionVersion: 1 } },
      scope: { topics: ['ai'] }, question: 'Ket luan la gi?',
      answer: { id: 'answer-1', status: 'answered', paragraphs: [{ text: 'Co can cu.', citationIds: ['C1'] }] },
      citations: [{ id: 'C1', articleId, sourceId, titleOriginal: 'Bai viet', originalUrl: 'https://example.test/a', publishedAt: now }],
      attempt: { id: attemptId, outcome: 'completed' }, now,
    })

    expect(result.attemptCommitted).toBe(true)
    expect(receiptUpdate).toHaveBeenCalledWith(expect.objectContaining({ _id: attemptId, status: { $in: ['reserved', 'provider-running'] } }), expect.objectContaining({ $set: expect.objectContaining({ status: 'completed', resultStatus: 'answered', messageId: 'answer-1' }) }))
  })

  it('rejects final append when the article version changes with identical text and policy', async () => {
    const now = new Date('2026-08-12T00:00:00.000Z')
    const userId = new ObjectId('507f1f77bcf86cd799439021')
    const loginSessionId = new ObjectId('507f1f77bcf86cd799439022')
    const articleId = new ObjectId('507f1f77bcf86cd799439024')
    const sourceId = new ObjectId('507f1f77bcf86cd799439025')
    const article = {
      _id: articleId, sourceId, version: 2, status: 'published', evidenceEligible: true, titleOriginal: 'Bai viet',
      excerptOriginal: 'Noi dung', rightsSnapshot: { sourcePolicyVersion: 1, licenseStatus: 'permitted', llmInputScope: 'excerpt' },
    }
    const source = {
      _id: sourceId, authorityTier: 'editorial', operationalStatus: 'active', licenseStatus: 'permitted', policyVersion: 1,
      llmInputScope: 'excerpt', storageScope: { metadata: true, excerpt: true }, technicalCheck: { status: 'passed' },
    }
    const db = { collection: (name) => ({
      findOne: async () => name === 'users' ? { _id: userId } : name === 'sessions' ? { _id: loginSessionId } : name === 'articles' ? article : name === 'sources' ? source : null,
    }) }
    const session = { withTransaction: async (work) => work(session), endSession: async () => undefined }
    const repository = new MongoChatRepository({ db, client: { startSession: () => session }, now: () => now })

    await expect(repository.appendAnswer({
      actor: { userId, actorFence: { sessionId: loginSessionId, sessionVersion: 1 } },
      scope: { articleId }, question: 'Ket luan?',
      answer: { id: 'answer-version', status: 'answered', paragraphs: [{ text: 'Co can cu.', citationIds: ['C1'] }] },
      citations: [{ id: 'C1', articleId, sourceId, titleOriginal: 'Bai viet', originalUrl: 'https://example.test/a', publishedAt: now }],
      expectedEvidenceFence: { articles: [{ articleId: articleId.toHexString(), sourceId: sourceId.toHexString(), articleVersion: 1, sourcePolicyVersion: 1, evidenceTextHash: createHash('sha256').update('Bai viet\nNoi dung').digest('hex') }] },
      now,
    })).rejects.toMatchObject({ code: 'conflict' })
  })

  it('discards output when a cited lifecycle fence CAS misses after the final snapshot read', async () => {
    const now = new Date('2026-08-12T00:00:00.000Z')
    const userId = new ObjectId('507f1f77bcf86cd799439021')
    const loginSessionId = new ObjectId('507f1f77bcf86cd799439022')
    const attemptId = new ObjectId('507f1f77bcf86cd799439023')
    const articleId = new ObjectId('507f1f77bcf86cd799439024')
    const sourceId = new ObjectId('507f1f77bcf86cd799439025')
    const article = { _id: articleId, sourceId, version: 2, status: 'published', evidenceEligible: true, titleOriginal: 'Bai viet', excerptOriginal: 'Noi dung', rightsSnapshot: { sourcePolicyVersion: 1, licenseStatus: 'permitted', llmInputScope: 'excerpt' } }
    const source = { _id: sourceId, authorityTier: 'editorial', operationalStatus: 'active', licenseStatus: 'permitted', policyVersion: 1, llmInputScope: 'excerpt', storageScope: { metadata: true, excerpt: true, summary: true, embedding: true }, mediaPolicy: { imageMode: 'none', videoMode: 'none', allowedHosts: [], attributionRequired: false, evidenceNote: null }, technicalCheck: { status: 'passed' } }
    let chatDocument
    const writes = []
    const db = { collection: (name) => ({
      findOne: async () => name === 'users' ? { _id: userId } : name === 'sessions' ? { _id: loginSessionId } : name === 'articles' ? article : name === 'sources' ? source : name === 'chatSessions' ? chatDocument ?? null : null,
      updateOne: async (filter, update) => { writes.push({ name, filter, update }); return { matchedCount: name === 'articles' ? 0 : 1 } },
      insertOne: async (document) => { if (name === 'chatSessions') chatDocument = document },
      findOneAndUpdate: async () => ({ value: null }),
    }) }
    const session = { withTransaction: async (work) => work(session), endSession: async () => undefined }
    const repository = new MongoChatRepository({ db, client: { startSession: () => session }, now: () => now })

    await expect(repository.appendAnswer({
      actor: { userId, actorFence: { sessionId: loginSessionId, sessionVersion: 1 } },
      scope: { articleId }, question: 'Ket luan?',
      answer: { id: 'answer-race', status: 'answered', paragraphs: [{ text: 'Co can cu.', citationIds: ['C1'] }] },
      citations: [{ id: 'C1', articleId, sourceId, titleOriginal: 'Bai viet', originalUrl: 'https://example.test/a', publishedAt: now }],
      attempt: { id: attemptId, outcome: 'completed' },
      expectedEvidenceFence: { articles: [{ articleId: articleId.toHexString(), sourceId: sourceId.toHexString(), articleVersion: 2, sourcePolicyVersion: 1, evidenceTextHash: createHash('sha256').update('Bai viet\nNoi dung').digest('hex') }] },
      now,
    })).rejects.toMatchObject({ code: 'conflict' })

    expect(writes.map(({ name }) => name)).toContain('articles')
    expect(chatDocument).toBeUndefined()
    expect(writes.some(({ name }) => name === 'answerAttempts')).toBe(false)
  })

  it('discards output when source lifecycle is revoked before the final write fence', async () => {
    const now = new Date('2026-08-12T00:00:00.000Z')
    const userId = new ObjectId('507f1f77bcf86cd799439021')
    const loginSessionId = new ObjectId('507f1f77bcf86cd799439022')
    const articleId = new ObjectId('507f1f77bcf86cd799439024')
    const sourceId = new ObjectId('507f1f77bcf86cd799439025')
    const article = { _id: articleId, sourceId, version: 2, status: 'published', evidenceEligible: true, titleOriginal: 'Bai viet', excerptOriginal: 'Noi dung', rightsSnapshot: { sourcePolicyVersion: 1, licenseStatus: 'permitted', llmInputScope: 'excerpt' } }
    const source = { _id: sourceId, authorityTier: 'editorial', operationalStatus: 'active', licenseStatus: 'permitted', policyVersion: 1, llmInputScope: 'excerpt', storageScope: { metadata: true, excerpt: true, summary: true, embedding: true }, mediaPolicy: { imageMode: 'none', videoMode: 'none', allowedHosts: [], attributionRequired: false, evidenceNote: null }, technicalCheck: { status: 'passed' } }
    const writes = []
    const db = { collection: (name) => ({
      findOne: async () => name === 'users' ? { _id: userId } : name === 'sessions' ? { _id: loginSessionId } : name === 'articles' ? article : name === 'sources' ? source : null,
      updateOne: async (filter) => { writes.push({ name, filter }); return { matchedCount: name === 'sources' ? 0 : 1 } },
    }) }
    const session = { withTransaction: async (work) => work(session), endSession: async () => undefined }
    const repository = new MongoChatRepository({ db, client: { startSession: () => session }, now: () => now })

    await expect(repository.appendAnswer({
      actor: { userId, actorFence: { sessionId: loginSessionId, sessionVersion: 1 } }, scope: { articleId }, question: 'Ket luan?',
      answer: { id: 'answer-source-race', status: 'answered', paragraphs: [{ text: 'Co can cu.', citationIds: ['C1'] }] },
      citations: [{ id: 'C1', articleId, sourceId, titleOriginal: 'Bai viet', originalUrl: 'https://example.test/a', publishedAt: now }],
      expectedEvidenceFence: { articles: [{ articleId: articleId.toHexString(), sourceId: sourceId.toHexString(), articleVersion: 2, sourcePolicyVersion: 1, evidenceTextHash: createHash('sha256').update('Bai viet\nNoi dung').digest('hex') }] }, now,
    })).rejects.toMatchObject({ code: 'conflict' })
    expect(writes.map(({ name }) => name)).toContain('sources')
  })
})
