import { createHash } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import { ObjectId } from 'mongodb'
import { createQaService } from '../../../server/application/qa/service.js'
import { MongoChatRepository } from '../../../server/repositories/mongo/chat-repository.js'
import { createStep11Mongo } from '../../helpers/step11-mongo.js'

const now = new Date('2026-08-14T00:00:00.000Z')
const userId = new ObjectId('507f1f77bcf86cd799439101')
const sessionId = new ObjectId('507f1f77bcf86cd799439102')
const articleId = new ObjectId('507f1f77bcf86cd799439103')
const sourceId = new ObjectId('507f1f77bcf86cd799439104')

function article() {
  return {
    _id: articleId, sourceId, version: 1, status: 'published', evidenceEligible: true,
    titleOriginal: 'Bai viet cong nghe', excerptOriginal: 'Noi dung duoc phep su dung.', originalUrl: 'https://example.test/article', publishedAt: now,
    rightsSnapshot: { sourcePolicyVersion: 1, licenseStatus: 'permitted', llmInputScope: 'excerpt', capturedAt: now },
    updatedAt: now,
  }
}

function source() {
  return {
    _id: sourceId, name: 'Nguon bien tap', authorityTier: 'editorial', operationalStatus: 'active', licenseStatus: 'permitted', policyVersion: 1,
    llmInputScope: 'excerpt', storageScope: { metadata: true, excerpt: true, summary: true, embedding: true },
    technicalCheck: { status: 'passed' }, mediaPolicy: { imageMode: 'none', videoMode: 'none', allowedHosts: [], attributionRequired: false, evidenceNote: null },
  }
}

function setup() {
  const mongo = createStep11Mongo({
    app: {
      users: [{ _id: userId, status: 'active', sessionVersion: 2, updatedAt: now }],
      sessions: [{ _id: sessionId, userId, userSessionVersion: 2, status: 'active', expiresAt: new Date(now.getTime() + 60_000), absoluteExpiresAt: new Date(now.getTime() + 60_000), lastSeenAt: now }],
      articles: [article()], sources: [source()], chatSessions: [], answerAttempts: [],
    },
  })
  const repository = new MongoChatRepository({ db: mongo.db, client: mongo.client, now: () => now })
  const evidenceRepository = { findQnaEvidence: vi.fn(async () => [{ article: article(), source: source() }]) }
  const auth = { user: { _id: userId, status: 'active' }, session: { _id: sessionId, userSessionVersion: 2 } }
  return { mongo, repository, evidenceRepository, auth }
}

describe('Step 11 delayed Q&A lifecycle fence', () => {
  it('rejects a provider result after article takedown before the production chat append boundary', async () => {
    const fixture = setup()
    let providerCalls = 0
    const provider = vi.fn(async () => {
      providerCalls += 1
      await fixture.mongo.db.collection('articles').updateOne({ _id: articleId }, { $set: { status: 'hidden', evidenceEligible: false, updatedAt: new Date(now.getTime() + 1) } })
      return { paragraphs: [{ text: 'Ket qua.', citationIds: ['C1'], evidenceBlockIds: ['E1'] }] }
    })
    const service = createQaService({
      articleRepository: fixture.evidenceRepository,
      chatRepository: fixture.repository,
      providerAdapters: { llmProvider: { answer: provider } },
      routes: { primary: 'primary' },
      supportVerifier: async () => ({ verdict: 'supported', addressesQuestion: true, evidenceBlockIds: ['E1'] }),
      rateLimitAdmission: { reserve: vi.fn(async () => ({ allowed: true })) },
      now: () => now,
    })

    await expect(service.createAnswer({ auth: fixture.auth, question: 'Bai viet ket luan gi?', scope: { articleId: articleId.toHexString() }, idempotencyKey: 'step11-delayed-fence-1' })).rejects.toMatchObject({ status: 409, code: 'conflict' })
    expect(providerCalls).toBe(1)
    expect(await fixture.mongo.db.collection('chatSessions').countDocuments({ userId })).toBe(0)
    expect(await fixture.mongo.db.collection('answerAttempts').countDocuments({ userId, status: { $in: ['completed', 'refused'] } })).toBe(0)
  })

  it('binds the production append fence to the admitted source policy and evidence text hash', async () => {
    const fixture = setup()
    const evidenceTextHash = createHash('sha256').update(`${article().titleOriginal}\n${article().excerptOriginal}`).digest('hex')
    await expect(fixture.repository.appendAnswer({
      actor: { userId, sessionId, sessionVersion: 2 }, chatSessionId: null, scope: { articleId }, question: 'Cau hoi an toan',
      answer: { id: 'answer-fence', status: 'answered', paragraphs: [{ text: 'Ket luan.', citationIds: ['C1'] }] },
      citations: [{ id: 'C1', articleId, sourceId, originalUrl: 'https://example.test/article', titleOriginal: article().titleOriginal, publishedAt: now }],
      attempt: null, now,
      expectedEvidenceFence: { articles: [{ articleId: articleId.toHexString(), sourceId: sourceId.toHexString(), articleVersion: 1, sourcePolicyVersion: 1, evidenceTextHash }] },
    })).resolves.toMatchObject({ answer: { status: 'answered' } })

    await expect(fixture.repository.appendAnswer({
      actor: { userId, sessionId, sessionVersion: 2 }, chatSessionId: null, scope: { articleId }, question: 'Cau hoi stale',
      answer: { id: 'answer-stale', status: 'answered', paragraphs: [{ text: 'Ket luan.', citationIds: ['C1'] }] },
      citations: [{ id: 'C1', articleId, sourceId, originalUrl: 'https://example.test/article', titleOriginal: article().titleOriginal, publishedAt: now }],
      attempt: null, now,
      expectedEvidenceFence: { articles: [{ articleId: articleId.toHexString(), sourceId: sourceId.toHexString(), articleVersion: 1, sourcePolicyVersion: 99, evidenceTextHash }] },
    })).rejects.toMatchObject({ status: 409, code: 'conflict' })
  })
})
