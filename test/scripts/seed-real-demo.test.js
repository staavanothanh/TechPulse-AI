import { createHash } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import { ObjectId } from 'mongodb'
import {
  applyDemoDataset,
  buildDemoDataset,
  parseSeedMode,
  resolveDemoReviewerId,
  seedDemo,
} from '../../scripts/seed-demo.js'

const RETRIEVED_AT = new Date('2026-08-17T00:00:00.000Z')
const FORBIDDEN_FIELDS = [
  'raw',
  'rawHtml',
  'html',
  'body',
  'content',
  'fullText',
  'translatedFullText',
  'mediaBinary',
  'binary',
  'imageBinary',
  'videoBinary',
  'audioBinary',
  'base64',
  'gridFsId',
  'providerPayload',
]

function source({ connectorType, sourceKey, domain, authorityTier, accessMethod }) {
  const id = new ObjectId(
    createHash('sha256').update(`real-demo-source\u0000${sourceKey}`).digest().subarray(0, 12),
  )
  return {
    id: id.toHexString(),
    _id: id,
    name: sourceKey,
    sourceKey,
    publisherName: sourceKey,
    domain,
    connectorType,
    accessMethod,
    authorityTier,
    connectorConfig: {
      kind: connectorType,
      ...(connectorType === 'rss' ? { feedUrl: `https://${domain}/feed.xml` } : {}),
      ...(connectorType === 'arxiv' ? { arxivQuery: 'cat:cs.AI' } : {}),
      ...(connectorType === 'hacker-news' ? { hackerNewsStream: 'topstories' } : {}),
      batchSize: 20,
    },
    operationalStatus: 'active',
    licenseStatus: 'permitted',
    llmInputScope: 'excerpt',
    storageScope: { metadata: true, excerpt: true, summary: true, embedding: true },
    mediaPolicy: {
      imageMode: 'none',
      videoMode: 'none',
      allowedHosts: [],
      attributionRequired: false,
      evidenceNote: 'Nguon cong khai duoc phep cho demo local.',
    },
    reviewedAt: RETRIEVED_AT,
    reviewedBy: new ObjectId('507f1f77bcf86cd799439011'),
    evidenceNote: 'Nguon cong khai duoc phep cho demo local.',
    policyVersion: 1,
    reconciliation: {
      status: 'completed',
      requiredPolicyVersion: 1,
      completedPolicyVersion: 1,
      requestedAt: RETRIEVED_AT,
      error: null,
    },
    technicalCheck: {
      status: 'passed',
      checkedAt: RETRIEVED_AT,
      contentType: connectorType === 'rss' ? 'application/rss+xml' : 'application/json',
      resolvedHost: domain,
      sampleCount: 1,
      error: null,
    },
    health: {
      lastIngestSucceededAt: RETRIEVED_AT,
      lastIngestFailedAt: null,
      consecutiveFailures: 0,
      lastError: null,
    },
    createdAt: RETRIEVED_AT,
    updatedAt: RETRIEVED_AT,
  }
}

function realSources() {
  return [
    source({
      connectorType: 'rss',
      sourceKey: 'rss:the-verge',
      domain: 'www.theverge.com',
      authorityTier: 'editorial',
      accessMethod: 'rss',
    }),
    source({
      connectorType: 'arxiv',
      sourceKey: 'arxiv:cs-ai',
      domain: 'export.arxiv.org',
      authorityTier: 'primary',
      accessMethod: 'api',
    }),
    source({
      connectorType: 'hacker-news',
      sourceKey: 'hn:topstories',
      domain: 'news.ycombinator.com',
      authorityTier: 'community-signal',
      accessMethod: 'api',
    }),
  ]
}

function connectorResult(sourceDocument, count = 20) {
  return {
    candidates: Array.from({ length: count }, (_, index) => ({
      sourceId: sourceDocument.id,
      connectorType: sourceDocument.connectorType,
      authorityTier: sourceDocument.authorityTier,
      externalId: `${sourceDocument.connectorType}:${index + 1}`,
      titleOriginal: `${sourceDocument.name} real article ${index + 1}`,
      originalUrl: `https://${sourceDocument.domain}/articles/${index + 1}`,
      author: 'Public publisher',
      publishedAt: new Date(RETRIEVED_AT.getTime() - index * 60_000),
      retrievedAt: RETRIEVED_AT,
      sourceLanguage: 'en',
      topics: ['ai', 'technology'],
      excerptOriginal: 'Official feed excerpt only; no full article body is persisted.',
    })),
  }
}

