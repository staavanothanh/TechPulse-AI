import { describe, expect, it } from 'vitest'
import { ObjectId } from 'mongodb'
import { articleDocument, serializeArticle } from '../../../server/repositories/mongo/article-repository.js'
import { REMOVED_ARTICLE_TOMBSTONE_FIELDS, validateRemovedArticleTombstone } from '../../../server/domain/article/removed-tombstone.js'
import { buildArticleGovernanceHardeningMigration } from '../../../scripts/migrations/article-governance-hardening.js'

const articleId = new ObjectId('507f1f77bcf86cd799439001')
const sourceId = new ObjectId('507f1f77bcf86cd799439002')
const removedAt = new Date('2026-08-14T00:00:00.000Z')

function removedDocument(overrides = {}) {
  return {
    _id: articleId,
    sourceId,
    connectorType: 'rss',
    externalId: 'opaque-external-id',
    externalIdVersion: 'v1',
    status: 'removed',
    evidenceEligible: false,
    removalPolicyVersion: 4,
    removedAt,
    createdAt: new Date('2026-08-01T00:00:00.000Z'),
    updatedAt: removedAt,
    titleOriginal: 'Khong duoc giu lai',
    titleVi: 'Khong duoc giu lai',
    originalUrl: 'https://private.example/article',
    canonicalUrl: 'https://private.example/article',
    canonicalUrlHash: 'a'.repeat(64),
    author: 'Private author',
    provenance: [{ sourceId, originalUrl: 'https://private.example/article', observedAt: removedAt }],
    excerptOriginal: 'Private excerpt',
    searchTextNormalized: 'private search',
    leadMedia: { type: 'image', url: 'https://private.example/image.jpg' },
    summaryVi: 'Private summary',
    embedding: [0.1, 0.2],
    ...overrides,
  }
}

describe('removed article tombstone authority', () => {
  it('serializes only the closed tombstone shape', () => {
    const serialized = serializeArticle(removedDocument())
    expect(Object.keys(serialized).sort()).toEqual([...REMOVED_ARTICLE_TOMBSTONE_FIELDS].map((field) => field === '_id' ? 'id' : field).sort())
    expect(serialized).toEqual(expect.objectContaining({
      id: articleId.toHexString(),
      sourceId: sourceId.toHexString(),
      connectorType: 'rss',
      externalId: 'opaque-external-id',
      externalIdVersion: 'v1',
      canonicalUrlHash: 'a'.repeat(64),
      status: 'removed',
      evidenceEligible: false,
      removalPolicyVersion: 4,
    }))
    for (const field of ['titleOriginal', 'titleVi', 'originalUrl', 'canonicalUrl', 'author', 'provenance', 'excerptOriginal', 'searchTextNormalized', 'leadMedia', 'summaryVi', 'embedding']) expect(serialized).not.toHaveProperty(field)
  })

  it('builds a Mongo-valid tombstone from a removed article with private metadata', () => {
    const tombstone = articleDocument(removedDocument())
    expect(validateRemovedArticleTombstone(tombstone)).toEqual({ valid: true, errors: [] })
    expect(Object.keys(tombstone).sort()).toEqual([...REMOVED_ARTICLE_TOMBSTONE_FIELDS].sort())
    expect(tombstone).not.toHaveProperty('titleOriginal')
    expect(tombstone).not.toHaveProperty('originalUrl')
    expect(tombstone).not.toHaveProperty('provenance')
    expect(tombstone.canonicalUrlHash).toBe('a'.repeat(64))
  })

  it('publishes a migration branch without changing the committed articles migration', () => {
    const plan = buildArticleGovernanceHardeningMigration({ dryRun: true })
    expect(plan).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'collMod', collection: 'articles', dryRun: true }),
    ]))
    expect(plan.some((operation) => operation.type === 'dropCollection' || operation.type === 'deleteMany')).toBe(false)
    expect(plan[0].validator.$or[0]).toEqual(expect.objectContaining({ $and: expect.arrayContaining([{ status: { $ne: 'removed' } }]) }))
    expect(plan[0].validator.$or[1].$jsonSchema.additionalProperties).toBe(false)
  })
})
