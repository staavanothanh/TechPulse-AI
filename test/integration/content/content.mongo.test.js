import { MongoClient, ObjectId } from 'mongodb'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { normalizeCandidateToArticle } from '../../../server/domain/article/normalization.js'
import { MongoArticleRepository } from '../../../server/repositories/mongo/article-repository.js'
import { runArticlesMigration } from '../../../scripts/migrations/articles.js'
import { runAuthCoreMigration } from '../../../scripts/migrations/auth-core.js'
import { runDurableJobsMigration } from '../../../scripts/migrations/durable-jobs.js'
import { runSourcesMigration } from '../../../scripts/migrations/sources.js'
import { makeCandidate, makeSource, RETRIEVED_AT } from '../../unit/articles/fixtures.js'

const hasMongo = Boolean(process.env.MONGODB_TEST_URI)
const describeMongo = hasMongo ? describe : describe.skip
const USER_ID = new ObjectId('507f1f77bcf86cd799439001')
const OTHER_USER_ID = new ObjectId('507f1f77bcf86cd799439002')
const DELETED_USER_ID = new ObjectId('507f1f77bcf86cd799439003')
const SESSION_ID = new ObjectId('507f1f77bcf86cd799439004')
const DELETED_SESSION_ID = new ObjectId('507f1f77bcf86cd799439005')
const SESSION_VERSION = 7
const SOURCE_ID = new ObjectId('507f1f77bcf86cd799439011')
const BLOCKED_SOURCE_ID = new ObjectId('507f1f77bcf86cd799439012')
const FIRST_ID = new ObjectId('507f1f77bcf86cd799439021')
const SECOND_ID = new ObjectId('507f1f77bcf86cd799439022')
const HIDDEN_ID = new ObjectId('507f1f77bcf86cd799439023')
const BLOCKED_ID = new ObjectId('507f1f77bcf86cd799439024')

function sourceDocument({ id, sourceKey, operationalStatus = 'active', licenseStatus = 'metadata-only' }) {
  const blocked = licenseStatus === 'blocked'
  return {
    _id: id,
    name: sourceKey,
    sourceKey,
    publisherName: sourceKey,
    domain: 'news.example.com',
    connectorType: 'rss',
    accessMethod: 'rss',
    authorityTier: 'editorial',
    connectorConfig: { kind: 'rss', feedUrl: `https://news.example.com/${sourceKey}.xml`, batchSize: 20 },
    operationalStatus,
    licenseStatus,
    llmInputScope: blocked ? 'none' : 'metadata',
    storageScope: { metadata: !blocked, excerpt: false, summary: false, embedding: false },
    mediaPolicy: { imageMode: 'none', videoMode: 'none', allowedHosts: [], attributionRequired: false, evidenceNote: null },
    attributionRequired: false,
    policyVersion: 3,
    reviewedAt: RETRIEVED_AT,
    reviewedBy: new ObjectId(),
    evidenceNote: 'Step 8 disposable Mongo policy',
    reconciliation: { status: 'idle', requiredPolicyVersion: 3, completedPolicyVersion: null, requestedAt: null, error: null },
    technicalCheck: { status: 'passed', checkedAt: RETRIEVED_AT, contentType: 'application/rss+xml', resolvedHost: 'news.example.com', sampleCount: 1, error: null },
    health: { lastIngestSucceededAt: null, lastIngestFailedAt: null, consecutiveFailures: 0, lastError: null },
    createdAt: RETRIEVED_AT,
    updatedAt: RETRIEVED_AT,
  }
}

function mongoArticle(article, id) {
  return {
    ...article,
    _id: id,
    sourceId: new ObjectId(article.sourceId),
    provenance: article.provenance.map((entry) => ({ ...entry, sourceId: new ObjectId(entry.sourceId) })),
  }
}

function userDocument({ id, email }) {
  return { _id: id, emailNormalized: email, emailDisplay: email, passwordHash: `scrypt$16384$8$1$s:${'s'.repeat(64)}`, role: 'user', status: 'active', topicPreferences: [], sessionVersion: SESSION_VERSION, createdAt: RETRIEVED_AT, updatedAt: RETRIEVED_AT }
}

function sessionDocument({ id, userId, token }) {
  return { _id: id, tokenHash: token.repeat(64).slice(0, 64), userId, userSessionVersion: SESSION_VERSION, csrfSecretHash: 'c'.repeat(64), status: 'active', absoluteExpiresAt: new Date('2026-08-12T00:00:00.000Z'), expiresAt: new Date('2026-08-12T00:00:00.000Z'), lastSeenAt: RETRIEVED_AT, createdAt: RETRIEVED_AT }
}