function connectorRegistry(sources, count = 20) {
  const runs = new Map()
  const connectors = new Map(
    sources.map((sourceDocument) => [
      sourceDocument.connectorType,
      {
        connectorType: sourceDocument.connectorType,
        name: sourceDocument.connectorType,
        run: vi.fn(async (input) => {
          runs.set(sourceDocument.connectorType, input)
          return connectorResult(sourceDocument, count)
        }),
      },
    ]),
  )
  return {
    runs,
    registry: {
      resolve: vi.fn((sourceDocument) => connectors.get(sourceDocument.connectorType)),
    },
  }
}

function memoryContext() {
  const stores = new Map()
  const writes = []
  const collection = (name) => {
    if (!stores.has(name)) stores.set(name, [])
    const documents = stores.get(name)
    return {
      async findOne(filter) {
        return (
          documents.find((document) =>
            Object.entries(filter).every(([key, value]) => {
              const actual = document[key]
              if (actual instanceof ObjectId && value instanceof ObjectId)
                return actual.equals(value)
              return actual === value
            }),
          ) ?? null
        )
      },
      async updateOne(filter, update, options) {
        const existing = await this.findOne(filter)
        if (existing) return { matchedCount: 1, upsertedCount: 0 }
        if (!options?.upsert || !update?.$setOnInsert) return { matchedCount: 0, upsertedCount: 0 }
        documents.push(update.$setOnInsert)
        writes.push({ name, document: update.$setOnInsert })
        return { matchedCount: 0, upsertedCount: 1 }
      },
    }
  }
  return {
    writes,
    db: { collection },
    client: {
      startSession() {
        return {
          async withTransaction(work) {
            return work()
          },
          async endSession() {},
        }
      },
    },
  }
}

