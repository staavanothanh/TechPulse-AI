import { createHash } from 'node:crypto'
import { MongoClient, ObjectId } from 'mongodb'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { normalizeCandidateToArticle } from '../../../server/domain/article/normalization.js'
import { admittedEvidenceText, evidenceCitationMetadataHash } from '../../../server/domain/qa/evidence.js'
import { createMongoContext } from '../../../server/repositories/mongo/connection.js'
import { MongoChatRepository } from '../../../server/repositories/mongo/chat-repository.js'
import { databaseNameForSuite, dropTestDatabase } from '../../../scripts/atlas-test-safety.js'
import { runAuthCoreMigration } from '../../../scripts/migrations/auth-core.js'
import { runSourcesMigration } from '../../../scripts/migrations/sources.js'
import { runDurableJobsMigration } from '../../../scripts/migrations/durable-jobs.js'
import { runArticlesMigration } from '../../../scripts/migrations/articles.js'
import { runIndexingJobsMigration } from '../../../scripts/migrations/indexing-jobs.js'
import { runChatSessionsMigration } from '../../../scripts/migrations/chat-sessions.js'
import { runArticleGovernanceHardeningMigration } from '../../../scripts/migrations/article-governance-hardening.js'
import { runProviderRoutingV2Migration } from '../../../scripts/migrations/provider-routing-v2.js'
import {
  QA_EVIDENCE_FENCE_ARTICLE_VALIDATOR,
  QA_EVIDENCE_FENCE_SOURCE_VALIDATOR,
  runQaEvidenceFenceMigration,
} from '../../../scripts/migrations/qa-evidence-fence.js'
import { makeCandidate, makeSource } from '../../unit/articles/fixtures.js'

const hasMongo = Boolean(process.env.MONGODB_TEST_URI)
const describeMongo = hasMongo ? describe : describe.skip

const now = new Date('2026-08-24T00:00:00.000Z')
const userId = new ObjectId('507f1f77bcf86cd799439201')
const sessionId = new ObjectId('507f1f77bcf86cd799439202')
const sourceId = new ObjectId('507f1f77bcf86cd799439203')
const articleId = new ObjectId('507f1f77bcf86cd799439204')

function sourceDocument() {
  return {
    _id: sourceId,
    name: 'QA Fence Source',
    sourceKey: 'rss:qa-fence',
    publisherName: 'QA Fence Publisher',
    domain: 'example.com',
    connectorType: 'rss',
    accessMethod: 'rss',
    authorityTier: 'editorial',
    connectorConfig: { kind: 'rss', feedUrl: 'https://example.com/qa-fence.xml', batchSize: 20 },
    operationalStatus: 'active',
    licenseStatus: 'permitted',
    llmInputScope: 'excerpt',
    storageScope: { metadata: true, excerpt: true, summary: true, embedding: true },
    mediaPolicy: { imageMode: 'none', videoMode: 'none', allowedHosts: [], attributionRequired: false, evidenceNote: null },
    attributionRequired: false,
    attributionText: null,
    termsUrl: null,
    licenseUrl: null,
    evidenceNote: 'qa evidence fence isolated integration test',
    reviewedAt: now,
    reviewedBy: userId,
    policyVersion: 1,
    reconciliation: { status: 'idle', requiredPolicyVersion: 1, completedPolicyVersion: null, requestedAt: null, error: null },
    technicalCheck: { status: 'passed', checkedAt: now, contentType: 'application/rss+xml', resolvedHost: 'example.com', sampleCount: 1, error: null },
    health: { lastIngestSucceededAt: null, lastIngestFailedAt: null, consecutiveFailures: 0, lastError: null },
    createdAt: now,
    updatedAt: now,
  }
}

