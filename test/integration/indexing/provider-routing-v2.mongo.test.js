import { MongoClient, ObjectId } from 'mongodb'
import { describe, expect, it } from 'vitest'
import { canonicalUrlHash } from '../../../server/domain/article/identity.js'
import { createMongoContext } from '../../../server/repositories/mongo/connection.js'
import { MongoProviderFailureDomainRepository } from '../../../server/repositories/mongo/provider-failure-domain-repository.js'
import { INDEXING_JOB_COLLECTIONS, INDEXING_JOB_INDEXES } from '../../../scripts/migrations/indexing-jobs.js'
import { CHAT_SESSION_COLLECTIONS, CHAT_SESSION_INDEXES } from '../../../scripts/migrations/chat-sessions.js'
import { ARTICLE_GOVERNANCE_HARDENING_VALIDATOR } from '../../../scripts/migrations/article-governance-hardening.js'
import {
  PROVIDER_ROUTING_V2_COLLECTIONS,
  PROVIDER_ROUTING_V2_INDEXES,
  runProviderRoutingV2Migration,
} from '../../../scripts/migrations/provider-routing-v2.js'

const describeMongo = process.env.MONGODB_TEST_URI ? describe : describe.skip

function materialize(index) {
  return { ...(index.options ?? {}), name: index.name }
}

function legacyArticle(sourceId) {
  const now = new Date('2026-08-15T00:00:00.000Z')
  return {
    _id: new ObjectId(), sourceId, connectorType: 'rss', externalId: 'legacy-item', sourceType: 'rss:example', authorityTier: 'editorial', evidenceEligible: true, status: 'published',
    titleOriginal: 'Legacy ready embedding', titleVi: null, originalUrl: 'https://example.com/legacy', canonicalUrl: 'https://example.com/legacy', canonicalUrlHash: canonicalUrlHash('https://example.com/legacy'), publishedAt: now, retrievedAt: now, sourceLanguage: 'en', topics: ['ai'], searchTextNormalized: 'legacy ready embedding',
    leadMedia: null, leadMediaStatus: 'none', summaryVi: null, summaryStatus: 'pending', summaryBasis: null, summaryModel: null, summaryInputHash: null, summarySourcePolicyVersion: null, summaryGeneratedAt: null, summaryError: null, contentScope: 'metadata', rightsSnapshot: { sourcePolicyVersion: 4, licenseStatus: 'permitted', llmInputScope: 'metadata', capturedAt: now },
    embeddingStatus: 'ready', embedding: [0.1, 0.2], embeddingModel: 'legacy-model', embeddingDimensions: 2, embeddingInputHash: 'a'.repeat(64), embeddingVersion: 1, embeddingSourcePolicyVersion: 4, embeddedAt: now, embeddingError: null,
    provenance: [{ sourceId, originalUrl: 'https://example.com/legacy', externalId: 'legacy-item', observedAt: now }], dedupeKey: 'legacy:item', createdAt: now, updatedAt: now,
  }
}

