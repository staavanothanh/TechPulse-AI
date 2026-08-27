import { ObjectId } from 'mongodb'
import { describe, expect, it, vi } from 'vitest'
import { buildPolicyDerivedInput } from '../../../server/ai/policy-input.js'
import { normalizeCandidateToArticle } from '../../../server/domain/article/normalization.js'
import {
  makeCandidate,
  makeJob,
  makeSource,
  RETRIEVED_AT,
  SOURCE_ID,
} from '../../unit/articles/fixtures.js'
import {
  articleDocument,
  assertArticleMatchesCurrent,
  commitFence,
  MongoArticleRepository,
  safeCandidate,
  serializeArticle,
} from '../../../server/repositories/mongo/article-repository.js'

const ARTICLE_ID = new ObjectId('507f1f77bcf86cd799439301')
const DUPLICATE_ID = new ObjectId('507f1f77bcf86cd799439302')
const SOURCE_OBJECT_ID = new ObjectId(SOURCE_ID)

function sourceFixture(overrides = {}) {
  return { ...makeSource(), _id: SOURCE_OBJECT_ID, ...overrides }
}

function articleFixture(overrides = {}, source = sourceFixture()) {
  const normalized = normalizeCandidateToArticle(
    makeCandidate({ ...overrides, sourceId: SOURCE_ID }),
    { source, now: RETRIEVED_AT },
  )
  return articleDocument(normalized, ARTICLE_ID)
}

function fluent(rows = []) {
  const cursor = {
    sort: vi.fn(() => cursor),
    limit: vi.fn(() => cursor),
    hint: vi.fn(() => cursor),
    project: vi.fn(() => cursor),
    toArray: vi.fn(async () => rows),
  }
  return cursor
}

function repositoryFixture(overrides = {}) {
  const source = sourceFixture()
  const article = articleFixture({}, source)
  const collections = {
    articles: {
      findOne: vi.fn(async () => article),
      find: vi.fn(() => fluent([])),
      aggregate: vi.fn(() => fluent([])),
      insertOne: vi.fn(async () => ({ acknowledged: true })),
      updateOne: vi.fn(async () => ({ matchedCount: 1 })),
      replaceOne: vi.fn(async () => ({ matchedCount: 1 })),
    },
    sources: {
      findOne: vi.fn(async () => source),
      updateOne: vi.fn(async () => ({ matchedCount: 1 })),
    },
    savedArticles: {
      find: vi.fn(() => fluent([])),
      updateOne: vi.fn(async () => ({ matchedCount: 1 })),
      deleteOne: vi.fn(async () => ({ deletedCount: 1 })),
      deleteMany: vi.fn(async () => ({ deletedCount: 1 })),
    },
    users: { updateOne: vi.fn(async () => ({ matchedCount: 1 })) },
    sessions: { updateOne: vi.fn(async () => ({ matchedCount: 1 })) },
    leases: { updateOne: vi.fn(async () => ({ matchedCount: 1 })) },
    indexingJobs: {
      findOne: vi.fn(async () => ({ _id: new ObjectId('507f1f77bcf86cd799439303') })),
      updateOne: vi.fn(async () => ({ matchedCount: 1 })),
    },
    jobLeases: { updateOne: vi.fn(async () => ({ matchedCount: 1 })) },
    jobs: { findOne: vi.fn(async () => null), updateOne: vi.fn(async () => ({ matchedCount: 1 })) },
  }
  collections.ingestionJobs = collections.jobs
  const db = { collection: vi.fn((name) => collections[name]) }
  const transactionSession = {
    withTransaction: vi.fn(async (work) => work()),
    endSession: vi.fn(async () => undefined),
  }
  const client = { startSession: vi.fn(() => transactionSession) }
  const repository = new MongoArticleRepository({ db, client, now: () => RETRIEVED_AT }, overrides)
  return { article, source, collections, db, client, transactionSession, repository }
}

function publicDocument(article, source) {
  return { ...article, _currentSource: source }
}