function articleDocument() {
  const source = sourceDocument()
  const sourceForNormalization = { ...makeSource({ id: sourceId.toHexString(), sourceKey: source.sourceKey, policyVersion: source.policyVersion }), ...source, id: sourceId.toHexString() }
  const normalized = normalizeCandidateToArticle(
    makeCandidate({ sourceId: sourceId.toHexString(), externalId: 'qa-fence-article', originalUrl: 'https://example.com/qa-fence-article' }),
    { source: sourceForNormalization, now },
  )
  return {
    ...normalized,
    _id: articleId,
    sourceId,
    provenance: normalized.provenance.map((entry) => ({ ...entry, sourceId: new ObjectId(entry.sourceId) })),
  }
}

function userDocument() {
  return {
    _id: userId,
    emailNormalized: 'qa-fence@example.com',
    emailDisplay: 'qa-fence@example.com',
    passwordHash: `scrypt$16384$8$1$s:${'s'.repeat(64)}`,
    role: 'user',
    status: 'active',
    topicPreferences: [],
    sessionVersion: 1,
    createdAt: now,
    updatedAt: now,
  }
}

function sessionDocument() {
  const expiresAt = new Date(now.getTime() + 60 * 60 * 1000)
  return {
    _id: sessionId,
    tokenHash: 'a'.repeat(64),
    userId,
    userSessionVersion: 1,
    csrfSecretHash: 'b'.repeat(64),
    status: 'active',
    absoluteExpiresAt: expiresAt,
    expiresAt,
    lastSeenAt: now,
    createdAt: now,
  }
}

function actor() {
  return { userId, sessionId, sessionVersion: 1 }
}

function citation() {
  return {
    id: 'C1',
    articleId,
    sourceId,
    originalUrl: 'https://example.com/qa-fence-article',
    titleOriginal: 'AI systems & safety',
    publishedAt: new Date('2026-08-23T00:00:00.000Z'),
  }
}

function evidenceFence(article, source) {
  return {
    articles: [{
      articleId: article._id.toHexString(),
      sourceId: source._id.toHexString(),
      articleVersion: null,
      sourcePolicyVersion: source.policyVersion,
      evidenceTextHash: createHash('sha256').update(admittedEvidenceText(article, source)).digest('hex'),
      citationMetadataHash: evidenceCitationMetadataHash(article, source),
    }],
  }
}

async function applyPrerequisiteMigrations(db) {
  await runAuthCoreMigration({ db })
  await runSourcesMigration({ db })
  await runDurableJobsMigration({ db })
  await runArticlesMigration({ db })
  await runIndexingJobsMigration({ db })
  await runChatSessionsMigration({ db })
  await runArticleGovernanceHardeningMigration({ db })
  await runProviderRoutingV2Migration({ db })
  await runQaEvidenceFenceMigration({ db })
  await runQaEvidenceFenceMigration({ db })
}

