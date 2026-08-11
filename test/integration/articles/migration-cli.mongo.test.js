import { MongoClient, ObjectId } from 'mongodb'
import { spawnSync } from 'node:child_process'
import { describe, expect, it } from 'vitest'
import { createMongoContext } from '../../../server/repositories/mongo/connection.js'
import { databaseNameForSuite, dropTestDatabase } from '../../../scripts/atlas-test-safety.js'
import { ARTICLE_COLLECTIONS, ARTICLE_INDEXES } from '../../../scripts/migrations/articles.js'
import { DURABLE_JOB_AUDIT_VALIDATOR } from '../../../scripts/migrations/durable-jobs.js'

const hasMongo = Boolean(process.env.MONGODB_TEST_URI)
const describeMongo = hasMongo ? describe : describe.skip

function runMigration(target, database) {
  return spawnSync(process.execPath, ['scripts/db-migrate.js', '--to', target], {
    cwd: process.cwd(), encoding: 'utf8',
    env: { ...process.env, MONGODB_URI_ENV: 'STEP7_MIGRATION_URI', STEP7_MIGRATION_URI: process.env.MONGODB_TEST_URI, MONGODB_DATABASE: database },
  })
}

function runVerify(target, database) {
  return spawnSync(process.execPath, ['scripts/db-verify.js', target], {
    cwd: process.cwd(), encoding: 'utf8',
    env: { ...process.env, MONGODB_URI_ENV: 'STEP7_VERIFY_URI', STEP7_VERIFY_URI: process.env.MONGODB_TEST_URI, MONGODB_DATABASE: database },
  })
}

function stages(explain) {
  const result = []
  const visit = (value) => {
    if (!value || typeof value !== 'object') return
    if (value.stage) result.push(value.stage)
    for (const nested of Object.values(value)) visit(nested)
  }
  visit(explain.queryPlanner?.winningPlan)
  return result
}

describeMongo('Step 7 production migration/verifier CLI', () => {
  it('applies articles after durable-jobs, reruns idempotently and verifies exact schema/index/query plans', async () => {
    const client = new MongoClient(process.env.MONGODB_TEST_URI)
    await client.connect()
    const database = databaseNameForSuite('artcli')
    const context = createMongoContext({ client, database })
    try {
      for (const target of ['auth-core', 'sources', 'durable-jobs', 'articles', 'articles']) {
        const result = runMigration(target, database)
        expect(result.status, `${target}: ${result.stderr}`).toBe(0)
      }

      const verified = runVerify('articles', database)
      expect(verified.status, verified.stderr).toBe(0)
      expect(JSON.parse(verified.stdout)).toMatchObject({ verified: true, collections: 1, roleStatus: 'not-requested' })

      const collection = (await context.db.listCollections({ name: 'articles' }, { nameOnly: false }).toArray())[0]
      expect(collection.options.validator).toEqual(ARTICLE_COLLECTIONS.articles.validator)
      const actualIndexes = await context.db.collection('articles').indexes()
      for (const expected of ARTICLE_INDEXES.articles) {
        const actual = actualIndexes.find(({ name }) => name === expected.name)
        expect(actual).toBeTruthy()
        if (expected.name === 'articles_search_text') {
          expect(actual.key).toEqual({ _fts: 'text', _ftsx: 1 })
          expect(actual.weights).toEqual(Object.fromEntries(Object.keys(expected.key).sort().map((field) => [field, 1])))
          expect(actual.default_language).toBe(expected.options.default_language)
        } else expect(actual.key).toEqual(expected.key)
      }

      const now = new Date('2026-08-11T00:00:00.000Z')
      const sourceId = new ObjectId()
      const articles = context.db.collection('articles')
      const article = {
        _id: new ObjectId(), sourceId, connectorType: 'rss', sourceType: 'rss:example', authorityTier: 'editorial', evidenceEligible: true, status: 'published', titleOriginal: 'AI', titleVi: null,
        originalUrl: 'https://example.com/article', canonicalUrl: 'https://example.com/article', canonicalUrlHash: 'a'.repeat(64), publishedAt: now, retrievedAt: now, sourceLanguage: 'en', topics: ['ai'], searchTextNormalized: 'ai',
        leadMedia: null, leadMediaStatus: 'none', summaryVi: null, summaryStatus: 'pending', summaryBasis: null, summaryModel: null, summaryInputHash: null, summarySourcePolicyVersion: null, summaryGeneratedAt: null, summaryError: null,
        contentScope: 'metadata', rightsSnapshot: { sourcePolicyVersion: 1, licenseStatus: 'metadata-only', llmInputScope: 'metadata', capturedAt: now }, embeddingStatus: 'pending', embedding: null, embeddingModel: null, embeddingDimensions: null, embeddingInputHash: null, embeddingVersion: null, embeddingSourcePolicyVersion: null, embeddedAt: null, embeddingError: null,
        provenance: [{ sourceId, originalUrl: 'https://example.com/article', observedAt: now }], dedupeKey: 'url:test', createdAt: now, updatedAt: now,
      }
      await articles.insertOne(article)
      const plans = [
        articles.find({ status: 'published' }).sort({ publishedAt: -1, _id: -1 }).hint('articles_status_published').explain('queryPlanner'),
        articles.find({ status: 'published', topics: 'ai' }).sort({ publishedAt: -1 }).hint('articles_status_topic_time').explain('queryPlanner'),
        articles.find({ status: 'published', sourceId }).sort({ publishedAt: -1 }).hint('articles_status_source_time').explain('queryPlanner'),
        articles.find({ embeddingStatus: 'pending' }).hint('articles_embedding_status').explain('queryPlanner'),
        articles.find({ $text: { $search: 'ai' } }).explain('queryPlanner'),
      ]
      for (const plan of await Promise.all(plans)) expect(stages(plan)).not.toEqual(expect.arrayContaining(['COLLSCAN', 'SORT']))
    } finally {
      await dropTestDatabase({ context, expectedDatabase: database })
      await client.close()
    }
  }, 60_000)

  it('keeps the durable-jobs predecessor validator exact before article migration', async () => {
    const client = new MongoClient(process.env.MONGODB_TEST_URI)
    await client.connect()
    const database = databaseNameForSuite('artord')
    const context = createMongoContext({ client, database })
    try {
      const result = runMigration('articles', database)
      expect(result.status).not.toBe(0)
      expect(result.stderr).toMatch(/migration failed/i)
      expect(await context.db.listCollections({ name: 'articles' }).hasNext()).toBe(false)
      expect((await context.db.listCollections({ name: 'adminAuditLogs' }, { nameOnly: false }).toArray())).toHaveLength(0)
      expect(DURABLE_JOB_AUDIT_VALIDATOR).toBeTruthy()
    } finally {
      await dropTestDatabase({ context, expectedDatabase: database })
      await client.close()
    }
  }, 30_000)
})
