import { describe, expect, it } from 'vitest'
import { ObjectId } from 'mongodb'
import { createStep11Mongo } from '../../helpers/step11-mongo.js'
import { MongoIndexingJobRepository, buildReconciliationJobs, indexingJobDocument } from '../../../server/repositories/mongo/indexing-job-repository.js'

const sourceId = new ObjectId('507f1f77bcf86cd799439011')
const articleIds = [
  new ObjectId('507f1f77bcf86cd799439021'),
  new ObjectId('507f1f77bcf86cd799439022'),
  new ObjectId('507f1f77bcf86cd799439023'),
]
const now = new Date('2026-08-29T01:00:00.000Z')

function source() {
  return {
    _id: sourceId,
    sourceKey: 'demo:hn-topstories',
    operationalStatus: 'paused',
    licenseStatus: 'review-needed',
    llmInputScope: 'none',
    storageScope: { metadata: true, excerpt: false, summary: false, embedding: false },
    mediaPolicy: { imageMode: 'none', videoMode: 'none', allowedHosts: [], attributionRequired: false },
    policyVersion: 8,
    reconciliation: { status: 'pending', requiredPolicyVersion: 8, completedPolicyVersion: null, requestedAt: now, error: null },
    technicalCheck: { status: 'passed' },
  }
}

function makeRepository(existingJobs = []) {
  const mongo = createStep11Mongo({
    app: {
      sources: [source()],
      articles: articleIds.map((_id) => ({ _id, sourceId, status: 'published', rightsSnapshot: { sourcePolicyVersion: 2 } })),
      indexingJobs: existingJobs,
    },
  })
  return { mongo, repository: new MongoIndexingJobRepository({ db: mongo.db, client: mongo.client, now: () => now }) }
}
describe('Mongo reconciliation preview', () => {
  it('uses the bounded article predicate and performs no writes or payload reads', async () => {
    const { mongo, repository } = makeRepository()
    const beforeSource = await mongo.db.collection('sources').findOne({ _id: sourceId })
    const beforeJobs = await mongo.db.collection('indexingJobs').countDocuments({})

    const result = await repository.previewReconciliationPage({ sourceId: sourceId.toHexString(), limit: 2, now })

    expect(result).toEqual(expect.objectContaining({
      outcome: 'completed',
      sourceId: sourceId.toHexString(),
      policyVersion: 8,
      requiredPolicyVersion: 8,
      inspected: 2,
            staleArticleCount: 2,
      wouldCreate: 2,
      hasMore: true,
    }))
    expect(result.wouldCreateJobs).toHaveLength(2)
    expect(result.wouldCreateJobs.every((job) => job.task === 'visibility-reconcile' && job.expectedSourcePolicyVersion === 8 && job.trigger === 'policy-change' && job.priority === 75)).toBe(true)
    expect(result.wouldCreateJobs.every((job) => job.actorScope === 'system-policy-reconciliation' && job.idempotencyKey.endsWith(':visibility-reconcile:8'))).toBe(true)
    expect(await mongo.db.collection('sources').findOne({ _id: sourceId })).toEqual(beforeSource)
    expect(await mongo.db.collection('indexingJobs').countDocuments({}))
      .toBe(beforeJobs)
    expect(JSON.stringify(result)).not.toMatch(/rightsSnapshot|fullText|rawHtml|providerPayload|secret|api[_-]?key/i)
    expect(mongo.db.hints).toContainEqual({ collection: 'articles', hint: 'articles_source_reconciliation' })
  })

  it('reports zero new jobs on replay without mutating the marker', async () => {
    const canonicalSource = {
      ...source(),
      id: sourceId.toHexString(),
    }
    const job = buildReconciliationJobs({ source: canonicalSource, articleId: articleIds[0].toHexString(), now })[0]
    const { mongo, repository } = makeRepository([indexingJobDocument(job)])
    const beforeSource = await mongo.db.collection('sources').findOne({ _id: sourceId })

    const result = await repository.previewReconciliationPage({ sourceId, limit: 1, now })

    expect(result.wouldCreate).toBe(0)
    expect(result.wouldCreateJobs).toEqual([])
    expect(await mongo.db.collection('sources').findOne({ _id: sourceId })).toEqual(beforeSource)
  })
})
