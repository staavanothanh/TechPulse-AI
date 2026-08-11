import { readFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { MongoClient, ObjectId } from 'mongodb'
import { describe, expect, it } from 'vitest'
import { runAuthCoreMigration } from '../../../scripts/migrations/auth-core.js'
import { runSourcesMigration } from '../../../scripts/migrations/sources.js'
import { runDurableJobsMigration } from '../../../scripts/migrations/durable-jobs.js'
import { runArticlesMigration } from '../../../scripts/migrations/articles.js'
import { createMongoContext } from '../../../server/repositories/mongo/connection.js'
import { databaseNameForSuite, dropTestDatabase } from '../../../scripts/atlas-test-safety.js'
import { MongoSourceRepository } from '../../../server/repositories/mongo/source-repository.js'
import { MongoJobRepository } from '../../../server/repositories/mongo/job-repository.js'
import { MongoLeaseRepository } from '../../../server/repositories/mongo/lease-repository.js'
import { MongoArticleRepository } from '../../../server/repositories/mongo/article-repository.js'
import { deriveLeaseKey } from '../../../server/domain/jobs/lease-keys.js'
import { createDefaultConnectorRegistry } from '../../../server/connectors/registry.js'
import { createIngestionService } from '../../../server/application/ingestion/service.js'

const hasMongo = Boolean(process.env.MONGODB_TEST_URI)
const describeMongo = hasMongo ? describe : describe.skip
const FIXTURE_ROOT = new URL('../../fixtures/', import.meta.url)
const RETRIEVED_AT = new Date('2026-08-11T00:00:00.000Z')

async function fixture(path) {
  return readFile(new URL(path, FIXTURE_ROOT))
}

function sourceDocument({ id = new ObjectId(), connectorType, accessMethod, authorityTier, sourceKey, connectorConfig, domain, mediaPolicy, now = RETRIEVED_AT } = {}) {
  return {
    _id: id, name: sourceKey, sourceKey, publisherName: sourceKey, domain, connectorType, accessMethod, authorityTier, connectorConfig,
    operationalStatus: 'active', licenseStatus: 'metadata-only', llmInputScope: 'metadata', storageScope: { metadata: true, excerpt: false, summary: false, embedding: false },
    mediaPolicy: mediaPolicy ?? { imageMode: 'none', videoMode: 'none', allowedHosts: [], attributionRequired: false, evidenceNote: null }, attributionRequired: false,
    policyVersion: 1, reviewedAt: now, reviewedBy: new ObjectId(), evidenceNote: 'loopback integration policy',
    reconciliation: { status: 'idle', requiredPolicyVersion: 1, completedPolicyVersion: null, requestedAt: null, error: null },
    technicalCheck: { status: 'passed', checkedAt: now, contentType: 'application/json', resolvedHost: domain, sampleCount: 1, error: null },
    health: { lastIngestSucceededAt: null, lastIngestFailedAt: null, consecutiveFailures: 0, lastError: null }, createdAt: now, updatedAt: now,
  }
}

function jobDocument(source, suffix, now = RETRIEVED_AT) {
  const sourceId = source._id.toHexString()
  return {
    id: new ObjectId().toHexString(), idempotencyKey: `step7-${suffix}-0001`, actorScope: 'system:test', requestHash: createHash('sha256').update(suffix).digest('hex'),
    sourceId, connectorType: source.connectorType, expectedSourcePolicyVersion: source.policyVersion, trigger: 'cron', status: 'queued', attempt: 1, priority: 0,
    availableAt: now, agingEligibleAt: new Date(now.getTime() + 30 * 60 * 1000), idempotencyExpiresAt: new Date(now.getTime() + 14 * 24 * 60 * 60 * 1000), leaseGeneration: 0, batchSize: source.connectorConfig.batchSize,
    counters: { fetched: 0, created: 0, updated: 0, duplicate: 0, skipped: 0, failed: 0 }, createdAt: now, updatedAt: now,
  }
}

async function prepareJob({ jobs, leases, source, suffix }) {
  const created = await jobs.createSystemIngestionJob({ job: jobDocument(source, suffix) })
  const fence = await leases.acquire({ key: deriveLeaseKey('ingestion', source._id.toHexString()), jobId: created.id, ownerToken: `step7-owner-${suffix}`, leaseMs: 30_000 })
  expect(await jobs.claimQueuedWithFence({ jobId: created.id, fence })).toBe(true)
  return { job: await jobs.findIngestionJobById(created.id), fence }
}

async function withDatabase(slug, callback) {
  const client = new MongoClient(process.env.MONGODB_TEST_URI)
  await client.connect()
  const database = databaseNameForSuite(slug)
  const context = createMongoContext({ client, database })
  try {
    await runAuthCoreMigration({ db: context.db })
    await runSourcesMigration({ db: context.db })
    await runDurableJobsMigration({ db: context.db })
    await runArticlesMigration({ db: context.db })
    return await callback({ client, context })
  } finally {
    await dropTestDatabase({ context, expectedDatabase: database })
    await client.close()
  }
}

function buildService(context, registry = createDefaultConnectorRegistry(), sourceRepository = new MongoSourceRepository(context)) {
  const articles = new MongoArticleRepository(context)
  return { service: createIngestionService({ connectorRegistry: registry, sourceRepository, articleRepository: articles, currentSourcePolicy: { content: async ({ sourceId }) => ({ allowed: true, policyVersion: (await sourceRepository.findSourceById(sourceId)).policyVersion }) }, now: () => RETRIEVED_AT }), articles }
}

describeMongo('Step 7 Mongo ingestion pipeline', () => {
  it('runs RSS, arXiv and Hacker News through the production registry into Mongo without linked fetch or response persistence', async () => {
    await withDatabase('pipe', async ({ context }) => {
      const rss = sourceDocument({ connectorType: 'rss', accessMethod: 'rss', authorityTier: 'editorial', sourceKey: 'rss:loopback', domain: 'news.example.com', connectorConfig: { kind: 'rss', feedUrl: 'https://news.example.com/feed.xml', batchSize: 20 } })
      const arxiv = sourceDocument({ connectorType: 'arxiv', accessMethod: 'api', authorityTier: 'primary', sourceKey: 'arxiv:loopback', domain: 'arxiv.org', connectorConfig: { kind: 'arxiv', arxivQuery: 'cat:cs.AI', batchSize: 2 } })
      const hackerNews = sourceDocument({ connectorType: 'hacker-news', accessMethod: 'api', authorityTier: 'community-signal', sourceKey: 'hacker-news:topstories', domain: 'news.ycombinator.com', connectorConfig: { kind: 'hacker-news', hackerNewsStream: 'topstories', batchSize: 2 } })
      await context.db.collection('sources').insertMany([rss, arxiv, hackerNews])
      const sourceRepository = new MongoSourceRepository(context)
      const { service, articles } = buildService(context, createDefaultConnectorRegistry(), sourceRepository)
      const jobs = new MongoJobRepository(context)
      const leases = new MongoLeaseRepository(context)

      const runs = [
        { source: rss, payload: { body: await fixture('rss/valid-rss.xml'), contentType: 'application/rss+xml', url: 'https://news.example.com/feed.xml' } },
        { source: arxiv, payload: { body: await fixture('arxiv/page-1.xml'), contentType: 'application/atom+xml' } },
        { source: hackerNews, payload: { ids: [101, 104], items: { '101': { id: 101, type: 'story', by: 'alice', time: 1781006400, title: 'A safe HN story', url: 'https://linked.example.test/article', text: '<p>Official HN text.</p>', score: 42, descendants: 7 }, '104': { id: 104, type: 'story', by: 'bob', time: 1781006460, title: 'A story without a linked page', score: 5, descendants: 0 } } } },
      ]
      const results = []
      for (const [index, run] of runs.entries()) {
        const prepared = await prepareJob({ jobs, leases, source: run.source, suffix: `connector-${index}` })
        results.push(await service.execute({ ...prepared, payload: run.payload, retrievedAt: RETRIEVED_AT }))
      }

      expect(results.map(({ created }) => created)).toEqual([1, 2, 2])
      expect(results[2].articles.every(({ authorityTier, evidenceEligible }) => authorityTier === 'community-signal' && evidenceEligible === false)).toBe(true)
      expect(await articles.articles().countDocuments()).toBe(5)
      const persisted = await articles.articles().find({}, { projection: { raw: 1, body: 1, providerPayload: 1, fullText: 1, mediaBinary: 1, sourceId: 1, connectorType: 1 } }).toArray()
      expect(persisted).toHaveLength(5)
      expect(persisted.every((document) => !Object.keys(document).some((key) => ['raw', 'body', 'providerPayload', 'fullText', 'mediaBinary'].includes(key)))).toBe(true)
      expect(await articles.findQnaEvidence({ limit: 20 })).toHaveLength(3)
    })
  }, 60_000)

  it('replays the same connector batch without article, checkpoint or counter side effects', async () => {
    await withDatabase('replay', async ({ context }) => {
      const source = sourceDocument({ connectorType: 'rss', accessMethod: 'rss', authorityTier: 'editorial', sourceKey: 'rss:replay', domain: 'news.example.com', connectorConfig: { kind: 'rss', feedUrl: 'https://news.example.com/feed.xml', batchSize: 20 } })
      await context.db.collection('sources').insertOne(source)
      const sourceRepository = new MongoSourceRepository(context)
      const { service, articles } = buildService(context, createDefaultConnectorRegistry(), sourceRepository)
      const jobs = new MongoJobRepository(context)
      const leases = new MongoLeaseRepository(context)
      const prepared = await prepareJob({ jobs, leases, source, suffix: 'replay' })
      const payload = { body: await fixture('rss/valid-rss.xml'), contentType: 'application/rss+xml', url: 'https://news.example.com/feed.xml' }
      const first = await service.execute({ ...prepared, payload, retrievedAt: RETRIEVED_AT })
      const firstArticle = await articles.articles().findOne({})
      const second = await service.execute({ ...prepared, payload, retrievedAt: RETRIEVED_AT })
      const finalJob = await jobs.findIngestionJobById(prepared.job.id)
      expect(first).toMatchObject({ created: 1, fetched: 1, counters: { fetched: 1, created: 1 } })
      expect(second).toMatchObject({ created: 0, updated: 0, duplicate: 0, fetched: 0, counters: first.counters, checkpoint: first.checkpoint })
      expect((await articles.articles().find({}).toArray())).toHaveLength(1)
      expect((await articles.articles().findOne({}))._id).toEqual(firstArticle._id)
      expect(finalJob.counters).toEqual(first.counters)
      expect(finalJob.checkpoint).toEqual(first.checkpoint)
    })
  }, 60_000)

  it('unions provenance for the same canonical URL observed by two sources', async () => {
    await withDatabase('merge', async ({ context }) => {
      const sourceOne = sourceDocument({ connectorType: 'rss', accessMethod: 'rss', authorityTier: 'editorial', sourceKey: 'rss:one', domain: 'news.example.com', connectorConfig: { kind: 'rss', feedUrl: 'https://news.example.com/feed.xml', batchSize: 20 } })
      const sourceTwo = sourceDocument({ connectorType: 'rss', accessMethod: 'rss', authorityTier: 'editorial', sourceKey: 'rss:two', domain: 'mirror.example.com', connectorConfig: { kind: 'rss', feedUrl: 'https://mirror.example.com/feed.xml', batchSize: 20 } })
      await context.db.collection('sources').insertMany([sourceOne, sourceTwo])
      const sourceRepository = new MongoSourceRepository(context)
      const { service, articles } = buildService(context, createDefaultConnectorRegistry(), sourceRepository)
      const jobs = new MongoJobRepository(context)
      const leases = new MongoLeaseRepository(context)
      const payload = { body: await fixture('rss/valid-rss.xml'), contentType: 'application/rss+xml', url: 'https://news.example.com/feed.xml' }
      const firstJob = await prepareJob({ jobs, leases, source: sourceOne, suffix: 'merge-one' })
      const secondJob = await prepareJob({ jobs, leases, source: sourceTwo, suffix: 'merge-two' })
      await service.execute({ ...firstJob, payload, retrievedAt: RETRIEVED_AT })
      const merged = await service.execute({ ...secondJob, payload, retrievedAt: RETRIEVED_AT })
      const document = await articles.articles().findOne({})
      expect(merged).toMatchObject({ created: 0, updated: 1, duplicate: 1 })
      expect(await articles.articles().countDocuments()).toBe(1)
      expect(new Set(document.provenance.map(({ sourceId }) => sourceId.toHexString())).size).toBe(2)
    })
  }, 60_000)

  it('fails closed on stale lease and policy CAS before article/checkpoint/counter writes', async () => {
    await withDatabase('fence', async ({ context }) => {
      const source = sourceDocument({ connectorType: 'rss', accessMethod: 'rss', authorityTier: 'editorial', sourceKey: 'rss:fence', domain: 'news.example.com', connectorConfig: { kind: 'rss', feedUrl: 'https://news.example.com/feed.xml', batchSize: 20 } })
      await context.db.collection('sources').insertOne(source)
      const sourceRepository = new MongoSourceRepository(context)
      const { service, articles } = buildService(context, createDefaultConnectorRegistry(), sourceRepository)
      const jobs = new MongoJobRepository(context)
      const leases = new MongoLeaseRepository(context)
      const payload = { body: await fixture('rss/valid-rss.xml'), contentType: 'application/rss+xml', url: 'https://news.example.com/feed.xml' }

      const stale = await prepareJob({ jobs, leases, source, suffix: 'stale' })
      expect(await leases.release({ key: stale.fence.key, jobId: stale.job.id, leaseGeneration: stale.fence.leaseGeneration, ownerTokenHash: stale.fence.ownerTokenHash })).toBe(true)
      await expect(service.execute({ ...stale, payload, retrievedAt: RETRIEVED_AT })).rejects.toMatchObject({ code: 'lease_fence_stale' })
      expect(await articles.articles().countDocuments()).toBe(0)
      expect(await jobs.findIngestionJobById(stale.job.id)).toMatchObject({ counters: { fetched: 0, created: 0 }, checkpoint: undefined })

      const policySource = sourceDocument({ connectorType: 'rss', accessMethod: 'rss', authorityTier: 'editorial', sourceKey: 'rss:policy', domain: 'policy.example.com', connectorConfig: { kind: 'rss', feedUrl: 'https://policy.example.com/feed.xml', batchSize: 20 } })
      await context.db.collection('sources').insertOne(policySource)
      let sourceReads = 0
      const policyRepository = { findSourceById: async (id) => {
        sourceReads += 1
        const current = await sourceRepository.findSourceById(id)
        if (sourceReads === 2) await context.db.collection('sources').updateOne({ _id: policySource._id }, { $set: { policyVersion: 2, updatedAt: new Date(RETRIEVED_AT.getTime() + 1), reconciliation: { ...policySource.reconciliation, requiredPolicyVersion: 2 } } })
        return current
      } }
      const policyService = createIngestionService({ connectorRegistry: createDefaultConnectorRegistry(), sourceRepository: policyRepository, articleRepository: articles, currentSourcePolicy: { content: async () => ({ allowed: true, policyVersion: 1 }) }, now: () => RETRIEVED_AT })
      const policyJob = await prepareJob({ jobs, leases, source: policySource, suffix: 'policy' })
      await expect(policyService.execute({ ...policyJob, payload, retrievedAt: RETRIEVED_AT })).rejects.toMatchObject({ code: 'policy_version_mismatch' })
      expect(await articles.articles().countDocuments()).toBe(0)
      expect(await jobs.findIngestionJobById(policyJob.job.id)).toMatchObject({ counters: { fetched: 0, created: 0 }, checkpoint: undefined })
    })
  }, 60_000)

  it('redacts media after source policy change and excludes HN community signal from Q&A evidence', async () => {
    await withDatabase('visibility', async ({ context }) => {
      const source = sourceDocument({ connectorType: 'rss', accessMethod: 'rss', authorityTier: 'editorial', sourceKey: 'rss:media', domain: 'news.example.com', connectorConfig: { kind: 'rss', feedUrl: 'https://news.example.com/feed.xml', batchSize: 20 }, mediaPolicy: { imageMode: 'remote-preview', videoMode: 'none', allowedHosts: ['cdn.example.test'], attributionRequired: false, evidenceNote: null } })
      const hn = sourceDocument({ connectorType: 'hacker-news', accessMethod: 'api', authorityTier: 'community-signal', sourceKey: 'hacker-news:visibility', domain: 'news.ycombinator.com', connectorConfig: { kind: 'hacker-news', hackerNewsStream: 'topstories', batchSize: 1 } })
      await context.db.collection('sources').insertMany([source, hn])
      const sourceRepository = new MongoSourceRepository(context)
      const { service, articles } = buildService(context, createDefaultConnectorRegistry(), sourceRepository)
      const jobs = new MongoJobRepository(context)
      const leases = new MongoLeaseRepository(context)
      const rssJob = await prepareJob({ jobs, leases, source, suffix: 'media' })
      await service.execute({ ...rssJob, payload: { body: await fixture('rss/valid-rss.xml'), contentType: 'application/rss+xml', url: 'https://news.example.com/feed.xml' }, retrievedAt: RETRIEVED_AT })
      const before = await articles.findVisibleArticles({ limit: 10 })
      expect(before[0]).toMatchObject({ leadMediaStatus: 'available', leadMedia: expect.objectContaining({ sourcePolicyVersion: 1 }) })
      await context.db.collection('sources').updateOne({ _id: source._id }, { $set: { policyVersion: 2, updatedAt: new Date(RETRIEVED_AT.getTime() + 1), 'reconciliation.requiredPolicyVersion': 2, 'mediaPolicy.imageMode': 'none', 'mediaPolicy.allowedHosts': [] } })
      const after = await articles.findVisibleArticles({ limit: 10 })
      expect(after[0]).toMatchObject({ leadMedia: null, leadMediaStatus: 'hidden' })

      const hnJob = await prepareJob({ jobs, leases, source: hn, suffix: 'visibility-hn' })
      await service.execute({ ...hnJob, payload: { ids: [101], items: { '101': { id: 101, type: 'story', by: 'alice', time: 1781006400, title: 'A safe HN story', url: 'https://linked.example.test/article', text: '<p>Official HN text.</p>' } } }, retrievedAt: RETRIEVED_AT })
      const evidence = await articles.findQnaEvidence({ limit: 20 })
      expect(evidence.every(({ connectorType }) => connectorType !== 'hacker-news')).toBe(true)
    })
  }, 60_000)
})