describe('real connector demo seed', () => {
  it('requires an explicit active admin attestation before attributing policy review', async () => {
    const reviewerId = new ObjectId('507f1f77bcf86cd799439011')
    const findOne = vi.fn(async () => ({ _id: reviewerId }))
    const context = { db: { collection: () => ({ findOne }) } }

    await expect(resolveDemoReviewerId({ context, environment: {} })).rejects.toThrow(
      /attestation/i,
    )
    await expect(
      resolveDemoReviewerId({
        context,
        environment: {
          DEMO_SOURCE_POLICY_ATTESTED: 'true',
          DEMO_SOURCE_REVIEWER_ID: reviewerId.toHexString(),
        },
      }),
    ).resolves.toEqual(reviewerId)
    expect(findOne).toHaveBeenCalledWith(
      { _id: reviewerId, role: 'admin', status: 'active' },
      { projection: { _id: 1 } },
    )
  })

  it('invokes every configured connector, caps the combined result at 50, and never persists raw content', async () => {
    const sources = realSources()
    const { registry, runs } = connectorRegistry(sources, 20)
    const dataset = await buildDemoDataset({
      sources,
      connectorRegistry: registry,
      retrievedAt: RETRIEVED_AT,
      maxArticles: 50,
    })

    expect(dataset.articles).toHaveLength(50)
    expect(registry.resolve).toHaveBeenCalledTimes(sources.length)
    expect([...runs.keys()].sort()).toEqual(['arxiv', 'hacker-news', 'rss'])
    for (const sourceDocument of sources) {
      expect(runs.get(sourceDocument.connectorType)).toMatchObject({
        source: expect.objectContaining({ sourceKey: sourceDocument.sourceKey }),
        retrievedAt: expect.any(Date),
      })
    }
    expect(dataset.articles.map(({ connectorType }) => connectorType)).toEqual(
      expect.arrayContaining(['rss', 'arxiv', 'hacker-news']),
    )
    expect(dataset.source).toBeUndefined()
    expect(dataset.sources).toHaveLength(3)
    expect(dataset.sources.every(({ domain }) => !domain.includes('demo'))).toBe(true)
    expect(dataset.articles.every(({ originalUrl }) => !originalUrl.includes('.example'))).toBe(
      true,
    )
    expect(dataset.sources.every(({ policyVersion }) => policyVersion === 2)).toBe(true)
    expect(dataset.audits).toHaveLength(dataset.sources.length * 5)
    expect(dataset.manifests).toHaveLength(dataset.sources.length)
    expect(dataset.manifests.every(({ manifestId }) => /^[a-f0-9]{64}$/.test(manifestId))).toBe(
      true,
    )

    for (const sourceDocument of dataset.sources) {
      const audits = dataset.audits.filter(({ targetId }) => targetId.equals(sourceDocument._id))
      expect(actionsForLifecycle(audits)).toEqual([
        'source_created',
        'source_policy_reviewed',
        'source_technical_check_recorded',
        'source_status_updated:draft:testing',
        'source_status_updated:testing:active',
      ])
      expect(audits.every(({ targetId }) => targetId instanceof ObjectId)).toBe(true)
      expect(audits.map(({ createdAt }) => createdAt.getTime())).toEqual(
        [...audits].map(({ createdAt }) => createdAt.getTime()).sort((left, right) => left - right),
      )
      expect(new Set(audits.map(({ createdAt }) => createdAt.toISOString())).size).toBe(5)
      const manifest = dataset.manifests.find(({ sourceId }) => sourceId.equals(sourceDocument._id))
      expect(audits.every(({ requestId }) => requestId.endsWith(manifest.manifestId))).toBe(true)
    }

    for (const article of dataset.articles) {
      for (const field of FORBIDDEN_FIELDS) expect(article).not.toHaveProperty(field)
      expect(article).not.toHaveProperty('providerResponse')
      expect(article.provenance).toEqual(
        expect.arrayContaining([expect.objectContaining({ sourceId: article.sourceId })]),
      )
    }
  })

  it('keeps dry-run read-only and requires an explicit apply switch before persistence', async () => {
    const sources = realSources()
    const { registry } = connectorRegistry(sources)
    const context = memoryContext()
    const dataset = await buildDemoDataset({
      sources,
      connectorRegistry: registry,
      maxArticles: 50,
    })

    expect(parseSeedMode([])).toEqual({ apply: false })
    const dryRun = await seedDemo({ context, dataset, apply: false })

    expect(dryRun).toMatchObject({ dryRun: true, articles: 50 })
    expect(context.writes).toHaveLength(0)
    await expect(seedDemo({ context, dataset, apply: true })).resolves.toMatchObject({
      articles: { seeded: 50, existing: 0 },
    })
  })

  it('allows partial connector diagnostics only in dry-run and blocks apply below a source minimum', async () => {
    const sources = realSources()
    const { registry } = connectorRegistry(sources)
    const originalResolve = registry.resolve
    registry.resolve = vi.fn((sourceDocument) => {
      if (sourceDocument.connectorType === 'hacker-news') throw new Error('connector unavailable')
      return originalResolve(sourceDocument)
    })
    const partial = await buildDemoDataset({
      sources,
      connectorRegistry: registry,
      retrievedAt: RETRIEVED_AT,
      maxArticles: 50,
      allowSourceFailures: true,
    })

    await expect(seedDemo({ dataset: partial, apply: false })).resolves.toMatchObject({
      dryRun: true,
      sources: 2,
    })
    await expect(
      seedDemo({ context: memoryContext(), dataset: partial, apply: true }),
    ).rejects.toThrow(/every live source/i)
    await expect(
      buildDemoDataset({
        sources,
        connectorRegistry: registry,
        retrievedAt: RETRIEVED_AT,
        maxArticles: 50,
        allowSourceFailures: false,
      }),
    ).rejects.toThrow(/connector unavailable/i)

    const sparseRegistry = connectorRegistry(sources, 4)
    const sparse = await buildDemoDataset({
      sources,
      connectorRegistry: sparseRegistry.registry,
      retrievedAt: RETRIEVED_AT,
      maxArticles: 50,
    })
    await expect(
      seedDemo({ context: memoryContext(), dataset: sparse, apply: true }),
    ).rejects.toThrow(/minimum article count/i)
  })

  it('uses stable connector identities and insert-only persistence on repeated apply', async () => {
    const sources = realSources()
    const firstRegistry = connectorRegistry(sources)
    const dataset = await buildDemoDataset({
      sources,
      connectorRegistry: firstRegistry.registry,
      retrievedAt: RETRIEVED_AT,
      maxArticles: 50,
    })
    const context = memoryContext()

    await expect(applyDemoDataset({ context, dataset })).resolves.toMatchObject({
      articles: { seeded: 50, existing: 0 },
    })
    await expect(applyDemoDataset({ context, dataset })).resolves.toMatchObject({
      articles: { seeded: 0, existing: 50 },
    })

    const secondRegistry = connectorRegistry(sources)
    const rebuilt = await buildDemoDataset({
      sources,
      connectorRegistry: secondRegistry.registry,
      retrievedAt: RETRIEVED_AT,
      maxArticles: 50,
    })
    expect(rebuilt.articles).toEqual(dataset.articles)
    const sourceKeys = new Map(
      dataset.sources.map(({ _id, sourceKey }) => [_id.toHexString(), sourceKey]),
    )
    expect(dataset.articles.map(({ _id }) => _id.toHexString())).toEqual(
      dataset.articles.map(({ sourceId, externalId }) =>
        createHash('sha256')
          .update(
            `techpulse-real-demo-article\u0000${sourceKeys.get(sourceId.toHexString())}\u0000${externalId}`,
          )
          .digest()
          .subarray(0, 12)
          .toString('hex'),
      ),
    )
  })

  it('fails closed when an insert-only identity already has a different payload', async () => {
    const sources = realSources()
    const { registry } = connectorRegistry(sources)
    const dataset = await buildDemoDataset({
      sources,
      connectorRegistry: registry,
      retrievedAt: RETRIEVED_AT,
      maxArticles: 50,
    })
    const context = memoryContext()
    await applyDemoDataset({ context, dataset })
    const conflicting = {
      ...dataset,
      articles: dataset.articles.map((article, index) =>
        index === 0 ? { ...article, titleOriginal: `${article.titleOriginal} changed` } : article,
      ),
    }

    await expect(applyDemoDataset({ context, dataset: conflicting })).rejects.toThrow(
      /payload conflicts/i,
    )
  })

  it('treats later observation timestamps as an existing reset-safe fixture', async () => {
    const sources = realSources()
    const { registry } = connectorRegistry(sources)
    const dataset = await buildDemoDataset({
      sources,
      connectorRegistry: registry,
      retrievedAt: RETRIEVED_AT,
      maxArticles: 50,
    })
    const context = memoryContext()
    await applyDemoDataset({ context, dataset })
    const later = (date) => new Date(date.getTime() + 60_000)
    const observedLater = {
      ...dataset,
      sources: dataset.sources.map((item) => ({
        ...item,
        createdAt: later(item.createdAt),
        updatedAt: later(item.updatedAt),
        reviewedAt: later(item.reviewedAt),
        reconciliation: {
          ...item.reconciliation,
          requestedAt: later(item.reconciliation.requestedAt),
        },
        technicalCheck: {
          ...item.technicalCheck,
          checkedAt: later(item.technicalCheck.checkedAt),
          sampleCount: item.technicalCheck.sampleCount + 1,
        },
        health: { ...item.health, lastIngestSucceededAt: later(item.health.lastIngestSucceededAt) },
      })),
      articles: dataset.articles.map((item) => ({
        ...item,
        retrievedAt: later(item.retrievedAt),
        createdAt: later(item.createdAt),
        updatedAt: later(item.updatedAt),
        rightsSnapshot: {
          ...item.rightsSnapshot,
          capturedAt: later(item.rightsSnapshot.capturedAt),
        },
        provenance: item.provenance.map((entry) => ({
          ...entry,
          observedAt: later(entry.observedAt),
        })),
      })),
      audits: dataset.audits.map((item) => ({ ...item, createdAt: later(item.createdAt) })),
    }

    await expect(applyDemoDataset({ context, dataset: observedLater })).resolves.toMatchObject({
      sources: { seeded: 0, existing: 3 },
      articles: { seeded: 0, existing: 50 },
      audits: { seeded: 0, existing: 15 },
    })
  })
})

function actionsForLifecycle(audits) {
  return audits.map(({ action, stateTransition }) =>
    stateTransition ? `${action}:${stateTransition.from}:${stateTransition.to}` : action,
  )
}
