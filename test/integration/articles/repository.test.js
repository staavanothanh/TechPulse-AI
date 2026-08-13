import { ObjectId } from 'mongodb'
import { describe, expect, it, vi } from 'vitest'
import { assertArticleMatchesCurrent, MongoArticleRepository } from '../../../server/repositories/mongo/article-repository.js'
import { makeCandidate, makeJob, makeSource, RETRIEVED_AT } from '../../unit/articles/fixtures.js'
import { normalizeCandidateToArticle } from '../../../server/domain/article/normalization.js'
import { SOURCE_ID } from '../../unit/articles/fixtures.js'

function fakeCommitRepository({ leaseMatched = 1, currentSource = makeSource() } = {}) {
  const source = { ...currentSource, _id: new ObjectId(String(currentSource.id ?? SOURCE_ID)) }
  const currentJob = { _id: new ObjectId('507f1f77bcf86cd799439013'), status: 'running', leaseGeneration: 1, counters: { fetched: 0, created: 0, updated: 0, duplicate: 0, skipped: 0, failed: 0 } }
  const articles = {
    findOne: vi.fn(async () => null),
    find: vi.fn(() => ({ sort() { return this }, limit() { return this }, async toArray() { return [] } })),
    insertOne: vi.fn(async () => ({ acknowledged: true })),
    updateOne: vi.fn(async () => ({ matchedCount: 1 })),
  }
  const leases = { updateOne: vi.fn(async () => ({ matchedCount: leaseMatched })) }
  const jobs = {
    findOne: vi.fn(async () => currentJob),
    updateOne: vi.fn(async (_filter, update) => { Object.assign(currentJob, update.$set); return { matchedCount: 1 } }),
  }
  const indexingJobs = { updateOne: vi.fn(async () => ({ matchedCount: 0, upsertedCount: 1 })) }
  const sources = { findOne: vi.fn(async () => source) }
  const repository = new MongoArticleRepository({ db: {}, client: {} })
  repository.withTransaction = vi.fn(async (work) => work({}))
  repository.articles = () => articles
  repository.leases = () => leases
  repository.jobs = () => jobs
  repository.indexingJobs = () => indexingJobs
  repository.sources = () => sources
  return { repository, source, currentJob, articles, leases, jobs, indexingJobs, sources }
}

