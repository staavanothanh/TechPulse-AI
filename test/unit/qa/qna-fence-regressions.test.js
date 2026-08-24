import { createHash } from 'node:crypto'
import { ObjectId } from 'mongodb'
import { describe, expect, it } from 'vitest'
import { serializeSource as serializeAdminSource } from '../../../server/http/admin/sources/serializer.js'
import { serializeArticle } from '../../../server/repositories/mongo/article-repository.js'
import { MongoChatRepository } from '../../../server/repositories/mongo/chat-repository.js'
import { serializeSource as serializeRepositorySource } from '../../../server/repositories/mongo/source-repository.js'
import { admittedEvidenceText, buildGroundedPrompt, evidenceAdmissionFence } from '../../../server/domain/qa/evidence.js'
import { createStep11Mongo } from '../../helpers/step11-mongo.js'

const now = new Date('2026-08-12T00:00:00.000Z')
const userId = new ObjectId('507f1f77bcf86cd799439031')
const sessionId = new ObjectId('507f1f77bcf86cd799439032')
const firstArticleId = new ObjectId('507f1f77bcf86cd799439033')
const secondArticleId = new ObjectId('507f1f77bcf86cd799439034')
const firstSourceId = new ObjectId('507f1f77bcf86cd799439035')
const secondSourceId = new ObjectId('507f1f77bcf86cd799439036')

function sha256(value) {
  return createHash('sha256').update(value).digest('hex')
}

function sourceDocument(id, overrides = {}) {
  return {
    _id: id,
    name: `Nguon ${id.toHexString().slice(-2)}`,
    sourceKey: `rss:${id.toHexString()}`,
    publisherName: 'Publisher',
    domain: 'example.test',
    connectorType: 'rss',
    accessMethod: 'rss',
    authorityTier: 'editorial',
    connectorConfig: { kind: 'rss', feedUrl: 'https://example.test/feed.xml', batchSize: 20 },
    operationalStatus: 'active',
    licenseStatus: 'permitted',
    llmInputScope: 'excerpt',
    storageScope: { metadata: true, excerpt: true, summary: true, embedding: true },
    mediaPolicy: { imageMode: 'none', videoMode: 'none', allowedHosts: [], attributionRequired: false, evidenceNote: null },
    policyVersion: 1,
    reconciliation: { status: 'idle', requiredPolicyVersion: 1, completedPolicyVersion: 1, requestedAt: null, error: null },
    technicalCheck: { status: 'passed', checkedAt: now, contentType: 'application/rss+xml', resolvedHost: 'example.test', sampleCount: 1, error: null },
    health: { lastIngestSucceededAt: now, lastIngestFailedAt: null, consecutiveFailures: 0, lastError: null },
    reviewedBy: null,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  }
}

function articleDocument(id, sourceId, overrides = {}) {
  return {
    _id: id,
    sourceId,
    version: 1,
    status: 'published',
    evidenceEligible: true,
    titleOriginal: `Bai viet ${id.toHexString().slice(-2)}`,
    excerptOriginal: 'Noi dung duoc phep su dung.',
    originalUrl: `https://example.test/articles/${id.toHexString()}`,
    publishedAt: now,
    retrievedAt: now,
    createdAt: now,
    updatedAt: now,
    rightsSnapshot: { sourcePolicyVersion: 1, licenseStatus: 'permitted', llmInputScope: 'excerpt', capturedAt: now },
    ...overrides,
  }
}

function qnaEvidence(article, source) {
  return [{ article, source }]
}

function citation(id, article, source) {
  return { id, articleId: article._id, sourceId: source._id, titleOriginal: article.titleOriginal, originalUrl: article.originalUrl, publishedAt: article.publishedAt }
}

function actor() {
  return { userId, actorFence: { sessionId, sessionVersion: 2 } }
}

function baseMongo({ articles, sources }) {
  return createStep11Mongo({
    app: {
      users: [{ _id: userId, status: 'active', sessionVersion: 2, updatedAt: now }],
      sessions: [{ _id: sessionId, userId, userSessionVersion: 2, status: 'active', expiresAt: new Date(now.getTime() + 60_000), absoluteExpiresAt: new Date(now.getTime() + 60_000), lastSeenAt: now }],
      articles,
      sources,
      chatSessions: [],
      answerAttempts: [],
    },
  })
}

