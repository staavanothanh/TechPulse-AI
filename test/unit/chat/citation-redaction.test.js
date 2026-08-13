import { ObjectId } from 'mongodb'
import { describe, expect, it } from 'vitest'
import { historicalCitationDocument, MongoChatRepository, redactHistoricalCitation } from '../../../server/repositories/mongo/chat-repository.js'

describe('Step 10 historical citation persistence and read redaction', () => {
  const articleId = new ObjectId('507f1f77bcf86cd799439011')
  const sourceId = new ObjectId('507f1f77bcf86cd799439012')
  const available = { id: 'C1', articleId: articleId.toHexString(), sourceId: sourceId.toHexString(), sourceName: 'Nguồn public-only', author: 'Tác giả public-only', sourceLanguage: 'vi', titleOriginal: 'Bài hợp lệ', originalUrl: 'https://example.test/article', publishedAt: '2026-08-12T00:00:00.000Z' }

  it('persists only the strict available historical union from a public answer citation', () => {
    expect(historicalCitationDocument(available)).toEqual({ id: 'C1', status: 'available', articleId, sourceId, titleOriginal: 'Bài hợp lệ', originalUrl: 'https://example.test/article', publishedAt: new Date('2026-08-12T00:00:00.000Z') })
  })

  it('bounds a persisted historical title even when the public citation title is longer', () => {
    expect(historicalCitationDocument({ ...available, titleOriginal: 'x'.repeat(501) }).titleOriginal).toHaveLength(500)
  })

  it('redacts formerly available citation facts when article/source is no longer visible', () => {
    const stored = historicalCitationDocument(available)
    expect(redactHistoricalCitation(stored, { article: { _id: articleId, sourceId, status: 'hidden', evidenceEligible: true }, source: { _id: sourceId, operationalStatus: 'active', licenseStatus: 'permitted', policyVersion: 1, llmInputScope: 'excerpt', storageScope: { metadata: true, excerpt: true, summary: true, embedding: true }, mediaPolicy: { imageMode: 'none', videoMode: 'none', allowedHosts: [], attributionRequired: false, evidenceNote: null }, authorityTier: 'editorial', technicalCheck: { status: 'passed' } } })).toEqual({ id: 'C1', status: 'unavailable', articleId, sourceId, unavailableReason: 'takedown' })
  })

  it('projects current-policy redaction through the owner-only session read path', async () => {
    const userId = new ObjectId('507f1f77bcf86cd799439013')
    const sessionId = new ObjectId('507f1f77bcf86cd799439014')
    const chatSessionId = new ObjectId('507f1f77bcf86cd799439015')
    const current = new Date('2026-08-12T00:00:00.000Z')
    const document = { _id: chatSessionId, userId, scope: { topics: ['ai'] }, messageCount: 1, createdAt: current, updatedAt: current, expiresAt: new Date('2026-09-11T00:00:00.000Z'), messages: [{ id: 'answer-1', role: 'assistant', status: 'answered', paragraphs: [{ text: 'Ket luan.', citationIds: ['C1'] }], citations: [historicalCitationDocument(available)], refusalReason: null, createdAt: current }] }
    const db = { collection: (name) => ({
      findOne: async () => {
        if (name === 'users') return { _id: userId }
        if (name === 'sessions') return { _id: sessionId }
        if (name === 'chatSessions') return document
        if (name === 'articles') return { _id: articleId, sourceId, status: 'removed', evidenceEligible: true }
        if (name === 'sources') return { _id: sourceId, operationalStatus: 'active', licenseStatus: 'permitted', policyVersion: 1, llmInputScope: 'excerpt', storageScope: { metadata: true, excerpt: true, summary: true, embedding: true }, mediaPolicy: { imageMode: 'none', videoMode: 'none', allowedHosts: [], attributionRequired: false, evidenceNote: null }, authorityTier: 'editorial', technicalCheck: { status: 'passed' } }
        return null
      },
    }) }
    const repository = new MongoChatRepository({ db, client: {}, now: () => current })

    const result = await repository.getChatSession({ actor: { userId, actorFence: { sessionId, sessionVersion: 1 } }, chatSessionId, now: current })

    expect(result.messages[0].citations).toEqual([{ id: 'C1', status: 'unavailable', articleId: articleId.toHexString(), sourceId: sourceId.toHexString(), unavailableReason: 'takedown' }])
  })
})
