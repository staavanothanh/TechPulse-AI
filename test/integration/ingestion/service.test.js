import { describe, expect, it, vi } from 'vitest'
import { createIngestionService } from '../../../server/application/ingestion/service.js'
import { makeCandidate, makeJob, makeSource, RETRIEVED_AT } from '../../unit/articles/fixtures.js'

describe('ingestion article pipeline', () => {
  it('captures the expected policy/config before connector work and commits bounded candidates/checkpoint', async () => {
    const source = makeSource()
    const connector = { run: vi.fn(async () => ({ candidates: [makeCandidate()], retrievedAt: RETRIEVED_AT })) }
    const articleRepository = { commitIngestionBatch: vi.fn(async (input) => ({ created: input.candidates.length, updated: 0, duplicate: 0, skipped: 0 })) }
    const service = createIngestionService({ connectorRegistry: { resolve: vi.fn(() => connector) }, sourceRepository: { findSourceById: vi.fn(async () => source) }, articleRepository, now: () => RETRIEVED_AT })

    const result = await service.execute({ job: makeJob(), fence: { key: 'ingestion:source:507f1f77bcf86cd799439011', ownerTokenHash: 'a'.repeat(64), leaseGeneration: 1 }, payload: { body: 'bounded provider-free payload' } })

    expect(connector.run).toHaveBeenCalledWith(expect.objectContaining({ source, payload: { body: 'bounded provider-free payload' } }))
    expect(articleRepository.commitIngestionBatch).toHaveBeenCalledWith(expect.objectContaining({ job: makeJob(), expectedSourcePolicyVersion: 3, expectedConnectorConfig: source.connectorConfig, checkpoint: expect.objectContaining({ processedCount: 1 }) }))
    expect(result).toMatchObject({ created: 1 })
  })

  it('fails closed when policy/config changes after fetch and never advances article/checkpoint writes', async () => {
    const original = makeSource()
    const changed = makeSource({ policyVersion: 4, connectorConfig: { kind: 'rss', feedUrl: 'https://changed.example/feed.xml', batchSize: 20 } })
    const sourceRepository = { findSourceById: vi.fn().mockResolvedValueOnce(original).mockResolvedValueOnce(changed) }
    const articleRepository = { commitIngestionBatch: vi.fn() }
    const connector = { run: vi.fn(async () => ({ candidates: [makeCandidate()], retrievedAt: RETRIEVED_AT })) }
    const service = createIngestionService({ connectorRegistry: { resolve: vi.fn(() => connector) }, sourceRepository, articleRepository, now: () => RETRIEVED_AT })

    await expect(service.execute({ job: makeJob(), fence: { key: 'ingestion:source:507f1f77bcf86cd799439011', ownerTokenHash: 'a'.repeat(64), leaseGeneration: 1 } })).rejects.toMatchObject({ code: 'policy_version_mismatch' })
    expect(articleRepository.commitIngestionBatch).not.toHaveBeenCalled()
  })

  it('rejects blocked/review-needed sources before connector invocation', async () => {
    const connector = { run: vi.fn() }
    const service = createIngestionService({ connectorRegistry: { resolve: vi.fn(() => connector) }, sourceRepository: { findSourceById: vi.fn(async () => makeSource({ licenseStatus: 'review-needed', operationalStatus: 'paused', llmInputScope: 'none', storageScope: { metadata: false, excerpt: false, summary: false, embedding: false } })) }, articleRepository: { commitIngestionBatch: vi.fn() }, now: () => RETRIEVED_AT })

    await expect(service.execute({ job: makeJob(), fence: { key: 'ingestion:source:507f1f77bcf86cd799439011', ownerTokenHash: 'a'.repeat(64), leaseGeneration: 1 } })).rejects.toMatchObject({ code: 'source_policy_blocked' })
    expect(connector.run).not.toHaveBeenCalled()
  })
})
