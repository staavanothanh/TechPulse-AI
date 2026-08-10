import { ObjectId } from 'mongodb'
import { describe, expect, it, vi } from 'vitest'
import { MongoSourceRepository, serializeSource } from '../../../server/repositories/mongo/source-repository.js'

function sourceDocument(overrides = {}) {
  const now = new Date('2026-08-10T00:00:00.000Z')
  return {
    _id: new ObjectId(), name: 'Example', sourceKey: 'rss:example', publisherName: 'Example', domain: 'example.com', connectorType: 'rss', accessMethod: 'rss', authorityTier: 'editorial', connectorConfig: { kind: 'rss', feedUrl: 'https://example.com/feed.xml', batchSize: 20 },
    operationalStatus: 'draft', licenseStatus: 'review-needed', llmInputScope: 'none', storageScope: { metadata: false, excerpt: false, summary: false, embedding: false }, mediaPolicy: { imageMode: 'none', videoMode: 'none', allowedHosts: [], attributionRequired: false, evidenceNote: null }, attributionRequired: false, attributionText: null, termsUrl: null, licenseUrl: null, evidenceNote: null, reviewedAt: null, reviewedBy: null, policyVersion: 1,
    reconciliation: { status: 'idle', requiredPolicyVersion: 1, completedPolicyVersion: null, requestedAt: null, error: null }, technicalCheck: { status: 'not-run', checkedAt: null, contentType: null, resolvedHost: null, sampleCount: null, error: null }, health: { lastIngestSucceededAt: null, lastIngestFailedAt: null, consecutiveFailures: 0, lastError: null }, createdAt: now, updatedAt: now,
    ...overrides,
  }
}

function repositoryWith(documents = []) {
  const cursor = {
    sort: vi.fn(() => cursor),
    limit: vi.fn(() => cursor),
    toArray: vi.fn(async () => documents),
  }
  const collection = { find: vi.fn(() => cursor), findOne: vi.fn(async () => documents[0] ?? null) }
  return { repository: new MongoSourceRepository({ db: { collection: vi.fn(() => collection) }, client: {} }), collection, cursor }
}

describe('Mongo Source repository input and pagination boundary', () => {
  it('serializes documents and produces a validated opaque cursor', async () => {
    const documents = [sourceDocument(), sourceDocument({ sourceKey: 'rss:second' })]
    const { repository, collection } = repositoryWith(documents)
    const first = await repository.listSources({ limit: '1', operationalStatus: 'draft', licenseStatus: 'review-needed', connectorType: 'rss' })
    expect(first).toEqual(expect.objectContaining({ hasNext: true, nextCursor: expect.any(String) }))
    expect(first.sources[0].id).toBe(documents[0]._id.toHexString())
    await repository.listSources({ limit: 1, cursor: first.nextCursor })
    expect(collection.find).toHaveBeenCalledWith(expect.objectContaining({ $or: expect.any(Array) }))
    expect(serializeSource(null)).toBeNull()
  })

  it.each([
    [{ limit: 0 }, /limit/i],
    [{ limit: 101 }, /limit/i],
    [{ operationalStatus: 'unknown' }, /operationalStatus/i],
    [{ licenseStatus: 'unknown' }, /licenseStatus/i],
    [{ connectorType: 'unknown' }, /connectorType/i],
    [{ cursor: 'invalid' }, /cursor/i],
    [{ cursor: 'x'.repeat(1001) }, /cursor/i],
  ])('rejects malformed list query %j before Mongo execution', async (query, message) => {
    const { repository, collection } = repositoryWith()
    await expect(repository.listSources(query)).rejects.toThrow(message)
    expect(collection.find).not.toHaveBeenCalled()
  })

  it('rejects malformed identifiers and non-advancing replacement fences', async () => {
    expect(() => new MongoSourceRepository()).toThrow(/context/i)
    const { repository } = repositoryWith()
    await expect(repository.findSourceById('not-an-object-id')).rejects.toThrow(/identifier/i)
    const source = serializeSource(sourceDocument())
    await expect(repository.commitReplacement({ source, expectedUpdatedAt: source.updatedAt, expectedPolicyVersion: source.policyVersion, audit: {}, actorFence: {} })).rejects.toMatchObject({ code: 'source_validation' })
  })
})
