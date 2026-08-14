import { describe, expect, it } from 'vitest'
import { ObjectId } from 'mongodb'
import { MongoTakedownRepository } from '../../../server/repositories/mongo/takedown-repository.js'
import { REMOVED_ARTICLE_TOMBSTONE_FIELDS, validateRemovedArticleTombstone } from '../../../server/domain/article/removed-tombstone.js'
import { createStep11Mongo } from '../../helpers/step11-mongo.js'

const now = new Date('2026-08-14T00:00:00.000Z')
const sourceId = new ObjectId('507f1f77bcf86cd799439701')

function article(id, overrides = {}) {
  return {
    _id: id,
    sourceId,
    connectorType: 'rss',
    externalId: `external-${id.toHexString()}`,
    externalIdVersion: 'v1',
    status: 'hidden',
    evidenceEligible: false,
    removalPolicyVersion: 4,
    createdAt: new Date('2026-08-01T00:00:00.000Z'),
    updatedAt: now,
    titleOriginal: 'Private title',
    titleVi: 'Tieu de rieng tu',
    originalUrl: 'https://private.example/article',
    canonicalUrl: 'https://private.example/article',
    canonicalUrlHash: 'a'.repeat(64),
    author: 'Private author',
    provenance: [{ sourceId, originalUrl: 'https://private.example/article', observedAt: now }],
    excerptOriginal: 'Private excerpt',
    searchTextNormalized: 'private search',
    leadMedia: { type: 'image', url: 'https://private.example/image.jpg' },
    leadMediaStatus: 'available',
    summaryVi: 'Private summary',
    summaryStatus: 'ready',
    summaryBasis: 'metadata',
    embedding: [0.1, 0.2],
    embeddingStatus: 'ready',
    ...overrides,
  }
}

function repository({ articles, sources = [{ _id: sourceId, operationalStatus: 'paused', policyVersion: 5, updatedAt: now }] } = {}) {
  const mongo = createStep11Mongo({ app: { articles, sources, chatSessions: [] } })
  const instance = new MongoTakedownRepository({
    db: mongo.db,
    client: mongo.client,
    governanceDb: mongo.governanceDb,
    governanceKeyring: { currentVersion: 1, digest: (value) => value },
    now: () => now,
  })
  return { mongo, repository: instance }
}

function expectClosedTombstone(document) {
  expect(validateRemovedArticleTombstone(document)).toEqual({ valid: true, errors: [] })
  expect(Object.keys(document).sort()).toEqual([...REMOVED_ARTICLE_TOMBSTONE_FIELDS].sort())
  for (const field of ['titleOriginal', 'titleVi', 'originalUrl', 'canonicalUrl', 'author', 'provenance', 'excerptOriginal', 'searchTextNormalized', 'leadMedia', 'leadMediaStatus', 'summaryVi', 'summaryStatus', 'summaryBasis', 'embedding', 'embeddingStatus']) {
    expect(document).not.toHaveProperty(field)
  }
  expect(document.canonicalUrlHash).toMatch(/^[a-f0-9]{64}$/)
}

describe('takedown article metadata tombstones', () => {
  it('physically replaces each article target and reports completion only at target zero-state', async () => {
    const firstId = new ObjectId('507f1f77bcf86cd799439702')
    const secondId = new ObjectId('507f1f77bcf86cd799439703')
    const fixture = repository({ articles: [article(firstId), article(secondId)] })

    const first = await fixture.repository.cleanupArtifacts({ targetType: 'article', targetIds: [firstId, secondId], requestedScope: ['metadata'], session: {}, now, limit: 1 })
    expect(first).toEqual(expect.objectContaining({ metadataRemoved: false, historicalChatCitationsRedacted: false, hasMore: true }))
    const afterFirst = await fixture.mongo.db.collection('articles').find({}).sort({ _id: 1 }).toArray()
    expectClosedTombstone(afterFirst[0])
    expect(afterFirst[1]).toEqual(expect.objectContaining({ status: 'hidden', titleOriginal: 'Private title' }))

    const second = await fixture.repository.cleanupArtifacts({ targetType: 'article', targetIds: [firstId, secondId], requestedScope: ['metadata'], session: {}, now, limit: 1 })
    expect(second).toEqual(expect.objectContaining({ metadataRemoved: true, historicalChatCitationsRedacted: true, hasMore: false }))
    const afterSecond = await fixture.mongo.db.collection('articles').find({}).sort({ _id: 1 }).toArray()
    afterSecond.forEach(expectClosedTombstone)
  })

  it('processes every source article in bounded pages before setting metadataRemoved', async () => {
    const articleIds = [
      new ObjectId('507f1f77bcf86cd799439704'),
      new ObjectId('507f1f77bcf86cd799439705'),
      new ObjectId('507f1f77bcf86cd799439706'),
    ]
    const fixture = repository({ articles: articleIds.map((id) => article(id)) })

    const first = await fixture.repository.cleanupArtifacts({ targetType: 'source', targetIds: [sourceId], requestedScope: ['metadata'], session: {}, now, limit: 2 })
    expect(first).toEqual(expect.objectContaining({ metadataRemoved: false, historicalChatCitationsRedacted: false, hasMore: true }))
    const afterFirst = await fixture.mongo.db.collection('articles').find({}).sort({ _id: 1 }).toArray()
    expect(afterFirst.slice(0, 2)).toHaveLength(2)
    afterFirst.slice(0, 2).forEach(expectClosedTombstone)
    expect(afterFirst[2]).toEqual(expect.objectContaining({ status: 'hidden', titleOriginal: 'Private title' }))

    const second = await fixture.repository.cleanupArtifacts({ targetType: 'source', targetIds: [sourceId], requestedScope: ['metadata'], session: {}, now, limit: 2 })
    expect(second).toEqual(expect.objectContaining({ metadataRemoved: true, historicalChatCitationsRedacted: true, hasMore: false }))
    const afterSecond = await fixture.mongo.db.collection('articles').find({}).sort({ _id: 1 }).toArray()
    afterSecond.forEach(expectClosedTombstone)
  })
})