describeMongo('Q&A evidence fence Atlas integration', () => {
  let client
  let context
  let database
  let repository
  let source
  let article

  beforeAll(async () => {
    client = new MongoClient(process.env.MONGODB_TEST_URI)
    await client.connect()
    database = databaseNameForSuite('qa_fence')
    context = createMongoContext({ client, database })
    await applyPrerequisiteMigrations(context.db)
    source = sourceDocument()
    article = articleDocument()
    await context.db.collection('users').insertOne(userDocument())
    await context.db.collection('sessions').insertOne(sessionDocument())
    await context.db.collection('sources').insertOne(source)
    await context.db.collection('articles').insertOne(article)
    repository = new MongoChatRepository({ db: context.db, client, now: () => now })
  }, 60_000)

  afterAll(async () => {
    if (context) await dropTestDatabase({ context, expectedDatabase: database })
    if (client) await client.close()
  })

  it('applies qa-evidence-fence and atomically commits cited article/source locks with chat and attempt', async () => {
    const definitions = new Map((await context.db.listCollections({}, { nameOnly: false }).toArray()).map((entry) => [entry.name, entry]))
    expect(definitions.get('articles')?.options?.validator).toEqual(QA_EVIDENCE_FENCE_ARTICLE_VALIDATOR)
    expect(definitions.get('sources')?.options?.validator).toEqual(QA_EVIDENCE_FENCE_SOURCE_VALIDATOR)

    const answerAttempt = await repository.reserveAnswerAttempt({
      actor: actor(),
      idempotencyKeyHash: createHash('sha256').update('qa-fence-idempotency').digest('hex'),
      requestHash: createHash('sha256').update('qa-fence-request').digest('hex'),
      quotaReservationKey: 'qa-fence-test',
      now,
    })
    const answer = {
      id: 'qa-fence-answer',
      status: 'answered',
      paragraphs: [{ text: 'Bai viet neu mot ket luan co can cu.', citationIds: ['C1'] }],
    }
    const result = await repository.appendAnswer({
      actor: actor(),
      scope: { articleId },
      question: 'Bai viet neu ket luan gi?',
      answer,
      citations: [citation()],
      attempt: { id: answerAttempt._id, outcome: 'completed' },
      now,
      expectedEvidenceFence: evidenceFence(article, source),
    })

    expect(result).toMatchObject({ answer: { status: 'answered' }, attemptCommitted: true })
    const lockedArticle = await context.db.collection('articles').findOne({ _id: articleId })
    const lockedSource = await context.db.collection('sources').findOne({ _id: sourceId })
    expect(lockedArticle.qnaFenceToken).toBeInstanceOf(ObjectId)
    expect(lockedSource.qnaFenceToken).toBeInstanceOf(ObjectId)
    expect(lockedArticle.qnaFenceToken.equals(lockedSource.qnaFenceToken)).toBe(true)

    const committedChat = await context.db.collection('chatSessions').findOne({ _id: new ObjectId(result.chatSessionId) })
    const committedAttempt = await context.db.collection('answerAttempts').findOne({ _id: answerAttempt._id })
    expect(committedChat).toMatchObject({ userId, messageCount: 2, messages: [{ role: 'user' }, { role: 'assistant', status: 'answered' }] })
    expect(committedAttempt).toMatchObject({ status: 'completed', resultStatus: 'answered', chatSessionId: committedChat._id, messageId: 'qa-fence-answer' })
  }, 60_000)

  it('rolls back locks and chat/attempt writes together when the append boundary rejects', async () => {
    const answerAttempt = await repository.reserveAnswerAttempt({
      actor: actor(),
      idempotencyKeyHash: createHash('sha256').update('qa-fence-rollback-idempotency').digest('hex'),
      requestHash: createHash('sha256').update('qa-fence-rollback-request').digest('hex'),
      quotaReservationKey: 'qa-fence-rollback',
      now,
    })
    const beforeArticle = await context.db.collection('articles').findOne({ _id: articleId })
    const beforeChatCount = await context.db.collection('chatSessions').countDocuments({ userId })

    await expect(repository.appendAnswer({
      actor: actor(),
      scope: { articleId },
      question: 'Tao giao dich khong hop le',
      answer: { id: 'qa-fence-rollback-answer', status: 'answered', paragraphs: [{ text: 'Noi dung.', citationIds: ['C1'] }] },
      citations: [citation()],
      attempt: { id: answerAttempt._id, outcome: 'invalid-outcome' },
      now,
      expectedEvidenceFence: evidenceFence(article, source),
    })).rejects.toThrow('Answer attempt outcome is invalid')

    const afterArticle = await context.db.collection('articles').findOne({ _id: articleId })
    const afterAttempt = await context.db.collection('answerAttempts').findOne({ _id: answerAttempt._id })
    expect(afterArticle.qnaFenceToken).toEqual(beforeArticle.qnaFenceToken)
    expect(await context.db.collection('chatSessions').countDocuments({ userId })).toBe(beforeChatCount)
    expect(afterAttempt).toMatchObject({ status: 'reserved' })
  }, 60_000)
})