describeMongo('Step 8 disposable Mongo visibility, ownership and pagination', () => {
  let client
  let db
  let repository

  beforeAll(async () => {
    client = new MongoClient(process.env.MONGODB_TEST_URI)
    await client.connect()
    db = client.db(`techpulse_step8_${Date.now()}_${Math.random().toString(16).slice(2)}`)
    await runAuthCoreMigration({ db })
    await runSourcesMigration({ db })
    await runDurableJobsMigration({ db })
    await runArticlesMigration({ db })
    await db.collection('users').insertMany([
      userDocument({ id: USER_ID, email: 'step8-user@example.com' }),
      userDocument({ id: DELETED_USER_ID, email: 'step8-deleted@example.com' }),
    ])
    await db.collection('sessions').insertMany([
      sessionDocument({ id: SESSION_ID, userId: USER_ID, token: 'a' }),
      sessionDocument({ id: DELETED_SESSION_ID, userId: DELETED_USER_ID, token: 'b' }),
    ])
    const visibleSourceDocument = sourceDocument({ id: SOURCE_ID, sourceKey: 'rss:step8-visible' })
    const blockedSourceDocument = sourceDocument({ id: BLOCKED_SOURCE_ID, sourceKey: 'rss:step8-blocked', operationalStatus: 'paused', licenseStatus: 'blocked' })
    await db.collection('sources').insertMany([visibleSourceDocument, blockedSourceDocument])
    const visibleSource = makeSource({ id: SOURCE_ID.toHexString(), policyVersion: 3 })

    const first = normalizeCandidateToArticle(makeCandidate({ sourceId: SOURCE_ID.toHexString(), externalId: 'step8-first', originalUrl: 'https://example.com/step8-first', publishedAt: '2026-08-10T10:00:00.000Z', provenance: { sourceId: SOURCE_ID.toHexString(), originalUrl: 'https://example.com/step8-first', externalId: 'step8-first', observedAt: RETRIEVED_AT } }), { source: visibleSource, now: RETRIEVED_AT })
    const second = normalizeCandidateToArticle(makeCandidate({ sourceId: SOURCE_ID.toHexString(), externalId: 'step8-second', originalUrl: 'https://example.com/step8-second', publishedAt: '2026-08-10T09:00:00.000Z', provenance: { sourceId: SOURCE_ID.toHexString(), originalUrl: 'https://example.com/step8-second', externalId: 'step8-second', observedAt: RETRIEVED_AT } }), { source: visibleSource, now: RETRIEVED_AT })
    const hidden = {
      ...normalizeCandidateToArticle(makeCandidate({ sourceId: SOURCE_ID.toHexString(), externalId: 'step8-hidden', originalUrl: 'https://example.com/step8-hidden', publishedAt: '2026-08-10T08:00:00.000Z', provenance: { sourceId: SOURCE_ID.toHexString(), originalUrl: 'https://example.com/step8-hidden', externalId: 'step8-hidden', observedAt: RETRIEVED_AT } }), { source: visibleSource, now: RETRIEVED_AT }),
      status: 'hidden',
    }
    const blockedCandidate = normalizeCandidateToArticle(makeCandidate({ sourceId: SOURCE_ID.toHexString(), externalId: 'step8-blocked', originalUrl: 'https://example.com/step8-blocked', publishedAt: '2026-08-10T07:00:00.000Z', provenance: { sourceId: SOURCE_ID.toHexString(), originalUrl: 'https://example.com/step8-blocked', externalId: 'step8-blocked', observedAt: RETRIEVED_AT } }), { source: visibleSource, now: RETRIEVED_AT })
    const blocked = {
      ...blockedCandidate,
      sourceId: BLOCKED_SOURCE_ID.toHexString(),
      provenance: blockedCandidate.provenance.map((entry) => ({ ...entry, sourceId: BLOCKED_SOURCE_ID.toHexString() })),
    }
    await db.collection('articles').insertMany([mongoArticle(first, FIRST_ID), mongoArticle(second, SECOND_ID), mongoArticle(hidden, HIDDEN_ID), mongoArticle(blocked, BLOCKED_ID)])
    await db.collection('savedArticles').insertMany([
      { _id: new ObjectId(), userId: USER_ID, articleId: FIRST_ID, createdAt: new Date('2026-08-11T10:00:00.000Z') },
      { _id: new ObjectId(), userId: USER_ID, articleId: HIDDEN_ID, createdAt: new Date('2026-08-11T09:00:00.000Z') },
      { _id: new ObjectId(), userId: USER_ID, articleId: BLOCKED_ID, createdAt: new Date('2026-08-11T08:00:00.000Z') },
      { _id: new ObjectId(), userId: OTHER_USER_ID, articleId: SECOND_ID, createdAt: new Date('2026-08-11T07:00:00.000Z') },
    ])
    repository = new MongoArticleRepository({ db, client, now: () => new Date('2026-08-11T11:00:00.000Z') })
  })

  afterAll(async () => {
    if (db) await db.dropDatabase()
    if (client) await client.close()
  })

  it('paginates visible articles with an opaque cursor and never returns hidden or blocked content', async () => {
    const firstPage = await repository.listVisibleArticles({ userId: USER_ID.toHexString(), limit: 1 })
    const secondPage = await repository.listVisibleArticles({ userId: USER_ID.toHexString(), limit: 1, cursor: firstPage.nextCursor })
    expect(firstPage).toEqual(expect.objectContaining({ hasNext: true, totalItems: 2, articles: [expect.objectContaining({ id: FIRST_ID.toHexString(), isSaved: true })] }))
    expect(secondPage).toEqual(expect.objectContaining({ hasNext: false, nextCursor: null, totalItems: 2, articles: [expect.objectContaining({ id: SECOND_ID.toHexString(), isSaved: false })] }))
    expect(JSON.stringify([firstPage, secondPage])).not.toMatch(new RegExp(`${HIDDEN_ID}|${BLOCKED_ID}`))
  })

  it('filters and cleans ineligible saved relations without touching another user', async () => {
    const page = await repository.listSavedVisibleArticles({ userId: USER_ID.toHexString(), limit: 20 })
    expect(page.articles.map((article) => article.id)).toEqual([FIRST_ID.toHexString()])
    expect(await db.collection('savedArticles').countDocuments({ userId: USER_ID })).toBe(1)
    expect(await db.collection('savedArticles').countDocuments({ userId: OTHER_USER_ID })).toBe(1)
    await repository.clearSavedArticles({ userId: USER_ID.toHexString() })
    expect(await db.collection('savedArticles').countDocuments({ userId: USER_ID })).toBe(0)
    expect(await db.collection('savedArticles').countDocuments({ userId: OTHER_USER_ID })).toBe(1)
  })

  it('keeps a visible saved relation reachable after more than 501 stale relations', async () => {
    const baseTime = new Date('2026-08-11T10:00:00.000Z').getTime()
    const staleRelations = Array.from({ length: 502 }, (_, index) => ({ _id: new ObjectId(), userId: USER_ID, articleId: new ObjectId(), createdAt: new Date(baseTime - index) }))
    await db.collection('savedArticles').insertMany([...staleRelations, { _id: new ObjectId(), userId: USER_ID, articleId: SECOND_ID, createdAt: new Date(baseTime - 502) }])

    const page = await repository.listSavedVisibleArticles({ userId: USER_ID.toHexString(), limit: 1 })

    expect(page.articles.map((item) => item.id)).toEqual([SECOND_ID.toHexString()])
    expect(await db.collection('savedArticles').countDocuments({ userId: USER_ID })).toBe(1)
  })

  it('transactionally refuses stale suspended/deleted principals and keeps search inside current visibility', async () => {
    const actorFence = { sessionId: SESSION_ID.toHexString(), sessionVersion: SESSION_VERSION }
    expect(await repository.saveVisibleArticle({ userId: USER_ID.toHexString(), articleId: HIDDEN_ID.toHexString(), actorFence })).toBe(false)
    await db.collection('savedArticles').deleteMany({ userId: USER_ID })
    await db.collection('users').updateOne({ _id: USER_ID }, { $set: { status: 'suspended', suspendedAt: new Date('2026-08-11T10:59:00.000Z'), suspensionReason: 'user_suspended', updatedAt: new Date('2026-08-11T10:59:00.000Z') }, $inc: { sessionVersion: 1 } })
    await expect(repository.saveVisibleArticle({ userId: USER_ID.toHexString(), articleId: FIRST_ID.toHexString(), actorFence })).rejects.toMatchObject({ status: 409, code: 'conflict' })
    expect(await db.collection('savedArticles').countDocuments({ userId: USER_ID })).toBe(0)
    await db.collection('users').updateOne({ _id: DELETED_USER_ID }, { $set: { status: 'deleted', deletionRequestedAt: new Date('2026-08-11T10:58:00.000Z'), deletionRequestId: new ObjectId(), deletedAt: new Date('2026-08-11T10:59:00.000Z'), updatedAt: new Date('2026-08-11T10:59:00.000Z') }, $inc: { sessionVersion: 1 }, $unset: { emailNormalized: '', emailDisplay: '', passwordHash: '', role: '', topicPreferences: '' } })
    await db.collection('sessions').deleteOne({ _id: DELETED_SESSION_ID })
    await expect(repository.saveVisibleArticle({ userId: DELETED_USER_ID.toHexString(), articleId: FIRST_ID.toHexString(), actorFence: { sessionId: DELETED_SESSION_ID.toHexString(), sessionVersion: SESSION_VERSION } })).rejects.toMatchObject({ status: 409, code: 'conflict' })
    expect(await db.collection('savedArticles').countDocuments({ userId: DELETED_USER_ID })).toBe(0)
    const firstPage = await repository.searchVisibleArticles({ userId: USER_ID.toHexString(), q: 'AI', mode: 'text', limit: 1 })
    const secondPage = await repository.searchVisibleArticles({ userId: USER_ID.toHexString(), q: 'AI', mode: 'text', cursor: firstPage.nextCursor, limit: 1 })
    expect(firstPage).toEqual(expect.objectContaining({ hasNext: true, nextCursor: expect.any(String) }))
    expect([...firstPage.results, ...secondPage.results].map((result) => result.article.id)).toEqual([FIRST_ID.toHexString(), SECOND_ID.toHexString()])
  })
})