describeMongo('provider-routing-v2 Mongo migration and shared CAS', () => {
  it('applies predecessor -> v2 -> v2, preserves strict unions, and admits one concurrent half-open probe', async () => {
    const client = new MongoClient(process.env.MONGODB_TEST_URI)
    await client.connect()
    const database = `techpulse_provider_v2_${process.pid}_${Date.now()}`
    const context = createMongoContext({ client, database })
    const db = context.db
    const sourceId = new ObjectId()
    try {
      await db.createCollection('providerAdmissionStates', { validator: INDEXING_JOB_COLLECTIONS.providerAdmissionStates.validator, validationLevel: 'strict', validationAction: 'error' })
      await db.createCollection('indexingJobs', { validator: INDEXING_JOB_COLLECTIONS.indexingJobs.validator, validationLevel: 'strict', validationAction: 'error' })
      await db.createCollection('answerAttempts', { validator: CHAT_SESSION_COLLECTIONS.answerAttempts.validator, validationLevel: 'strict', validationAction: 'error' })
      await db.createCollection('articles', { validator: ARTICLE_GOVERNANCE_HARDENING_VALIDATOR, validationLevel: 'strict', validationAction: 'error' })
      await db.createCollection('sources')
      for (const index of INDEXING_JOB_INDEXES.providerAdmissionStates) await db.collection('providerAdmissionStates').createIndex(index.key, materialize(index))
      for (const index of INDEXING_JOB_INDEXES.indexingJobs) await db.collection('indexingJobs').createIndex(index.key, materialize(index))
      for (const index of CHAT_SESSION_INDEXES.answerAttempts) await db.collection('answerAttempts').createIndex(index.key, materialize(index))

      const now = new Date('2026-08-15T00:00:00.000Z')
      await db.collection('providerAdmissionStates').insertOne({
        _id: new ObjectId(), admissionDomainId: 'legacy-admission', provider: 'provider-main', activeReservations: [], maxConcurrency: 2,
        budgetWindowStart: now, spentUnits: 3, budgetLimit: 10, routeCircuits: [], updatedAt: now,
      })
      const article = legacyArticle(sourceId)
      await db.collection('articles').insertOne(article)
      await db.collection('sources').insertOne({
        _id: sourceId, policyVersion: 4, reconciliation: {
          status: 'processing', requiredPolicyVersion: 4, completedPolicyVersion: null,
          requestedAt: now, error: null, cursorArticleId: new ObjectId('ffffffffffffffffffffffff'),
        }, updatedAt: now,
      })

      await runProviderRoutingV2Migration({ db })
      await runProviderRoutingV2Migration({ db })

      expect(await db.collection('providerAdmissionStates').findOne({ admissionDomainId: 'legacy-admission' })).toMatchObject({ providerId: 'provider-main', spentUnits: 3, budgetLimit: 10 })
      expect(await db.collection('articles').findOne({ _id: article._id })).toMatchObject({
        embeddingStatus: 'pending', embedding: null, embeddingModel: null,
        embeddingCutover: { epoch: 'provider-routing-v2', status: 'materialized' },
      })
      const reconciledSource = await db.collection('sources').findOne({ _id: sourceId })
      expect(reconciledSource).toMatchObject({ reconciliation: { status: 'pending', requiredPolicyVersion: 4 } })
      expect(reconciledSource.reconciliation.cursorArticleId).toBeUndefined()

      const metadata = new Map((await db.listCollections({}, { nameOnly: false }).toArray()).map((entry) => [entry.name, entry]))
      for (const [name, definition] of Object.entries(PROVIDER_ROUTING_V2_COLLECTIONS)) expect(metadata.get(name)?.options?.validator).toEqual(definition.validator)
      for (const [name, indexes] of Object.entries(PROVIDER_ROUTING_V2_INDEXES)) {
        const actual = new Set((await db.collection(name).indexes()).map((index) => index.name))
        for (const expected of indexes) expect(actual.has(expected.name)).toBe(true)
      }

      await db.collection('providerFailureDomainStates').insertOne({
        providerFailureDomainId: 'provider-main', configVersion: 1, state: 'open', consecutiveRetryableFailures: 3,
        cooldownUntil: new Date(now.getTime() - 1), updatedAt: new Date(now.getTime() - 60_000),
      })
      const repository = new MongoProviderFailureDomainRepository(context)
      const domain = { providerFailureDomainId: 'provider-main', configVersion: 1, failureThreshold: 3, cooldownSeconds: 60 }
      const [first, second] = await Promise.all([
        repository.admitProviderDomain({ domain, reservationId: 'half-open-probe-a', now }),
        repository.admitProviderDomain({ domain, reservationId: 'half-open-probe-b', now }),
      ])
      expect([first, second].filter(({ allowed }) => allowed)).toHaveLength(1)
      expect([first, second].filter(({ allowed }) => !allowed)).toHaveLength(1)
    } finally {
      await db.dropDatabase()
      await client.close()
    }
  }, 60_000)
})
