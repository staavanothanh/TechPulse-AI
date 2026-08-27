import { describe, expect, it, vi } from 'vitest'
import { createMediaBackfillWorker } from '../../../server/application/media/backfill.js'
import { createLiveConnectorRegistry } from '../../../server/connectors/live-registry.js'
import { makeCandidate, makeSource, RETRIEVED_AT } from '../articles/fixtures.js'

function source(overrides = {}) {
  return makeSource({
    sourceKey: 'rss:example',
    mediaPolicy: {
      imageMode: 'remote-preview',
      videoMode: 'none',
      allowedHosts: ['cdn.example.com'],
      attributionRequired: false,
      evidenceNote: null,
    },
    ...overrides,
  })
}

describe('media backfill worker', () => {
  it('skips an inactive or technically unreviewed source before it fetches the feed', async () => {
    const connectorRegistry = { resolve: vi.fn() }
    const articleRepository = { backfillLeadMediaCandidates: vi.fn() }
    const worker = createMediaBackfillWorker({
      connectorRegistry,
      sourceRepository: {
        findSourceByKey: vi.fn(async () => source({ operationalStatus: 'paused' })),
        findSourceById: vi.fn(),
      },
      articleRepository,
      now: () => RETRIEVED_AT,
    })

    await expect(worker.run({ sourceKey: 'rss:example', dryRun: true })).resolves.toMatchObject({
      outcome: 'skipped',
      fetched: 0,
      inspected: 0,
      updated: 0,
      skipped: 1,
      skippedReasons: { source_not_eligible: 1 },
    })
    expect(connectorRegistry.resolve).not.toHaveBeenCalled()
    expect(articleRepository.backfillLeadMediaCandidates).not.toHaveBeenCalled()
  })

  it('skips a source with no enabled media policy before it fetches the reviewed feed', async () => {
    const connectorRegistry = { resolve: vi.fn() }
    const articleRepository = { backfillLeadMediaCandidates: vi.fn() }
    const worker = createMediaBackfillWorker({
      connectorRegistry,
      sourceRepository: {
        findSourceByKey: vi.fn(async () => source({ mediaPolicy: { imageMode: 'none', videoMode: 'none', allowedHosts: [], attributionRequired: false, evidenceNote: null } })),
        findSourceById: vi.fn(),
      },
      articleRepository,
      now: () => RETRIEVED_AT,
    })

    await expect(worker.run({ sourceKey: 'rss:example', dryRun: true })).resolves.toMatchObject({
      outcome: 'skipped',
      fetched: 0,
      inspected: 0,
      updated: 0,
      skipped: 1,
      skippedReasons: { media_policy_disabled: 1 },
    })
    expect(connectorRegistry.resolve).not.toHaveBeenCalled()
    expect(articleRepository.backfillLeadMediaCandidates).not.toHaveBeenCalled()
  })

  it('reports a dedicated skip when the source media mode is enabled but its exact allowlist is empty', async () => {
    const connectorRegistry = { resolve: vi.fn() }
    const articleRepository = { backfillLeadMediaCandidates: vi.fn() }
    const worker = createMediaBackfillWorker({
      connectorRegistry,
      sourceRepository: {
        findSourceByKey: vi.fn(async () => source({ mediaPolicy: { imageMode: 'remote-preview', videoMode: 'none', allowedHosts: [], attributionRequired: false, evidenceNote: null } })),
        findSourceById: vi.fn(),
      },
      articleRepository,
      now: () => RETRIEVED_AT,
    })

    await expect(worker.run({ sourceKey: 'rss:example', dryRun: true })).resolves.toMatchObject({
      outcome: 'skipped',
      skippedReasons: { media_policy_disabled: 1 },
    })
    expect(connectorRegistry.resolve).not.toHaveBeenCalled()
  })

  it('rechecks the current source after the feed worker runs and does not commit after policy drift', async () => {
    const captured = source()
    const connector = { run: vi.fn(async () => ({ candidates: [makeCandidate()] })) }
    const articleRepository = { backfillLeadMediaCandidates: vi.fn() }
    const worker = createMediaBackfillWorker({
      connectorRegistry: { resolve: vi.fn(() => connector) },
      sourceRepository: {
        findSourceByKey: vi.fn(async () => captured),
        findSourceById: vi.fn(async () => ({ ...captured, policyVersion: captured.policyVersion + 1 })),
      },
      articleRepository,
      now: () => RETRIEVED_AT,
    })

    await expect(worker.run({ sourceKey: 'rss:example', dryRun: false })).resolves.toMatchObject({
      outcome: 'skipped',
      fetched: 1,
      updated: 0,
      skipped: 1,
      skippedReasons: { source_policy_changed: 1 },
    })
    expect(articleRepository.backfillLeadMediaCandidates).not.toHaveBeenCalled()
  })

  it('reports a redacted connector failure and does not attempt a repository write', async () => {
    const captured = source()
    const connector = { run: vi.fn(async () => { const error = new Error('https://secret.example/feed?token=value'); error.code = 'source_fetch_timeout'; throw error }) }
    const articleRepository = { backfillLeadMediaCandidates: vi.fn() }
    const worker = createMediaBackfillWorker({
      connectorRegistry: { resolve: vi.fn(() => connector) },
      sourceRepository: {
        findSourceByKey: vi.fn(async () => captured),
        findSourceById: vi.fn(),
      },
      articleRepository,
      now: () => RETRIEVED_AT,
    })

    const result = await worker.run({ sourceKey: 'rss:example', dryRun: true })

    expect(result).toMatchObject({ outcome: 'failed', fetched: 0, failed: 1, failedReasons: { source_fetch_timeout: 1 } })
    expect(JSON.stringify(result)).not.toContain('https://')
    expect(articleRepository.backfillLeadMediaCandidates).not.toHaveBeenCalled()
  })

  it('uses only the resolved source connector and passes a bounded dry-run request to the repository', async () => {
    const active = source()
    const connector = { run: vi.fn(async () => ({ candidates: [makeCandidate(), makeCandidate({ externalId: 'item-2' })] })) }
    const articleRepository = {
      backfillLeadMediaCandidates: vi.fn(async () => ({ inspected: 1, updated: 0, wouldUpdate: 1, skipped: 1, failed: 0, skippedReasons: { no_matching_article: 1 }, failedReasons: {} })),
    }
    const worker = createMediaBackfillWorker({
      connectorRegistry: { resolve: vi.fn(() => connector) },
      sourceRepository: {
        findSourceByKey: vi.fn(async () => active),
        findSourceById: vi.fn(async () => active),
      },
      articleRepository,
      now: () => RETRIEVED_AT,
    })

    const result = await worker.run({ sourceKey: 'rss:example', dryRun: true, limit: 1 })

    expect(connector.run).toHaveBeenCalledWith(expect.objectContaining({ source: active, retrievedAt: RETRIEVED_AT }))
    expect(articleRepository.backfillLeadMediaCandidates).toHaveBeenCalledWith(expect.objectContaining({
      source: active,
      expectedSourcePolicyVersion: active.policyVersion,
      expectedConnectorConfig: active.connectorConfig,
      candidates: [makeCandidate()],
      dryRun: true,
      limit: 1,
    }))
    expect(result).toMatchObject({ outcome: 'completed', fetched: 2, inspected: 1, wouldUpdate: 1, skipped: 1 })
  })

  it('runs the approved RSS connector contract through safe-fetch without fetching an article or media URL', async () => {
    const active = source()
    const feed = 'https://example.com/feed.xml'
    const articleRepository = {
      backfillLeadMediaCandidates: vi.fn(async () => ({ inspected: 1, updated: 0, wouldUpdate: 1, skipped: 0, failed: 0, skippedReasons: {}, failedReasons: {} })),
    }
    const safeFetch = vi.fn(async (url) => ({
      contentType: 'application/rss+xml',
      url,
      body: Buffer.from(`
        <rss version="2.0"><channel><item>
          <title>Approved feed item</title><link>https://example.com/articles/1</link><guid>item-1</guid>
          <pubDate>Wed, 27 Aug 2026 00:00:00 GMT</pubDate>
          <description><![CDATA[<img src="https://cdn.example.com/images/one.jpg" alt="Approved metadata">]]></description>
        </item></channel></rss>`),
    }))
    const worker = createMediaBackfillWorker({
      connectorRegistry: createLiveConnectorRegistry({ safeFetch, now: () => RETRIEVED_AT }),
      sourceRepository: {
        findSourceByKey: vi.fn(async () => active),
        findSourceById: vi.fn(async () => active),
      },
      articleRepository,
      now: () => RETRIEVED_AT,
    })

    await expect(worker.run({ sourceKey: active.sourceKey, dryRun: true, limit: 1 })).resolves.toMatchObject({ outcome: 'completed', fetched: 1, wouldUpdate: 1 })
    expect(safeFetch).toHaveBeenCalledTimes(1)
    expect(safeFetch).toHaveBeenCalledWith(feed, expect.objectContaining({ allowedContentTypes: expect.arrayContaining(['application/rss+xml']) }))
    expect(articleRepository.backfillLeadMediaCandidates).toHaveBeenCalledWith(expect.objectContaining({
      candidates: [expect.objectContaining({ originalUrl: 'https://example.com/articles/1', mediaCandidate: expect.objectContaining({ url: 'https://cdn.example.com/images/one.jpg' }) })],
    }))
  })
})
