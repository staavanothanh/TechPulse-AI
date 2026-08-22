import { describe, expect, it, vi } from 'vitest'
import { createLiveConnectorRegistry } from '../../../server/connectors/live-registry.js'
import { createConfiguredIngestionExecutor } from '../../../server/bootstrap/ingestion.js'

const RETRIEVED_AT = new Date('2026-08-23T00:00:00.000Z')

function source(overrides = {}) {
  return {
    id: '507f1f77bcf86cd799439011',
    sourceKey: 'rss:test',
    connectorType: 'rss',
    accessMethod: 'rss',
    authorityTier: 'editorial',
    connectorConfig: { kind: 'rss', feedUrl: 'https://example.com/feed.xml', batchSize: 20 },
    ...overrides,
  }
}

function response(contentType, body) {
  return { statusCode: 200, contentType, resolvedHost: 'example.com', body: Buffer.from(body) }
}

describe('live ingestion runtime adapters', () => {
  it('fetches RSS payloads through safe-fetch before parsing', async () => {
    const safeFetch = vi.fn(async () =>
      response(
        'application/rss+xml',
        '<rss><channel><item><title>Runtime test</title><link>https://example.com/a</link></item></channel></rss>',
      ),
    )
    const registry = createLiveConnectorRegistry({ safeFetch, now: () => RETRIEVED_AT })

    const result = await registry
      .resolve(source())
      .run({ source: source(), retrievedAt: RETRIEVED_AT })

    expect(safeFetch).toHaveBeenCalledWith(
      'https://example.com/feed.xml',
      expect.objectContaining({
        allowedContentTypes: expect.arrayContaining(['application/rss+xml']),
      }),
    )
    expect(result.candidates).toHaveLength(1)
  })

  it('fetches API connector payloads through safe-fetch', async () => {
    const safeFetch = vi.fn(async (url) =>
      url.includes('arxiv')
        ? response(
            'application/atom+xml',
            '<feed xmlns="http://www.w3.org/2005/Atom"><opensearch:totalResults xmlns:opensearch="http://a9.com/-/spec/opensearch/1.1/">1</opensearch:totalResults><opensearch:startIndex xmlns:opensearch="http://a9.com/-/spec/opensearch/1.1/">0</opensearch:startIndex><entry><id>http://arxiv.org/abs/1234.5678</id><title>Runtime test</title><published>2026-08-22T00:00:00Z</published></entry></feed>',
          )
        : url.endsWith('/topstories.json')
          ? response('application/json', '[123]')
          : response(
              'application/json',
              '{"id":123,"type":"story","title":"Runtime test","time":1724284800,"url":"https://example.com/story"}',
            ),
    )
    const registry = createLiveConnectorRegistry({ safeFetch, now: () => RETRIEVED_AT })

    const arxivSource = source({
      sourceKey: 'arxiv:test',
      connectorType: 'arxiv',
      accessMethod: 'api',
      authorityTier: 'primary',
      connectorConfig: { kind: 'arxiv', arxivQuery: 'cat:cs.AI', batchSize: 1 },
    })
    const hackerNewsSource = source({
      sourceKey: 'hacker-news:test',
      connectorType: 'hacker-news',
      accessMethod: 'api',
      authorityTier: 'community-signal',
      connectorConfig: { kind: 'hacker-news', hackerNewsStream: 'topstories', batchSize: 1 },
    })

    await expect(
      registry
        .resolve(arxivSource)
        .run({ source: arxivSource, retrievedAt: RETRIEVED_AT, maxPages: 1, maxResults: 1 }),
    ).resolves.toMatchObject({ candidates: expect.any(Array) })
    await expect(
      registry
        .resolve(hackerNewsSource)
        .run({ source: hackerNewsSource, retrievedAt: RETRIEVED_AT }),
    ).resolves.toMatchObject({ candidates: expect.any(Array) })
    expect(safeFetch).toHaveBeenCalledTimes(3)
  })

  it('creates an ingestion executor that delegates to the fenced ingestion service', async () => {
    const commitIngestionBatch = vi.fn(async () => ({
      status: 'succeeded',
      counters: { fetched: 1 },
      checkpoint: { processedCount: 1 },
    }))
    const currentSource = source({
      operationalStatus: 'active',
      licenseStatus: 'metadata-only',
      policyVersion: 1,
      technicalCheck: { status: 'passed' },
      llmInputScope: 'metadata',
      storageScope: { metadata: true, excerpt: false, summary: false, embedding: false },
      mediaPolicy: {
        imageMode: 'none',
        videoMode: 'none',
        allowedHosts: [],
        attributionRequired: false,
      },
      name: 'Test source',
      publisherName: 'Test publisher',
      domain: 'example.com',
    })
    const executor = createConfiguredIngestionExecutor({
      sourceRepository: { findSourceById: vi.fn(async () => currentSource) },
      articleRepository: { commitIngestionBatch },
      currentSourcePolicy: { content: vi.fn(async () => ({ allowed: true, policyVersion: 1 })) },
      safeFetch: vi.fn(async () =>
        response(
          'application/rss+xml',
          '<rss><channel><item><title>Runtime test</title><link>https://example.com/a</link><pubDate>Sat, 22 Aug 2026 00:00:00 GMT</pubDate></item></channel></rss>',
        ),
      ),
      now: () => RETRIEVED_AT,
    })

    await expect(
      executor({
        job: {
          id: '507f1f77bcf86cd799439012',
          sourceId: currentSource.id,
          connectorType: 'rss',
          expectedSourcePolicyVersion: 1,
          expectedConnectorConfig: currentSource.connectorConfig,
          checkpoint: {},
        },
        fence: {
          key: `ingestion:source:${currentSource.id}`,
          ownerTokenHash: 'a'.repeat(64),
          leaseGeneration: 1,
        },
        now: RETRIEVED_AT,
      }),
    ).resolves.toMatchObject({ status: 'succeeded' })
    expect(commitIngestionBatch).toHaveBeenCalledOnce()
  })

  it('bounds live connector execution to one page per leased job', async () => {
    const connectorRun = vi.fn(async () => ({ candidates: [] }))
    const currentSource = source({
      operationalStatus: 'active',
      licenseStatus: 'metadata-only',
      policyVersion: 1,
      technicalCheck: { status: 'passed' },
      llmInputScope: 'metadata',
      storageScope: { metadata: true, excerpt: false, summary: false, embedding: false },
      mediaPolicy: { imageMode: 'none', videoMode: 'none', allowedHosts: [], attributionRequired: false },
      name: 'Test source', publisherName: 'Test publisher', domain: 'example.com',
    })
    const executor = createConfiguredIngestionExecutor({
      sourceRepository: { findSourceById: vi.fn(async () => currentSource) },
      articleRepository: { commitIngestionBatch: vi.fn(async () => ({ counters: {}, checkpoint: { processedCount: 0 } })) },
      connectorRegistry: { resolve: () => ({ run: connectorRun }) },
      currentSourcePolicy: { content: vi.fn(async () => ({ allowed: true, policyVersion: 1 })) },
    })

    await executor({
      job: { id: '507f1f77bcf86cd799439012', sourceId: currentSource.id, connectorType: 'rss', batchSize: 30, checkpoint: {} },
      fence: { key: `ingestion:source:${currentSource.id}`, ownerTokenHash: 'a'.repeat(64), leaseGeneration: 1 },
      now: RETRIEVED_AT,
    })

    expect(connectorRun).toHaveBeenCalledWith(expect.objectContaining({ maxResults: 30, maxPages: 1 }))
  })

  it('rejects an ingestion commit result without counters and checkpoint', async () => {
    const currentSource = source({
      operationalStatus: 'active', licenseStatus: 'metadata-only', policyVersion: 1, technicalCheck: { status: 'passed' },
      llmInputScope: 'metadata', storageScope: { metadata: true, excerpt: false, summary: false, embedding: false },
      mediaPolicy: { imageMode: 'none', videoMode: 'none', allowedHosts: [], attributionRequired: false },
      name: 'Test source', publisherName: 'Test publisher', domain: 'example.com',
    })
    const executor = createConfiguredIngestionExecutor({
      sourceRepository: { findSourceById: vi.fn(async () => currentSource) },
      articleRepository: { commitIngestionBatch: vi.fn(async () => ({ status: 'succeeded' })) },
      connectorRegistry: { resolve: () => ({ run: vi.fn(async () => ({ candidates: [] })) }) },
      currentSourcePolicy: { content: vi.fn(async () => ({ allowed: true, policyVersion: 1 })) },
    })

    await expect(executor({
      job: { id: '507f1f77bcf86cd799439012', sourceId: currentSource.id, connectorType: 'rss', batchSize: 20, checkpoint: {} },
      fence: { key: `ingestion:source:${currentSource.id}`, ownerTokenHash: 'a'.repeat(64), leaseGeneration: 1 },
      now: RETRIEVED_AT,
    })).rejects.toMatchObject({ code: 'worker_outcome_invalid' })
  })
})