describe('article repository coverage contracts', () => {
  it('serializes valid and removed article documents without forbidden payload fields', () => {
    const article = articleFixture()
    const withForbidden = {
      ...article,
      id: 'legacy-id',
      duplicateOfId: DUPLICATE_ID.toHexString(),
      body: 'secret body',
      rawHtml: '<raw>',
      providerPayload: { secret: true },
    }
    const document = articleDocument(withForbidden, ARTICLE_ID)
    const serialized = serializeArticle(document)
    expect(serialized).toMatchObject({
      id: ARTICLE_ID.toHexString(),
      sourceId: SOURCE_ID,
      duplicateOfId: DUPLICATE_ID.toHexString(),
    })
    expect(serialized).not.toHaveProperty('body')
    expect(serialized).not.toHaveProperty('rawHtml')
    expect(serializeArticle(null)).toBeNull()

    const tombstone = articleDocument(
      { ...article, status: 'removed', removedAt: RETRIEVED_AT, removalPolicyVersion: 3 },
      ARTICLE_ID,
    )
    expect(tombstone).toMatchObject({
      _id: ARTICLE_ID,
      status: 'removed',
      evidenceEligible: false,
      removalPolicyVersion: 3,
    })
    expect(serializeArticle(tombstone)).toMatchObject({
      id: ARTICLE_ID.toHexString(),
      status: 'removed',
      evidenceEligible: false,
    })
    expect(() => articleDocument({ ...article, sourceId: 'not-an-object-id' })).toThrow()
  })

  it('sanitizes candidate metadata and enforces lease and source fences', () => {
    const candidate = safeCandidate({
      connectorType: 'rss',
      sourceId: SOURCE_ID,
      titleOriginal: 'Title',
      body: 'blocked',
      licenseMetadata: {
        status: 'permitted',
        url: 'https://example.test/license',
        text: 'ok',
        ignored: 'x',
      },
      sourceMetadata: { doi: '10.1/example', journalRef: 'Journal', comment: 'note', ignored: 'x' },
      mediaCandidate: {
        type: 'image',
        url: 'https://cdn.example.test/x',
        alt: 'alt',
        binary: 'blocked',
      },
    })
    expect(candidate).toMatchObject({
      licenseMetadata: { status: 'permitted', url: 'https://example.test/license' },
      sourceMetadata: { doi: '10.1/example', comment: 'note' },
      mediaCandidate: { type: 'image', url: 'https://cdn.example.test/x' },
    })
    expect(candidate).not.toHaveProperty('body')
    expect(candidate.mediaCandidate).not.toHaveProperty('binary')
    expect(() =>
      commitFence(
        { key: 'bad', ownerTokenHash: 'a'.repeat(64), leaseGeneration: 1 },
        { sourceId: SOURCE_ID },
      ),
    ).toThrow()
    expect(() =>
      commitFence(
        {
          key: `ingestion:source:${SOURCE_ID}`,
          ownerTokenHash: 'a'.repeat(64),
          leaseGeneration: 2,
        },
        { sourceId: SOURCE_ID, leaseGeneration: 1 },
      ),
    ).toThrow()
    expect(() =>
      assertArticleMatchesCurrent(articleFixture(), { ...sourceFixture(), policyVersion: 4 }),
    ).toThrowError(expect.objectContaining({ code: 'policy_version_mismatch' }))
  })

  it('supports fallback and aggregation visibility reads with source filtering', async () => {
    const { repository, collections, article, source } = repositoryFixture()
    collections.articles.aggregate = undefined
    collections.articles.find.mockReturnValue(fluent([article, { ...article, _id: DUPLICATE_ID }]))
    collections.sources.findOne
      .mockResolvedValueOnce(source)
      .mockResolvedValueOnce({ ...source, operationalStatus: 'paused' })
    const fallback = await repository.findVisibleArticles({ sourceId: SOURCE_ID, limit: 2 })
    expect(fallback).toHaveLength(1)
    expect(fallback[0]).toMatchObject({ id: ARTICLE_ID.toHexString(), status: 'published' })
    await expect(repository.findVisibleArticles({ limit: 0 })).rejects.toMatchObject({
      code: 'article_query_invalid',
      status: 400,
    })

    collections.articles.aggregate = vi.fn(() => fluent([{ ...article, _currentSource: source }]))
    const aggregated = await repository.findVisibleArticles({ limit: 1 })
    expect(aggregated).toHaveLength(1)
    expect(aggregated[0]).toMatchObject({ id: ARTICLE_ID.toHexString() })
    expect(collections.articles.aggregate).toHaveBeenCalledWith(
      expect.arrayContaining([expect.objectContaining({ $lookup: expect.any(Object) })]),
    )
  })

  it('lists visible articles with cursor, total count and last-page ordering', async () => {
    const { repository, collections, article, source } = repositoryFixture()
    const rows = [
      publicDocument(article, source),
      publicDocument(
        { ...article, _id: DUPLICATE_ID, publishedAt: new Date(RETRIEVED_AT.getTime() - 1_000) },
        source,
      ),
      publicDocument(
        {
          ...article,
          _id: new ObjectId('507f1f77bcf86cd799439304'),
          publishedAt: new Date(RETRIEVED_AT.getTime() - 2_000),
        },
        source,
      ),
    ]
    collections.articles.aggregate.mockReturnValue(
      fluent([{ page: rows, total: [{ totalItems: 3 }] }]),
    )
    const first = await repository.listVisibleArticles({ userId: SOURCE_ID, topic: 'ai', limit: 2 })
    expect(first).toMatchObject({
      totalItems: 3,
      hasNext: true,
      articles: expect.any(Array),
      nextCursor: expect.any(String),
    })
    expect(first.articles).toHaveLength(2)

    collections.articles.aggregate.mockReturnValue(
      fluent([{ page: rows.slice().reverse(), total: [{ totalItems: 3 }] }]),
    )
    const last = await repository.listVisibleArticles({ limit: 2, lastPage: true })
    expect(last.articles).toHaveLength(1)
    expect(last.hasNext).toBe(false)
    await expect(repository.listVisibleArticles({ page: 10001 })).rejects.toMatchObject({
      code: 'validation_error',
      status: 422,
    })
    await expect(
      repository.listVisibleArticles({ page: 1002, limit: 100, lastPage: false }),
    ).rejects.toMatchObject({ code: 'validation_error', status: 422 })
  })

  it('searches text and hybrid results, including no-vector fallback and cursor validation', async () => {
    const source = sourceFixture()
    const article = articleFixture({ titleOriginal: 'Dien luc va AI' }, source)
    const second = {
      ...article,
      _id: DUPLICATE_ID,
      publishedAt: new Date(RETRIEVED_AT.getTime() - 1_000),
    }
    const textDocument = publicDocument({ ...article, _textScore: 3 }, source)
    const repoFixture = repositoryFixture({
      embeddingTarget: {
        model: 'test-model',
        dimensions: 2,
        version: 1,
        artifactCompatibilityId: 'test-v1',
      },
    })
    const { repository, collections } = repoFixture
    collections.articles.aggregate.mockReturnValueOnce(
      fluent([textDocument, publicDocument({ ...second, _textScore: 1 }, source)]),
    )
    const text = await repository.searchVisibleArticles({
      q: '  Điện   lực ',
      mode: 'text',
      limit: 1,
    })
    expect(text).toMatchObject({
      hasNext: true,
      results: [{ article: { id: ARTICLE_ID.toHexString() }, semanticScore: null }],
      nextCursor: expect.any(String),
    })
    await expect(repository.searchVisibleArticles({ q: 'x' })).rejects.toMatchObject({
      code: 'validation_error',
      status: 422,
    })

    const queryEmbedding = {
      model: 'test-model',
      dimensions: 2,
      version: 1,
      artifactCompatibilityId: 'test-v1',
      embedding: [1, 0],
    }
    collections.articles.aggregate.mockReset()
    collections.articles.aggregate
      .mockReturnValueOnce(
        fluent([
          publicDocument(
            {
              ...article,
              _textScore: 2,
              embeddingStatus: 'ready',
              embeddingModel: 'test-model',
              embeddingDimensions: 2,
              embeddingVersion: 1,
              embeddingArtifactCompatibilityId: 'test-v1',
              embedding: [1, 0],
            },
            source,
          ),
        ]),
      )
      .mockReturnValueOnce(fluent([]))
    const fallback = await repository.searchVisibleArticles({
      q: 'Dien luc',
      mode: 'hybrid',
      queryEmbedding,
      limit: 2,
    })
    expect(fallback).toMatchObject({ fallbackReason: 'no-compatible-vectors', hasNext: false })

    collections.articles.aggregate.mockReset()
    collections.articles.aggregate
      .mockReturnValueOnce(
        fluent([
          publicDocument(
            {
              ...article,
              _textScore: 2,
              embeddingStatus: 'ready',
              embeddingModel: 'test-model',
              embeddingDimensions: 2,
              embeddingVersion: 1,
              embeddingArtifactCompatibilityId: 'test-v1',
              embedding: [1, 0],
            },
            source,
          ),
        ]),
      )
      .mockReturnValueOnce(
        fluent([
          publicDocument(
            {
              ...article,
              _textScore: 0,
              embeddingStatus: 'ready',
              embeddingModel: 'test-model',
              embeddingDimensions: 2,
              embeddingVersion: 1,
              embeddingArtifactCompatibilityId: 'test-v1',
              embedding: [1, 0],
            },
            source,
          ),
        ]),
      )
    const hybrid = await repository.searchVisibleArticles({
      q: 'Dien luc',
      mode: 'hybrid',
      queryEmbedding,
      limit: 1,
    })
    expect(hybrid.results[0]).toMatchObject({ semanticScore: 1, score: expect.any(Number) })
  })

  it('commits artifact fields only after lease, job, source, article and input fences pass', async () => {
    const { repository, collections, article, source } = repositoryFixture()
    repository.withTransaction = vi.fn(async (work) => work({}))
    const jobId = new ObjectId('507f1f77bcf86cd799439305')
    const job = {
      id: jobId.toHexString(),
      articleId: ARTICLE_ID.toHexString(),
      sourceId: SOURCE_ID,
      task: 'summary',
    }
    const fence = {
      key: `indexing:article:${ARTICLE_ID.toHexString()}`,
      ownerTokenHash: 'a'.repeat(64),
      leaseGeneration: 1,
    }
    collections.indexingJobs.findOne.mockResolvedValue({ _id: jobId, status: 'running' })
    const inputHash = buildPolicyDerivedInput({
      article: serializeArticle(article),
      source: { ...source, id: SOURCE_ID },
      purpose: 'summary',
    }).inputHash
    const committed = vi.fn()
    await expect(
      repository.commitArtifact({
        job,
        fence,
        expectedSourcePolicyVersion: source.policyVersion,
        purpose: 'summary',
        inputHash,
        fields: { summaryStatus: 'processing' },
        onCommitted: committed,
      }),
    ).resolves.toBe(true)
    expect(collections.articles.updateOne).toHaveBeenCalled()
    expect(committed).toHaveBeenCalledWith(
      expect.objectContaining({
        article: expect.objectContaining({ id: ARTICLE_ID.toHexString() }),
      }),
    )

    collections.jobLeases.updateOne.mockResolvedValue({ matchedCount: 0 })
    await expect(
      repository.commitArtifact({
        job,
        fence,
        expectedSourcePolicyVersion: source.policyVersion,
        purpose: 'summary',
        inputHash,
        fields: {},
      }),
    ).resolves.toBe(false)
    await expect(
      repository.commitArtifact({
        job: { ...job, id: 'bad' },
        fence,
        expectedSourcePolicyVersion: source.policyVersion,
        purpose: 'summary',
        inputHash,
        fields: {},
      }),
    ).resolves.toBe(false)
  })

  it('builds processing, pending and failed artifact transitions immutably', async () => {
    const { repository } = repositoryFixture()
    repository.commitArtifact = vi.fn(async (input) => input)
    await expect(
      repository.markArtifactProcessing({
        job: {},
        fence: {},
        expectedSourcePolicyVersion: 3,
        purpose: 'summary',
        inputHash: 'hash',
      }),
    ).resolves.toMatchObject({ fields: { summaryStatus: 'processing' } })
    await expect(
      repository.markArtifactProcessing({
        job: {},
        fence: {},
        expectedSourcePolicyVersion: 3,
        purpose: 'embedding',
        inputHash: 'hash',
      }),
    ).resolves.toMatchObject({
      fields: { embeddingStatus: 'processing' },
      unsetFields: ['embeddingArtifactCompatibilityId'],
    })
    await expect(
      repository.resetArtifactPending({
        job: {},
        fence: {},
        expectedSourcePolicyVersion: 3,
        purpose: 'summary',
        inputHash: 'hash',
      }),
    ).resolves.toMatchObject({ fields: { summaryStatus: 'pending' } })
    await expect(
      repository.markArtifactFailed({
        job: {},
        fence: {},
        expectedSourcePolicyVersion: 3,
        purpose: 'embedding',
        inputHash: 'hash',
        error: { code: 'provider', retryable: true },
      }),
    ).resolves.toMatchObject({
      fields: { embeddingStatus: 'failed', embeddingError: { code: 'provider', retryable: true } },
    })
    await expect(
      repository.markArtifactProcessing({ purpose: 'other', inputHash: 'hash' }),
    ).resolves.toBe(false)
  })
  it('runs hide, restore, remove and merge lifecycle transitions with optimistic writes', async () => {
    const first = repositoryFixture()
    first.collections.articles.findOne.mockResolvedValue(first.article)
    expect(
      await first.repository.hideArticle({
        articleId: ARTICLE_ID,
        reason: 'moderation_review',
        now: RETRIEVED_AT,
      }),
    ).toMatchObject({ status: 'hidden', hiddenReason: 'moderation_review' })
    expect(first.collections.articles.replaceOne).toHaveBeenCalled()

    const restored = repositoryFixture()
    restored.collections.articles.findOne.mockResolvedValue({
      ...restored.article,
      status: 'hidden',
    })
    expect(
      await restored.repository.restoreArticle({ articleId: ARTICLE_ID, now: RETRIEVED_AT }),
    ).toMatchObject({ status: 'published', leadMediaStatus: 'available' })

    const removed = repositoryFixture()
    removed.collections.articles.findOne.mockResolvedValue(removed.article)
    expect(
      await removed.repository.removeArticle({ articleId: ARTICLE_ID, now: RETRIEVED_AT }),
    ).toMatchObject({ status: 'removed', evidenceEligible: false })

    const missing = repositoryFixture()
    missing.collections.articles.findOne.mockResolvedValue(null)
    await expect(missing.repository.hideArticle({ articleId: ARTICLE_ID })).resolves.toBeNull()

    const merged = repositoryFixture()
    const duplicate = {
      ...articleFixture(
        { externalId: 'item-2', originalUrl: 'https://example.com/articles/two' },
        merged.source,
      ),
      _id: DUPLICATE_ID,
    }
    merged.collections.articles.findOne
      .mockResolvedValueOnce(merged.article)
      .mockResolvedValueOnce(duplicate)
    merged.repository.withTransaction = vi.fn(async (work) => work({}))
    merged.collections.articles.replaceOne.mockResolvedValue({ matchedCount: 1 })
    await expect(
      merged.repository.mergeArticles({
        canonicalId: ARTICLE_ID,
        duplicateId: DUPLICATE_ID,
        now: RETRIEVED_AT,
      }),
    ).resolves.toMatchObject({
      canonical: expect.any(Object),
      duplicate: expect.objectContaining({ status: 'hidden' }),
    })
  })

  it('lists and mutates saved articles only through current visibility fences', async () => {
    const fixture = repositoryFixture()
    const hiddenRelation = {
      _id: DUPLICATE_ID,
      articleId: DUPLICATE_ID,
      userId: SOURCE_OBJECT_ID,
      createdAt: new Date(RETRIEVED_AT.getTime() - 1_000),
    }
    const visibleRelation = {
      _id: ARTICLE_ID,
      articleId: ARTICLE_ID,
      userId: SOURCE_OBJECT_ID,
      createdAt: RETRIEVED_AT,
    }
    fixture.collections.savedArticles.find.mockReturnValue(
      fluent([visibleRelation, hiddenRelation]),
    )
    fixture.collections.articles.aggregate.mockReturnValue(
      fluent([publicDocument(fixture.article, fixture.source)]),
    )
    const page = await fixture.repository.listSavedVisibleArticles({ userId: SOURCE_ID, limit: 1 })
    expect(page).toMatchObject({
      articles: [{ id: ARTICLE_ID.toHexString(), isSaved: true }],
      hasNext: false,
    })
    expect(fixture.collections.savedArticles.deleteMany).toHaveBeenCalledWith(
      expect.objectContaining({ _id: { $in: [DUPLICATE_ID] } }),
    )

    fixture.repository.findVisibleArticleDocument = vi.fn(async () =>
      publicDocument(fixture.article, fixture.source),
    )
    fixture.repository.withTransaction = vi.fn(async (work) => work({}))
    await expect(
      fixture.repository.saveVisibleArticle({
        userId: SOURCE_ID,
        articleId: ARTICLE_ID,
        actorFence: { sessionId: DUPLICATE_ID, sessionVersion: 1 },
      }),
    ).resolves.toBe(true)
    expect(fixture.collections.savedArticles.updateOne).toHaveBeenCalledWith(
      expect.objectContaining({ userId: SOURCE_OBJECT_ID, articleId: ARTICLE_ID }),
      expect.objectContaining({ $setOnInsert: expect.any(Object) }),
      expect.objectContaining({ upsert: true }),
    )
    await expect(
      fixture.repository.saveVisibleArticle({
        userId: SOURCE_ID,
        articleId: 'bad',
        actorFence: { sessionId: DUPLICATE_ID, sessionVersion: 1 },
      }),
    ).resolves.toBe(false)
    await expect(
      fixture.repository.saveVisibleArticle({
        userId: SOURCE_ID,
        articleId: ARTICLE_ID,
        actorFence: {},
      }),
    ).rejects.toMatchObject({ code: 'conflict', status: 409 })
    await fixture.repository.unsaveArticle({ userId: SOURCE_ID, articleId: ARTICLE_ID })
    await fixture.repository.unsaveArticle({ userId: SOURCE_ID, articleId: 'bad' })
    await fixture.repository.clearSavedArticles({ userId: SOURCE_ID })
  })

  it('reconciles article visibility and exposes detail/indexing/Q&A read paths', async () => {
    const fixture = repositoryFixture()
    const enriched = { ...fixture.article, _currentSource: fixture.source }
    fixture.collections.articles.aggregate.mockReturnValue(fluent([enriched]))
    await expect(
      fixture.repository.findVisibleArticleDocument({ articleId: ARTICLE_ID.toHexString() }),
    ).resolves.toEqual(enriched)
    await expect(
      fixture.repository.findVisibleArticleDocument({ articleId: 'bad' }),
    ).resolves.toBeNull()
    fixture.repository.findVisibleArticleDocument = vi.fn(async () => enriched)
    await expect(
      fixture.repository.getVisibleArticle({ articleId: ARTICLE_ID }),
    ).resolves.toMatchObject({
      id: ARTICLE_ID.toHexString(),
      originalUrl: expect.stringContaining('https://'),
    })
    await expect(fixture.repository.findArticleForIndexing('bad')).resolves.toBeNull()
    await expect(fixture.repository.findArticleForIndexing(ARTICLE_ID)).resolves.toMatchObject({
      id: ARTICLE_ID.toHexString(),
    })

    const jobId = new ObjectId('507f1f77bcf86cd799439306')
    fixture.collections.indexingJobs.findOne.mockResolvedValue({ _id: jobId, status: 'running' })
    fixture.collections.sources.findOne.mockResolvedValue({
      ...fixture.source,
      reconciliation: { requiredPolicyVersion: 3 },
    })
    const result = await fixture.repository.reconcileArticleVisibility({
      job: {
        id: jobId.toHexString(),
        articleId: ARTICLE_ID.toHexString(),
        sourceId: SOURCE_ID,
        task: 'visibility-reconcile',
      },
      fence: {
        key: `indexing:article:${ARTICLE_ID.toHexString()}`,
        ownerTokenHash: 'a'.repeat(64),
        leaseGeneration: 1,
      },
      expectedSourcePolicyVersion: 3,
      now: RETRIEVED_AT,
    })
    expect(result).toBe(true)
    expect(fixture.collections.articles.updateOne).toHaveBeenCalledWith(
      expect.objectContaining({ _id: ARTICLE_ID }),
      expect.objectContaining({
        $set: expect.objectContaining({ summaryStatus: 'pending', embeddingStatus: 'pending' }),
      }),
      expect.any(Object),
    )

    fixture.collections.articles.aggregate.mockReturnValue(fluent([enriched]))
    const evidence = await fixture.repository.findQnaEvidence({ limit: 1, includeSource: true })
    expect(evidence).toEqual([
      {
        article: expect.objectContaining({ id: ARTICLE_ID.toHexString() }),
        source: expect.objectContaining({ id: SOURCE_ID }),
      },
    ])
    await expect(fixture.repository.findQnaEvidence({ limit: 0 })).rejects.toMatchObject({
      code: 'article_query_invalid',
    })
  })

  it('validates summary and embedding artifact envelopes before delegation', async () => {
    const fixture = repositoryFixture({
      embeddingTarget: {
        model: 'test-model',
        dimensions: 2,
        version: 1,
        artifactCompatibilityId: 'test-v1',
      },
    })
    fixture.repository.commitArtifact = vi.fn(async (input) => input)
    const summary = {
      titleVi: 'Tóm tắt',
      summaryVi: 'Đây là tóm tắt bằng tiếng Việt.',
      summaryParagraphsVi: [
        'Đoạn thứ nhất có nội dung tiếng Việt.',
        'Đoạn thứ hai có nội dung tiếng Việt.',
      ],
      summaryStatus: 'ready',
      summaryDetailStatus: 'ready',
      summaryBasis: 'excerpt',
      summaryInputHash: 'hash',
      summarySourcePolicyVersion: 3,
      summaryModel: 'model',
      summaryGeneratedAt: RETRIEVED_AT,
    }
    await expect(
      fixture.repository.commitSummaryArtifact({
        summary,
        inputHash: 'hash',
        expectedSourcePolicyVersion: 3,
      }),
    ).resolves.toMatchObject({ purpose: 'summary', fields: { summaryStatus: 'ready' } })
    await expect(
      fixture.repository.commitSummaryArtifact({
        summary: { ...summary, summaryStatus: 'failed' },
        inputHash: 'hash',
        expectedSourcePolicyVersion: 3,
      }),
    ).resolves.toBe(false)
    const embedding = {
      embeddingStatus: 'ready',
      embedding: [1, 0],
      embeddingModel: 'test-model',
      embeddingDimensions: 2,
      embeddingVersion: 1,
      embeddingArtifactCompatibilityId: 'test-v1',
      embeddingInputHash: 'hash',
      embeddingSourcePolicyVersion: 3,
      embeddedAt: RETRIEVED_AT,
    }
    await expect(
      fixture.repository.commitEmbeddingArtifact({
        embedding,
        inputHash: 'hash',
        expectedSourcePolicyVersion: 3,
      }),
    ).resolves.toMatchObject({
      purpose: 'embedding',
      fields: { embeddingStatus: 'ready', embedding: [1, 0] },
    })
    await expect(
      fixture.repository.commitEmbeddingArtifact({
        embedding: { ...embedding, embedding: [1] },
        inputHash: 'hash',
        expectedSourcePolicyVersion: 3,
      }),
    ).resolves.toBe(false)
  })

  it('commits a fenced ingestion batch, updates counters and replays its checkpoint', async () => {
    const fixture = repositoryFixture()
    const job = makeJob()
    const currentJob = {
      _id: new ObjectId(job.id),
      status: 'running',
      leaseGeneration: 1,
      counters: { fetched: 0, created: 0, updated: 0, duplicate: 0, skipped: 0, failed: 0 },
    }
    fixture.collections.jobs.findOne.mockResolvedValue(currentJob)
    fixture.collections.jobs.updateOne.mockImplementation(async (_filter, update) => {
      Object.assign(currentJob, update.$set)
      return { matchedCount: 1 }
    })
    fixture.collections.articles.findOne.mockResolvedValue(null)
    fixture.collections.sources.findOne.mockResolvedValue({
      ...fixture.source,
      _id: SOURCE_OBJECT_ID,
    })
    fixture.repository.withTransaction = vi.fn(async (work) => work({}))
    const input = {
      job,
      fence: {
        key: `ingestion:source:${SOURCE_ID}`,
        ownerTokenHash: 'a'.repeat(64),
        leaseGeneration: 1,
      },
      source: fixture.source,
      expectedSourcePolicyVersion: 3,
      expectedConnectorConfig: fixture.source.connectorConfig,
      candidates: [makeCandidate()],
      checkpoint: { processedCount: 1, cursor: 'cursor-1', lastExternalId: 'item-1' },
      counters: { fetched: 1 },
      retrievedAt: RETRIEVED_AT,
    }
    const first = await fixture.repository.commitIngestionBatch(input)
    expect(first).toMatchObject({
      created: 1,
      fetched: 1,
      counters: { fetched: 1, created: 1 },
      checkpoint: input.checkpoint,
    })
    const replay = await fixture.repository.commitCandidates(input)
    expect(replay).toMatchObject({ created: 0, fetched: 0, counters: first.counters })
    expect(fixture.collections.articles.insertOne).toHaveBeenCalledTimes(1)
    expect(fixture.collections.indexingJobs.updateOne).toHaveBeenCalled()
    expect(fixture.collections.jobs.updateOne).toHaveBeenCalledTimes(1)
  })

  it('upserts new candidates, merges existing records and preserves removed tombstones', async () => {
    const created = repositoryFixture()
    created.collections.articles.findOne.mockResolvedValue(null)
    expect(await created.repository.upsertCandidate({ article: created.article })).toMatchObject({
      created: 1,
      updated: 0,
    })
    expect(created.collections.articles.insertOne).toHaveBeenCalled()

    const updated = repositoryFixture()
    updated.collections.articles.findOne.mockResolvedValue(updated.article)
    expect(await updated.repository.upsertCandidate({ article: updated.article })).toMatchObject({
      created: 0,
      updated: 1,
      duplicate: 1,
    })
    expect(updated.collections.articles.updateOne).toHaveBeenCalled()

    const removed = repositoryFixture()
    const tombstone = articleDocument(
      { ...removed.article, status: 'removed', removedAt: RETRIEVED_AT, removalPolicyVersion: 3 },
      ARTICLE_ID,
    )
    removed.collections.articles.findOne.mockResolvedValue(tombstone)
    expect(await removed.repository.upsertCandidate({ article: removed.article })).toMatchObject({
      duplicate: 1,
      article: { status: 'removed' },
    })
    await expect(
      repositoryFixture().repository.commitIngestionBatch({
        job: makeJob(),
        fence: {},
        source: sourceFixture(),
      }),
    ).rejects.toMatchObject({ code: 'lease_fence_stale' })
  })

  it('fails closed for invalid public article values, cursors and embedding targets', async () => {
    expect(
      () =>
        new MongoArticleRepository({ db: {}, client: {} }, { embeddingTarget: { dimensions: 0 } }),
    ).toThrow('Embedding target')
    expect(() =>
      articleDocument(
        {
          status: 'removed',
          ...articleFixture(),
          connectorType: 'unsupported',
          removedAt: RETRIEVED_AT,
          removalPolicyVersion: 3,
        },
        ARTICLE_ID,
      ),
    ).toThrow()
    expect(() =>
      safeCandidate({ licenseMetadata: [], sourceMetadata: [], mediaCandidate: [] }),
    ).not.toThrow()
    const fixture = repositoryFixture()
    await expect(fixture.repository.listVisibleArticles({ cursor: 'bad' })).rejects.toMatchObject({
      code: 'validation_error',
      status: 422,
    })
    await expect(
      fixture.repository.searchVisibleArticles({ q: 'valid query', cursor: 'bad' }),
    ).rejects.toMatchObject({ code: 'validation_error', status: 422 })
    await expect(
      fixture.repository.listSavedVisibleArticles({ userId: SOURCE_ID, limit: 0 }),
    ).rejects.toMatchObject({ code: 'validation_error', status: 422 })
    await expect(
      fixture.repository.findQnaEvidence({ scope: { topics: [''] } }),
    ).rejects.toMatchObject({ code: 'validation_error', status: 422 })
    await expect(fixture.repository.visibleArticlesByIds([])).resolves.toEqual(new Map())
    fixture.repository.findVisibleArticleDocument = vi.fn(async () => null)
    await expect(
      fixture.repository.getVisibleArticle({ articleId: ARTICLE_ID }),
    ).resolves.toBeNull()
    const invalidMedia = repositoryFixture()
    const document = publicDocument(
      {
        ...invalidMedia.article,
        leadMedia: {
          type: 'image',
          displayMode: 'inline',
          attribution: 'credit',
          url: 'https://cdn.example.test/x',
          sourcePageUrl: 'https://example.test/a',
        },
        leadMediaStatus: 'available',
      },
      invalidMedia.source,
    )
    invalidMedia.repository.findVisibleArticleDocument = vi.fn(async () => document)
    await expect(
      invalidMedia.repository.getVisibleArticle({ articleId: ARTICLE_ID }),
    ).resolves.toMatchObject({ leadMedia: null })
  })

  it('covers artifact and reconciliation fail-closed branches', async () => {
    const fixture = repositoryFixture()
    const jobId = new ObjectId('507f1f77bcf86cd799439307')
    const job = {
      id: jobId.toHexString(),
      articleId: ARTICLE_ID.toHexString(),
      sourceId: SOURCE_ID,
      task: 'summary',
    }
    const fence = {
      key: `indexing:article:${ARTICLE_ID.toHexString()}`,
      ownerTokenHash: 'a'.repeat(64),
      leaseGeneration: 1,
    }
    fixture.repository.withTransaction = vi.fn(async (work) => work({}))
    const hash = buildPolicyDerivedInput({
      article: serializeArticle(fixture.article),
      source: { ...fixture.source, id: SOURCE_ID },
      purpose: 'summary',
    }).inputHash
    await expect(
      fixture.repository.commitArtifact({
        job,
        fence: { ...fence, key: 'invalid' },
        expectedSourcePolicyVersion: 3,
        purpose: 'summary',
        inputHash: hash,
        fields: {},
      }),
    ).resolves.toBe(false)
    fixture.collections.indexingJobs.findOne.mockResolvedValue(null)
    await expect(
      fixture.repository.commitArtifact({
        job,
        fence,
        expectedSourcePolicyVersion: 3,
        purpose: 'summary',
        inputHash: hash,
        fields: {},
      }),
    ).resolves.toBe(false)
    fixture.collections.indexingJobs.findOne.mockResolvedValue({ _id: jobId })
    fixture.collections.sources.findOne.mockResolvedValue(null)
    await expect(
      fixture.repository.commitArtifact({
        job,
        fence,
        expectedSourcePolicyVersion: 3,
        purpose: 'summary',
        inputHash: hash,
        fields: {},
      }),
    ).resolves.toBe(false)
    fixture.collections.sources.findOne.mockResolvedValue(fixture.source)
    fixture.collections.articles.findOne.mockResolvedValue(null)
    await expect(
      fixture.repository.commitArtifact({
        job,
        fence,
        expectedSourcePolicyVersion: 3,
        purpose: 'summary',
        inputHash: hash,
        fields: {},
      }),
    ).resolves.toBe(false)
    fixture.collections.articles.findOne.mockResolvedValue(fixture.article)
    await expect(
      fixture.repository.commitArtifact({
        job,
        fence,
        expectedSourcePolicyVersion: 3,
        purpose: 'summary',
        inputHash: 'wrong',
        fields: {},
      }),
    ).resolves.toBe(false)
    fixture.collections.articles.updateOne.mockResolvedValue({ matchedCount: 0 })
    await expect(
      fixture.repository.commitArtifact({
        job,
        fence,
        expectedSourcePolicyVersion: 3,
        purpose: 'summary',
        inputHash: hash,
        fields: {},
      }),
    ).resolves.toBe(false)
    await expect(
      fixture.repository.commitSummaryArtifact({
        summary: {},
        inputHash: hash,
        expectedSourcePolicyVersion: 3,
      }),
    ).resolves.toBe(false)
    await expect(
      fixture.repository.resetArtifactPending({ purpose: 'unknown', inputHash: hash }),
    ).resolves.toBe(false)
    await expect(
      fixture.repository.markArtifactFailed({ purpose: 'unknown', inputHash: hash }),
    ).resolves.toBe(false)

    await expect(
      fixture.repository.reconcileArticleVisibility({
        job: { ...job, task: 'summary' },
        fence,
        expectedSourcePolicyVersion: 3,
      }),
    ).resolves.toBe(false)
    fixture.collections.jobLeases.updateOne.mockResolvedValue({ matchedCount: 0 })
    await expect(
      fixture.repository.reconcileArticleVisibility({
        job: { ...job, task: 'visibility-reconcile' },
        fence,
        expectedSourcePolicyVersion: 3,
      }),
    ).resolves.toBe(false)
  })

  it('covers ingestion validation, replay conflicts and lifecycle write races', async () => {
    const base = repositoryFixture()
    const job = makeJob()
    const currentJob = {
      _id: new ObjectId(job.id),
      status: 'running',
      leaseGeneration: 1,
      counters: {},
    }
    base.collections.jobs.findOne.mockResolvedValue(currentJob)
    base.collections.sources.findOne.mockResolvedValue(base.source)
    base.repository.withTransaction = vi.fn(async (work) => work({}))
    const fence = {
      key: `ingestion:source:${SOURCE_ID}`,
      ownerTokenHash: 'a'.repeat(64),
      leaseGeneration: 1,
    }
    await expect(
      base.repository.commitIngestionBatch({
        job,
        fence,
        source: base.source,
        expectedSourcePolicyVersion: 3,
        expectedConnectorConfig: base.source.connectorConfig,
        checkpoint: { processedCount: -1 },
      }),
    ).rejects.toMatchObject({ code: 'article_checkpoint_invalid' })
    await expect(
      base.repository.commitIngestionBatch({
        job: { ...job, id: undefined },
        fence,
        source: base.source,
        expectedSourcePolicyVersion: 3,
        expectedConnectorConfig: base.source.connectorConfig,
      }),
    ).rejects.toMatchObject({ code: 'lease_fence_stale' })
    await expect(
      base.repository.commitIngestionBatch({
        job: { ...job, expectedConnectorConfig: null },
        fence,
        source: { ...base.source, connectorConfig: null },
        expectedSourcePolicyVersion: 3,
        expectedConnectorConfig: null,
      }),
    ).rejects.toMatchObject({ code: 'policy_version_mismatch' })

    const missingJob = repositoryFixture()
    missingJob.collections.jobs.findOne.mockResolvedValue(null)
    missingJob.collections.sources.findOne.mockResolvedValue(missingJob.source)
    missingJob.repository.withTransaction = vi.fn(async (work) => work({}))
    await expect(
      missingJob.repository.commitIngestionBatch({
        job,
        fence,
        source: missingJob.source,
        expectedSourcePolicyVersion: 3,
        expectedConnectorConfig: missingJob.source.connectorConfig,
      }),
    ).rejects.toMatchObject({ code: 'lease_fence_stale' })

    const sourceMismatch = repositoryFixture()
    sourceMismatch.collections.jobs.findOne.mockResolvedValue(currentJob)
    sourceMismatch.collections.sources.findOne.mockResolvedValue({
      ...sourceMismatch.source,
      connectorConfig: { kind: 'rss', feedUrl: 'https://other.test/feed' },
    })
    sourceMismatch.repository.withTransaction = vi.fn(async (work) => work({}))
    await expect(
      sourceMismatch.repository.commitIngestionBatch({
        job,
        fence,
        source: sourceMismatch.source,
        expectedSourcePolicyVersion: 3,
        expectedConnectorConfig: sourceMismatch.source.connectorConfig,
      }),
    ).rejects.toMatchObject({ code: 'policy_version_mismatch' })

    const updateRace = repositoryFixture()
    updateRace.collections.jobs.findOne.mockResolvedValue(currentJob)
    updateRace.collections.sources.findOne.mockResolvedValue(updateRace.source)
    updateRace.collections.articles.findOne.mockResolvedValue(null)
    updateRace.collections.jobs.updateOne.mockResolvedValue({ matchedCount: 0 })
    updateRace.repository.withTransaction = vi.fn(async (work) => work({}))
    await expect(
      updateRace.repository.commitIngestionBatch({
        job,
        fence,
        source: updateRace.source,
        expectedSourcePolicyVersion: 3,
        expectedConnectorConfig: updateRace.source.connectorConfig,
        candidates: [makeCandidate()],
      }),
    ).rejects.toMatchObject({ code: 'lease_fence_stale' })

    const hideRace = repositoryFixture()
    hideRace.collections.articles.replaceOne.mockResolvedValue({ matchedCount: 0 })
    await expect(hideRace.repository.hideArticle({ articleId: ARTICLE_ID })).rejects.toMatchObject({
      code: 'article_conflict',
    })
    const removeRace = repositoryFixture()
    removeRace.collections.articles.replaceOne.mockResolvedValue({ matchedCount: 0 })
    await expect(
      removeRace.repository.removeArticle({ articleId: ARTICLE_ID }),
    ).rejects.toMatchObject({ code: 'article_conflict' })
    await expect(
      repositoryFixture().repository.mergeArticles({
        canonicalId: ARTICLE_ID,
        duplicateId: ARTICLE_ID,
      }),
    ).rejects.toMatchObject({ code: 'article_conflict' })
  })

  it('covers saved fences, query cursor boundaries and Q&A fallback ranking', async () => {
    const fixture = repositoryFixture()
    await expect(
      fixture.repository.listSavedVisibleArticles({ userId: SOURCE_ID, limit: 1, cursor: 'bad' }),
    ).rejects.toMatchObject({ code: 'validation_error' })
    fixture.collections.savedArticles.find.mockReturnValue(fluent([]))
    await expect(
      fixture.repository.listSavedVisibleArticles({ userId: SOURCE_ID, limit: 1 }),
    ).resolves.toMatchObject({ articles: [], hasNext: false })
    fixture.collections.articles.aggregate.mockReturnValue(
      fluent([
        {
          page: [
            publicDocument(fixture.article, fixture.source),
            publicDocument({ ...fixture.article, _id: DUPLICATE_ID }, fixture.source),
          ],
          total: [{ totalItems: 2 }],
        },
      ]),
    )
    const first = await fixture.repository.listVisibleArticles({
      userId: SOURCE_ID,
      topic: 'ai',
      limit: 1,
    })
    await expect(
      fixture.repository.listVisibleArticles({
        userId: SOURCE_ID,
        topic: 'ai',
        limit: 1,
        lastPage: true,
        cursor: first.nextCursor,
      }),
    ).rejects.toMatchObject({ code: 'validation_error' })
    await expect(
      fixture.repository.searchVisibleArticles({ q: 'valid', limit: 0 }),
    ).rejects.toMatchObject({ code: 'validation_error' })
    fixture.collections.articles.aggregate.mockReturnValue(fluent([]))
    const invalidEmbedding = await fixture.repository.searchVisibleArticles({
      q: 'valid',
      mode: 'hybrid',
      queryEmbedding: { model: '', dimensions: 0, version: 0, embedding: [] },
    })
    expect(invalidEmbedding).toMatchObject({ fallbackReason: 'no-compatible-vectors' })

    const visible = publicDocument(fixture.article, fixture.source)
    fixture.repository.findVisibleArticleDocument = vi.fn(async () => visible)
    fixture.collections.sessions.updateOne.mockResolvedValue({ matchedCount: 0 })
    await expect(
      fixture.repository.saveVisibleArticle({
        userId: SOURCE_ID,
        articleId: ARTICLE_ID,
        actorFence: { sessionId: DUPLICATE_ID, sessionVersion: 1 },
      }),
    ).rejects.toMatchObject({ code: 'conflict' })
    fixture.collections.sessions.updateOne.mockResolvedValue({ matchedCount: 1 })
    fixture.collections.articles.updateOne.mockResolvedValue({ matchedCount: 0 })
    await expect(
      fixture.repository.saveVisibleArticle({
        userId: SOURCE_ID,
        articleId: ARTICLE_ID,
        actorFence: { sessionId: DUPLICATE_ID, sessionVersion: 1 },
      }),
    ).rejects.toMatchObject({ code: 'conflict' })
    fixture.collections.articles.updateOne.mockResolvedValue({ matchedCount: 1 })
    fixture.collections.sources.updateOne.mockResolvedValue({ matchedCount: 0 })
    await expect(
      fixture.repository.saveVisibleArticle({
        userId: SOURCE_ID,
        articleId: ARTICLE_ID,
        actorFence: { sessionId: DUPLICATE_ID, sessionVersion: 1 },
      }),
    ).rejects.toMatchObject({ code: 'conflict' })

    fixture.collections.articles.aggregate = undefined
    fixture.collections.articles.find.mockReturnValue(fluent([fixture.article]))
    fixture.collections.sources.findOne.mockResolvedValue(fixture.source)
    await expect(
      fixture.repository.findQnaEvidence({ limit: 1, includeSource: true, question: 'AI safety' }),
    ).resolves.toHaveLength(1)
    await expect(fixture.repository.findQnaEvidence({ scope: [] })).rejects.toMatchObject({
      code: 'validation_error',
    })
    const invalidUrl = repositoryFixture()
    invalidUrl.repository.findVisibleArticleDocument = vi.fn(async () =>
      publicDocument(
        { ...invalidUrl.article, originalUrl: 'http://example.test/article' },
        invalidUrl.source,
      ),
    )
    await expect(
      invalidUrl.repository.getVisibleArticle({ articleId: ARTICLE_ID }),
    ).resolves.toBeNull()
  })

  it('covers remaining cursor, filter, media and reconciliation branches', async () => {
    const fixture = repositoryFixture()
    const second = publicDocument(
      {
        ...fixture.article,
        _id: DUPLICATE_ID,
        publishedAt: new Date(RETRIEVED_AT.getTime() - 1_000),
      },
      fixture.source,
    )
    fixture.collections.articles.aggregate.mockReturnValue(
      fluent([
        {
          page: [publicDocument(fixture.article, fixture.source), second],
          total: [{ totalItems: 2 }],
        },
      ]),
    )
    const first = await fixture.repository.listVisibleArticles({
      sourceId: SOURCE_ID,
      publishedAfter: new Date('2026-08-01T00:00:00.000Z'),
      publishedBefore: new Date('2026-08-20T00:00:00.000Z'),
      limit: 1,
    })
    expect(first.nextCursor).toEqual(expect.any(String))
    fixture.collections.articles.aggregate.mockReturnValue(
      fluent([{ page: [second], total: [{ totalItems: 2 }] }]),
    )
    await expect(
      fixture.repository.listVisibleArticles({
        sourceId: SOURCE_ID,
        publishedAfter: new Date('2026-08-01T00:00:00.000Z'),
        publishedBefore: new Date('2026-08-20T00:00:00.000Z'),
        cursor: first.nextCursor,
        limit: 1,
      }),
    ).resolves.toMatchObject({ articles: expect.any(Array) })
    fixture.collections.articles.aggregate.mockReturnValue(fluent([fixture.article]))
    await expect(fixture.repository.listVisibleArticles({ limit: 0 })).rejects.toMatchObject({
      code: 'validation_error',
    })
    await expect(
      fixture.repository.findVisibleArticleDocument({ articleId: ARTICLE_ID, session: {} }),
    ).resolves.toEqual(fixture.article)
    await expect(
      fixture.repository.findQnaEvidence({ scope: { publishedAfter: '2026-08-20T00:00:00.000Z' } }),
    ).rejects.toMatchObject({ code: 'validation_error' })

    const artifact = repositoryFixture()
    await expect(
      artifact.repository.commitArtifact({
        job: { id: DUPLICATE_ID, articleId: ARTICLE_ID, sourceId: SOURCE_ID },
        fence: {
          key: `indexing:article:${DUPLICATE_ID.toHexString()}`,
          ownerTokenHash: 'a'.repeat(64),
          leaseGeneration: 1,
        },
        expectedSourcePolicyVersion: 3,
        purpose: 'summary',
        inputHash: 'hash',
        fields: {},
      }),
    ).resolves.toBe(false)
    const video = repositoryFixture()
    video.repository.findVisibleArticleDocument = vi.fn(async () =>
      publicDocument(
        {
          ...video.article,
          leadMedia: {
            type: 'video',
            displayMode: 'remote-preview',
            attribution: 'credit',
            url: 'https://cdn.example.test/video',
            sourcePageUrl: 'https://example.test/a',
          },
          leadMediaStatus: 'available',
        },
        video.source,
      ),
    )
    await expect(
      video.repository.getVisibleArticle({ articleId: ARTICLE_ID }),
    ).resolves.toMatchObject({ leadMedia: null })

    const reconciliation = repositoryFixture()
    reconciliation.repository.withTransaction = vi.fn(async (work) => work({}))
    reconciliation.collections.indexingJobs.findOne.mockResolvedValue(null)
    await expect(
      reconciliation.repository.reconcileArticleVisibility({
        job: {
          id: DUPLICATE_ID,
          articleId: ARTICLE_ID,
          sourceId: SOURCE_OBJECT_ID,
          task: 'visibility-reconcile',
        },
        fence: {
          key: `indexing:article:${ARTICLE_ID.toHexString()}`,
          ownerTokenHash: 'a'.repeat(64),
          leaseGeneration: 1,
        },
        expectedSourcePolicyVersion: 3,
      }),
    ).resolves.toBe(false)
  })
})