async function append(repo, article, source, expectedEvidenceFence, overrides = {}) {
  return repo.appendAnswer({
    actor: actor(),
    scope: { articleId: article._id.toHexString() },
    question: 'Ket luan la gi?',
    answer: { id: overrides.answerId ?? `answer-${article._id.toHexString()}`, status: 'answered', paragraphs: [{ text: 'Co can cu.', citationIds: ['C1'], evidenceBlockIds: ['E1'] }] },
    citations: [citation('C1', article, source)],
    expectedEvidenceFence,
    now,
  })
}

describe('Q&A evidence fence regressions', () => {
  it('does not expose the internal qnaFenceToken through article or source serializers', () => {
    const qnaFenceToken = new ObjectId()
    const article = serializeArticle({ ...articleDocument(firstArticleId, firstSourceId), qnaFenceToken })
    const source = serializeRepositorySource({ ...sourceDocument(firstSourceId), qnaFenceToken })
    const adminSource = serializeAdminSource(source)

    expect(article).not.toHaveProperty('qnaFenceToken')
    expect(source).not.toHaveProperty('qnaFenceToken')
    expect(adminSource).not.toHaveProperty('qnaFenceToken')
  })

  it('hashes the bounded evidence body that the provider receives', () => {
    const article = articleDocument(firstArticleId, firstSourceId, { excerptOriginal: 'A'.repeat(10_000) })
    const source = sourceDocument(firstSourceId)
    const prompt = buildGroundedPrompt({ question: 'Noi dung la gi?', evidence: qnaEvidence(article, source) })
    const fence = evidenceAdmissionFence(prompt.evidence)
    const body = prompt.blocks[0].text.match(/\n\[source=[^\n]*\]\n([\s\S]*)\n<\/evidence-block>$/)?.[1]

    expect(body).toBeTruthy()
    expect(fence.articles[0].evidenceTextHash).toBe(sha256(body))
  })

  it('includes exact trusted source identity in the fence and keeps lookalike keys blocked', () => {
    const article = articleDocument(firstArticleId, firstSourceId, { titleOriginal: 'Nội dung có email dev@example.com' })
    const trustedSource = sourceDocument(firstSourceId, { sourceKey: 'arxiv:cs-ai', connectorType: 'arxiv', authorityTier: 'primary' })
    expect(admittedEvidenceText(article, trustedSource)).toContain('dev@example.com')
    expect(evidenceAdmissionFence(qnaEvidence(article, trustedSource)).articles[0]).toEqual(expect.objectContaining({ sourceKey: 'arxiv:cs-ai' }))
    expect(() => admittedEvidenceText(article, { ...trustedSource, sourceKey: 'arxiv:other' })).toThrow(/policy/i)
  })

  it('does not change the evidence fence when only text outside the provider bound changes', () => {
    const source = sourceDocument(firstSourceId)
    const first = articleDocument(firstArticleId, firstSourceId, { excerptOriginal: `${'A'.repeat(8_000)}tail-a` })
    const second = articleDocument(firstArticleId, firstSourceId, { excerptOriginal: `${'A'.repeat(8_000)}tail-b` })
    const firstPrompt = buildGroundedPrompt({ question: 'Noi dung la gi?', evidence: qnaEvidence(first, source) })
    const secondPrompt = buildGroundedPrompt({ question: 'Noi dung la gi?', evidence: qnaEvidence(second, source) })

    expect(firstPrompt.blocks[0].text).toBe(secondPrompt.blocks[0].text)
    expect(evidenceAdmissionFence(firstPrompt.evidence).digest).toBe(evidenceAdmissionFence(secondPrompt.evidence).digest)
  })

  it('locks only cited articles and their unique sources', async () => {
    const firstArticle = articleDocument(firstArticleId, firstSourceId)
    const secondArticle = articleDocument(secondArticleId, secondSourceId)
    const firstSource = sourceDocument(firstSourceId)
    const secondSource = sourceDocument(secondSourceId)
    const mongo = baseMongo({ articles: [firstArticle, secondArticle], sources: [firstSource, secondSource] })
    const repository = new MongoChatRepository({ db: mongo.db, client: mongo.client, now: () => now })
    const expectedEvidenceFence = evidenceAdmissionFence(qnaEvidence(firstArticle, firstSource).concat(qnaEvidence(secondArticle, secondSource)))

    await append(repository, firstArticle, firstSource, expectedEvidenceFence)

    const storedFirstArticle = await mongo.db.collection('articles').findOne({ _id: firstArticleId })
    const storedSecondArticle = await mongo.db.collection('articles').findOne({ _id: secondArticleId })
    const storedFirstSource = await mongo.db.collection('sources').findOne({ _id: firstSourceId })
    const storedSecondSource = await mongo.db.collection('sources').findOne({ _id: secondSourceId })
    expect(storedFirstArticle.qnaFenceToken).toBeInstanceOf(ObjectId)
    expect(storedFirstSource.qnaFenceToken).toBeInstanceOf(ObjectId)
    expect(storedSecondArticle).not.toHaveProperty('qnaFenceToken')
    expect(storedSecondSource).not.toHaveProperty('qnaFenceToken')
  })

  it.each([
    ['article content', { article: { excerptOriginal: 'Noi dung da thay doi.' } }],
    ['article version', { article: { version: 2 } }],
    ['source policy', { source: { policyVersion: 2 } }],
  ])('returns 409 when the %s changes after evidence admission', async (_label, change) => {
    const article = articleDocument(firstArticleId, firstSourceId)
    const source = sourceDocument(firstSourceId)
    const mongo = baseMongo({ articles: [article], sources: [source] })
    const repository = new MongoChatRepository({ db: mongo.db, client: mongo.client, now: () => now })
    const expectedEvidenceFence = evidenceAdmissionFence(qnaEvidence(article, source))
    const collectionName = change.article ? 'articles' : 'sources'
    const id = change.article ? firstArticleId : firstSourceId
    await mongo.db.collection(collectionName).updateOne({ _id: id }, { $set: change.article ?? change.source })

    await expect(append(repository, article, source, expectedEvidenceFence)).rejects.toMatchObject({ status: 409, code: 'conflict' })
    expect(await mongo.db.collection('chatSessions').countDocuments({})).toBe(0)
  })

  it.each([
    ['article URL', { article: { originalUrl: 'https://example.test/articles/changed' } }],
    ['article publication time', { article: { publishedAt: new Date(now.getTime() + 1_000) } }],
    ['article author', { article: { author: 'Tac gia moi' } }],
    ['article language', { article: { sourceLanguage: 'vi' } }],
    ['source exact key', { source: { sourceKey: 'rss:changed-key' } }],
    ['source name', { source: { name: 'Nguon da doi ten' } }],
  ])('returns 409 when cited %s changes after citation hydration', async (_label, change) => {
    const article = articleDocument(firstArticleId, firstSourceId, { author: 'Tac gia cu', sourceLanguage: 'en' })
    const source = sourceDocument(firstSourceId)
    const mongo = baseMongo({ articles: [article], sources: [source] })
    const repository = new MongoChatRepository({ db: mongo.db, client: mongo.client, now: () => now })
    const expectedEvidenceFence = evidenceAdmissionFence(qnaEvidence(article, source))
    const collectionName = change.article ? 'articles' : 'sources'
    const id = change.article ? firstArticleId : firstSourceId
    await mongo.db.collection(collectionName).updateOne({ _id: id }, { $set: change.article ?? change.source })

    await expect(append(repository, article, source, expectedEvidenceFence)).rejects.toMatchObject({ status: 409, code: 'conflict' })
    expect(await mongo.db.collection('chatSessions').countDocuments({})).toBe(0)
  })

  it('does not reject when only a non-evidence timestamp changes after admission', async () => {
    const article = articleDocument(firstArticleId, firstSourceId)
    const source = sourceDocument(firstSourceId)
    const mongo = baseMongo({ articles: [article], sources: [source] })
    const repository = new MongoChatRepository({ db: mongo.db, client: mongo.client, now: () => now })
    const expectedEvidenceFence = evidenceAdmissionFence(qnaEvidence(article, source))
    await mongo.db.collection('articles').updateOne(
      { _id: firstArticleId },
      { $set: { updatedAt: new Date(now.getTime() + 1_000) } },
    )

    await expect(append(repository, article, source, expectedEvidenceFence)).resolves.toMatchObject({ answer: { status: 'answered' } })
  })

  it('does not treat the internal fence token write as an evidence conflict', async () => {
    const article = articleDocument(firstArticleId, firstSourceId)
    const source = sourceDocument(firstSourceId)
    const mongo = baseMongo({ articles: [article], sources: [source] })
    const repository = new MongoChatRepository({ db: mongo.db, client: mongo.client, now: () => now })
    const expectedEvidenceFence = evidenceAdmissionFence(qnaEvidence(article, source))

    await expect(append(repository, article, source, expectedEvidenceFence, { answerId: 'answer-first' })).resolves.toMatchObject({ answer: { status: 'answered' } })
    await expect(append(repository, article, source, expectedEvidenceFence, { answerId: 'answer-second' })).resolves.toMatchObject({ answer: { status: 'answered' } })
    const stored = await mongo.db.collection('articles').findOne({ _id: firstArticleId })
    expect(stored.updatedAt).toEqual(now)
  })

  it('serializes concurrent finalization so one chat append wins and the other conflicts', async () => {
    const chatId = new ObjectId('507f1f77bcf86cd799439037')
    const attemptId = new ObjectId('507f1f77bcf86cd799439038')
    const chat = { _id: chatId, userId, scope: { topics: ['ai'] }, messages: [], messageCount: 0, expiresAt: new Date(now.getTime() + 60_000), createdAt: now, updatedAt: now }
    let chatReads = 0
    let releaseReads
    const readBarrier = new Promise((resolve) => { releaseReads = resolve })
    let attempt = { _id: attemptId, userId, sessionId, expectedSessionVersion: 2, status: 'provider-running' }
    const collections = {
      users: { findOne: async () => ({ _id: userId, status: 'active', sessionVersion: 2 }), updateOne: async () => ({ matchedCount: 1 }) },
      sessions: { findOne: async () => ({ _id: sessionId, userId, userSessionVersion: 2, status: 'active', expiresAt: new Date(now.getTime() + 60_000), absoluteExpiresAt: new Date(now.getTime() + 60_000) }), updateOne: async () => ({ matchedCount: 1 }) },
      chatSessions: {
        findOne: async () => {
          chatReads += 1
          if (chatReads === 2) releaseReads()
          await readBarrier
          return { ...chat, messages: [...chat.messages] }
        },
        findOneAndUpdate: async (filter, update) => {
          if (filter.messageCount !== chat.messageCount) return { value: null }
          chat.messages = [...chat.messages, ...update.$push.messages.$each]
          chat.messageCount += update.$inc.messageCount
          chat.updatedAt = update.$set.updatedAt
          return { value: { ...chat, messages: [...chat.messages] } }
        },
      },
      answerAttempts: {
        findOneAndUpdate: async (filter, update) => {
          if (!['reserved', 'provider-running'].includes(attempt.status) || filter.status?.$in && !filter.status.$in.includes(attempt.status)) return { value: null }
          attempt = { ...attempt, ...update.$set }
          return { value: { ...attempt } }
        },
      },
    }
    const db = { collection: (name) => collections[name] ?? { findOne: async () => null } }
    const client = { startSession: () => ({ withTransaction: async (work) => work(this), endSession: async () => undefined }) }
    const repository = new MongoChatRepository({ db, client, now: () => now })
    const appendInput = (id) => repository.appendAnswer({
      actor: actor(), chatSessionId: chatId.toHexString(), scope: { topics: ['ai'] }, question: 'Cau hoi?',
      answer: { id, status: 'answered', paragraphs: [{ text: 'Co can cu.', citationIds: [] }] }, attempt: { id: attemptId, outcome: 'completed' }, now,
    })

    const results = await Promise.allSettled([appendInput('answer-a'), appendInput('answer-b')])
    expect(results.filter(({ status }) => status === 'fulfilled')).toHaveLength(1)
    expect(results.filter(({ status, reason }) => status === 'rejected' && reason?.status === 409)).toHaveLength(1)
  })
})