describe('article repository fence contract', () => {
  it('exposes the article commit boundary without using a provider body or media binary', () => {
    const repository = new MongoArticleRepository({ db: {}, client: {} })
    expect(repository).toMatchObject({ commitIngestionBatch: expect.any(Function), upsertCandidate: expect.any(Function), findVisibleArticles: expect.any(Function) })
  })

  it('rejects an invalid fence before any database operation', async () => {
    const db = { collection: vi.fn(() => { throw new Error('database must not be touched') }) }
    const repository = new MongoArticleRepository({ db, client: {} })
    await expect(repository.commitIngestionBatch({ job: makeJob(), fence: {}, source: makeSource(), candidates: [makeCandidate()], checkpoint: { processedCount: 1 }, counters: { fetched: 1, created: 1, updated: 0, duplicate: 0, skipped: 0, failed: 0 } })).rejects.toMatchObject({ code: 'lease_fence_stale' })
    expect(db.collection).not.toHaveBeenCalled()
  })

  it('rejects a source/job identity mismatch before opening a transaction', async () => {
    const db = { collection: vi.fn(() => { throw new Error('database must not be touched') }) }
    const repository = new MongoArticleRepository({ db, client: {} })
    await expect(repository.commitIngestionBatch({
      job: makeJob({ sourceId: '507f1f77bcf86cd799439012' }),
      fence: { key: 'ingestion:source:507f1f77bcf86cd799439012', ownerTokenHash: 'a'.repeat(64), leaseGeneration: 1 },
      source: makeSource(), expectedSourcePolicyVersion: 3, expectedConnectorConfig: makeSource().connectorConfig,
    })).rejects.toMatchObject({ code: 'policy_version_mismatch' })
    expect(db.collection).not.toHaveBeenCalled()
  })

  it('rejects a lease key that is not derived from the exact job source', async () => {
    const db = { collection: vi.fn(() => { throw new Error('database must not be touched') }) }
    const repository = new MongoArticleRepository({ db, client: {} })
    await expect(repository.commitIngestionBatch({
      job: makeJob(),
      fence: { key: 'ingestion:source:507f1f77bcf86cd799439012', ownerTokenHash: 'a'.repeat(64), leaseGeneration: 1 },
      source: makeSource(), expectedSourcePolicyVersion: 3, expectedConnectorConfig: makeSource().connectorConfig,
    })).rejects.toMatchObject({ code: 'lease_fence_stale' })
    expect(db.collection).not.toHaveBeenCalled()
  })

  it('commits a batch once and replays the same checkpoint without duplicate article/counter writes', async () => {
    const { repository, source, articles, jobs, indexingJobs } = fakeCommitRepository()
    const job = makeJob()
    const fence = { key: `ingestion:source:${SOURCE_ID}`, ownerTokenHash: 'a'.repeat(64), leaseGeneration: 1 }
    const article = normalizeCandidateToArticle(makeCandidate(), { source, now: RETRIEVED_AT })
    const input = { job, fence, source, expectedSourcePolicyVersion: 3, expectedConnectorConfig: source.connectorConfig, candidates: [makeCandidate()], articles: [article], checkpoint: { processedCount: 1, lastExternalId: 'item-1' }, counters: { fetched: 1 }, retrievedAt: RETRIEVED_AT }

    const first = await repository.commitIngestionBatch(input)
    const second = await repository.commitIngestionBatch(input)

    expect(first).toMatchObject({ created: 1, fetched: 1, counters: { fetched: 1, created: 1 } })
    expect(second).toMatchObject({ created: 0, updated: 0, fetched: 0, counters: first.counters })
    expect(articles.insertOne).toHaveBeenCalledTimes(1)
    expect(jobs.updateOne).toHaveBeenCalledTimes(1)
    expect(indexingJobs.updateOne).toHaveBeenCalledTimes(2)
    expect(indexingJobs.updateOne.mock.calls.map(([, update]) => update.$setOnInsert.task)).toEqual(['summary', 'embedding'])
  })

  it('fails closed at the lease CAS before source/article writes', async () => {
    const { repository, source, leases, sources, articles } = fakeCommitRepository({ leaseMatched: 0 })
    const job = makeJob()
    await expect(repository.commitIngestionBatch({
      job,
      fence: { key: `ingestion:source:${SOURCE_ID}`, ownerTokenHash: 'a'.repeat(64), leaseGeneration: 1 },
      source,
      expectedSourcePolicyVersion: 3,
      expectedConnectorConfig: source.connectorConfig,
      candidates: [makeCandidate()],
      checkpoint: { processedCount: 1, lastExternalId: 'item-1' },
    })).rejects.toMatchObject({ code: 'lease_fence_stale' })
    expect(leases.updateOne).toHaveBeenCalledTimes(1)
    expect(sources.findOne).not.toHaveBeenCalled()
    expect(articles.insertOne).not.toHaveBeenCalled()
  })

  it('fails closed when a worker presents an equal-progress but different checkpoint marker', async () => {
    const { repository, source, currentJob, articles } = fakeCommitRepository()
    currentJob.checkpoint = { processedCount: 1, lastExternalId: 'other-item' }
    await expect(repository.commitIngestionBatch({
      job: makeJob(),
      fence: { key: `ingestion:source:${SOURCE_ID}`, ownerTokenHash: 'a'.repeat(64), leaseGeneration: 1 },
      source,
      expectedSourcePolicyVersion: 3,
      expectedConnectorConfig: source.connectorConfig,
      candidates: [makeCandidate()],
      checkpoint: { processedCount: 1, lastExternalId: 'item-1' },
    })).rejects.toMatchObject({ code: 'lease_fence_stale' })
    expect(articles.insertOne).not.toHaveBeenCalled()
  })

  it('retries one unique-key race so concurrent logical upserts converge', async () => {
    const { repository, source, articles } = fakeCommitRepository()
    const job = makeJob()
    const article = normalizeCandidateToArticle(makeCandidate(), { source, now: RETRIEVED_AT })
    const input = { job, fence: { key: `ingestion:source:${SOURCE_ID}`, ownerTokenHash: 'a'.repeat(64), leaseGeneration: 1 }, source, expectedSourcePolicyVersion: 3, expectedConnectorConfig: source.connectorConfig, candidates: [makeCandidate()], articles: [article], checkpoint: { processedCount: 1, lastExternalId: 'item-1' }, retrievedAt: RETRIEVED_AT }
    const run = repository.withTransaction
    repository.withTransaction = vi.fn().mockRejectedValueOnce(Object.assign(new Error('unique race'), { code: 11000 })).mockImplementation((work) => run.call(repository, work))

    const result = await repository.commitIngestionBatch(input)
    expect(result.created).toBe(1)
    expect(repository.withTransaction).toHaveBeenCalledTimes(2)
    expect(articles.insertOne).toHaveBeenCalledTimes(1)
  })

  it('filters current source state and redacts stale media metadata at visible read time', async () => {
    const repository = new MongoArticleRepository({ db: {}, client: {} })
    const source = { ...makeSource({ policyVersion: 4 }), _id: new ObjectId(SOURCE_ID) }
    const article = normalizeCandidateToArticle(makeCandidate(), { source: makeSource(), now: RETRIEVED_AT })
    const document = { ...article, _id: new ObjectId(), sourceId: new ObjectId(SOURCE_ID), provenance: article.provenance.map((entry) => ({ ...entry, sourceId: new ObjectId(entry.sourceId) })), _currentSource: source }
    const aggregate = vi.fn(() => ({ toArray: vi.fn(async () => [document]) }))
    repository.articles = () => ({ aggregate })

    const visible = await repository.findVisibleArticles({ limit: 1 })
    expect(visible).toHaveLength(1)
    expect(visible[0]).toMatchObject({ status: 'published', leadMedia: null, leadMediaStatus: 'hidden' })
    expect(aggregate.mock.calls[0][0]).toEqual(expect.arrayContaining([expect.objectContaining({ $lookup: expect.any(Object) }), expect.objectContaining({ $match: expect.objectContaining({ '_currentSource.operationalStatus': 'active' }) })]))
  })

  it('keeps HN community-signal out of Q&A evidence even if a document is published', async () => {
    const repository = new MongoArticleRepository({ db: {}, client: {} })
    const source = { ...makeSource({ id: '507f1f77bcf86cd799439012', sourceKey: 'hn:topstories', connectorType: 'hacker-news', accessMethod: 'api', authorityTier: 'community-signal', connectorConfig: { kind: 'hacker-news', hackerNewsStream: 'topstories', batchSize: 20 } }), _id: new ObjectId('507f1f77bcf86cd799439012') }
    const article = normalizeCandidateToArticle(makeCandidate({ sourceId: source.id, connectorType: source.connectorType, authorityTier: source.authorityTier, originalUrl: 'https://news.ycombinator.com/item?id=42', externalId: '42', provenance: { sourceId: source.id, originalUrl: 'https://news.ycombinator.com/item?id=42', externalId: '42', observedAt: RETRIEVED_AT } }), { source, now: RETRIEVED_AT })
    const document = { ...article, _id: new ObjectId(), sourceId: source._id, provenance: article.provenance.map((entry) => ({ ...entry, sourceId: source._id })), _currentSource: source }
    repository.articles = () => ({ aggregate: vi.fn(() => ({ toArray: vi.fn(async () => [document]) })) })

    expect(await repository.findQnaEvidence({ limit: 1 })).toEqual([])
  })

  it('pushes the requested article, topic and time scope into the Q&A evidence query', async () => {
    const repository = new MongoArticleRepository({ db: {}, client: {} })
    const source = { ...makeSource(), _id: new ObjectId(SOURCE_ID) }
    const article = normalizeCandidateToArticle(makeCandidate(), { source, now: RETRIEVED_AT })
    const document = { ...article, _id: new ObjectId('507f1f77bcf86cd799439099'), sourceId: source._id, provenance: article.provenance.map((entry) => ({ ...entry, sourceId: source._id })), _currentSource: source }
    const aggregate = vi.fn(() => ({ toArray: vi.fn(async () => [document]) }))
    repository.articles = () => ({ aggregate })

    await repository.findQnaEvidence({
      limit: 20,
      scope: { articleId: document._id.toHexString(), topics: ['ai'], publishedAfter: new Date('2026-08-01T00:00:00.000Z'), publishedBefore: new Date('2026-08-11T00:00:00.000Z') },
      includeSource: true,
    })

    expect(aggregate.mock.calls[0][0]).toEqual(expect.arrayContaining([
      expect.objectContaining({ $match: expect.objectContaining({ _id: document._id, topics: { $in: ['ai'] }, publishedAt: { $gte: new Date('2026-08-01T00:00:00.000Z'), $lte: new Date('2026-08-11T00:00:00.000Z') } }) }),
    ]))
  })

  it('reranks before truncation so an older relevant article survives fifty newer unrelated rows', async () => {
    const repository = new MongoArticleRepository({ db: {}, client: {} })
    const source = { ...makeSource(), _id: new ObjectId(SOURCE_ID) }
    const relevant = normalizeCandidateToArticle(makeCandidate({ titleOriginal: 'Kubernetes autoscaling', excerptOriginal: 'Horizontal pod autoscaling dùng metrics CPU.' }), { source, now: RETRIEVED_AT })
    const unrelated = Array.from({ length: 55 }, (_, index) => normalizeCandidateToArticle(makeCandidate({ titleOriginal: `Tin unrelated ${index}`, excerptOriginal: 'Tin công nghệ khác.' }), { source, now: new Date(RETRIEVED_AT.getTime() + index * 60_000) }))
    const documents = [...unrelated, relevant].map((article, index) => ({ ...article, _id: new ObjectId(`507f1f77bcf86cd79943${index.toString(16).padStart(4, '0')}`), sourceId: source._id, provenance: article.provenance.map((entry) => ({ ...entry, sourceId: source._id })), _currentSource: source }))
    repository.articles = () => ({ aggregate: vi.fn(() => ({ toArray: vi.fn(async () => documents) })) })

    const result = await repository.findQnaEvidence({ question: 'Kubernetes autoscaling dùng metrics CPU thế nào?', limit: 1, includeSource: true })

    expect(result).toHaveLength(1)
    expect(result[0].article.titleOriginal).toBe('Kubernetes autoscaling')
  })

  it('does not retain candidate body/media binary in the commit input contract', () => {
    const repository = new MongoArticleRepository({ db: {}, client: {} })
    const candidate = { ...makeCandidate(), body: 'full body', rawHtml: '<html>raw</html>', mediaBinary: Buffer.from('binary'), mediaCandidate: { ...makeCandidate().mediaCandidate, binary: 'nested binary' }, sourceMetadata: { comment: 'safe', body: 'nested full text' } }
    expect(repository.sanitizeCommitInput({ source: makeSource(), candidates: [candidate], retrievedAt: RETRIEVED_AT })).not.toMatchObject({ candidates: [expect.objectContaining({ body: expect.anything() })] })
    const safe = repository.sanitizeCommitInput({ source: makeSource(), candidates: [candidate], retrievedAt: RETRIEVED_AT })
    expect(JSON.stringify(safe)).not.toMatch(/full body|raw|binary|nested full text/i)
    expect(safe.candidates[0].mediaCandidate).not.toHaveProperty('binary')
  })

  it('rejects an article whose rights snapshot no longer matches the current source', () => {
    const article = normalizeCandidateToArticle(makeCandidate(), { source: makeSource(), now: RETRIEVED_AT })
    expect(() => assertArticleMatchesCurrent(article, { ...makeSource(), policyVersion: 4 })).toThrowError(expect.objectContaining({ code: 'policy_version_mismatch' }))
  })
})
