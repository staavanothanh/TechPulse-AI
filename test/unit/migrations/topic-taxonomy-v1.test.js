import { describe, expect, it, vi } from 'vitest'
import { ObjectId } from 'mongodb'
import {
  TOPIC_TAXONOMY_ARTICLE_VALIDATOR,
  TOPIC_TAXONOMY_USERS_VALIDATOR,
  TOPIC_TAXONOMY_ARTICLE_INDEXES,
  buildTopicTaxonomyMigration,
  runTopicTaxonomyMigration,
  runTopicTaxonomyBackfill,
} from '../../../scripts/migrations/topic-taxonomy-v1.js'
import { SUMMARY_DETAIL_ARTICLE_VALIDATOR } from '../../../scripts/migrations/summary-detail-v1.js'
import { GOOGLE_OAUTH_USERS_VALIDATOR } from '../../../scripts/migrations/google-oauth.js'
import { AUTH_CORE_COLLECTIONS } from '../../../scripts/migrations/auth-core.js'
import { RUNTIME_SCHEMA_GENERATIONS } from '../../../server/bootstrap/schema-readiness.js'

describe('topic-taxonomy-v1 migration contract', () => {
  it('builds a non-destructive forward-only migration plan with strict paired shadow fields', () => {
    const plan = buildTopicTaxonomyMigration({ dryRun: true })

    expect(plan.length).toBeGreaterThan(0)
    expect(plan.every((operation) => !operation.type.startsWith('drop'))).toBe(true)
    expect(RUNTIME_SCHEMA_GENERATIONS['topic-taxonomy-v1']).toBe('topic-taxonomy-v1')

    // Active article branch has topicIds and topicTaxonomyVersion
    const articleActiveSchema = TOPIC_TAXONOMY_ARTICLE_VALIDATOR.$or[0].$and[0].$jsonSchema
    expect(articleActiveSchema.properties.topicIds).toEqual(
      expect.objectContaining({
        bsonType: 'array',
        uniqueItems: true,
        maxItems: 50,
      }),
    )
    expect(articleActiveSchema.properties.topicTaxonomyVersion).toEqual(
      expect.objectContaining({
        bsonType: 'int',
        minimum: 1,
      }),
    )
    expect(articleActiveSchema.required).toEqual(expect.arrayContaining(['topicIds', 'topicTaxonomyVersion']))

    // Removed article tombstone schema remains strictly closed
    const articleTombstoneSchema = TOPIC_TAXONOMY_ARTICLE_VALIDATOR.$or[1].$jsonSchema
    expect(articleTombstoneSchema.additionalProperties).toBe(false)
    expect(articleTombstoneSchema.properties).not.toHaveProperty('topicIds')
    expect(articleTombstoneSchema.properties).not.toHaveProperty('topicTaxonomyVersion')
    expect(articleTombstoneSchema.properties).not.toHaveProperty('topics')

    // Active user schema has topicPreferenceIds and topicPreferenceTaxonomyVersion
    const userActiveSchema = TOPIC_TAXONOMY_USERS_VALIDATOR.$or[0].$jsonSchema
    expect(userActiveSchema.properties.topicPreferenceIds).toEqual(
      expect.objectContaining({
        bsonType: 'array',
        uniqueItems: true,
        maxItems: 20,
      }),
    )
    expect(userActiveSchema.properties.topicPreferenceTaxonomyVersion).toEqual(
      expect.objectContaining({
        bsonType: 'int',
        minimum: 1,
      }),
    )
    expect(userActiveSchema.required).toEqual(expect.arrayContaining(['topicPreferenceIds', 'topicPreferenceTaxonomyVersion']))

    // Deleted user tombstone schema remains strictly closed
    const userDeletedSchema = TOPIC_TAXONOMY_USERS_VALIDATOR.$or[1].$jsonSchema
    expect(userDeletedSchema.additionalProperties).toBe(false)
    expect(userDeletedSchema.properties).not.toHaveProperty('topicPreferences')
    expect(userDeletedSchema.properties).not.toHaveProperty('topicPreferenceIds')
    expect(userDeletedSchema.properties).not.toHaveProperty('topicPreferenceTaxonomyVersion')

    // Additive canonical index definition
    expect(TOPIC_TAXONOMY_ARTICLE_INDEXES).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          key: expect.objectContaining({ status: 1, topicIds: 1 }),
        }),
      ]),
    )
  })

  it('refuses strict cutover without an explicit writer pause', async () => {
    const command = vi.fn()
    await expect(runTopicTaxonomyMigration({ db: { command } })).rejects.toThrow(/writers-paused/i)
    expect(command).not.toHaveBeenCalled()
  })

  it('accepts an auth-core-only users predecessor without requiring Google OAuth', async () => {
    const cursor = (batches) => {
      const result = {
        sort: () => result,
        limit: () => result,
        toArray: vi.fn(async () => batches.shift() ?? []),
      }
      return result
    }
    const articles = { find: vi.fn(() => cursor([[], []])), createIndex: vi.fn(async () => 'index-created') }
    const users = { find: vi.fn(() => cursor([[], []])) }
    const db = {
      collection: vi.fn((name) => name === 'articles' ? articles : users),
      listCollections: vi.fn(() => ({ toArray: async () => [
        { name: 'articles', options: { validator: SUMMARY_DETAIL_ARTICLE_VALIDATOR } },
        { name: 'users', options: { validator: AUTH_CORE_COLLECTIONS.users.validator } },
      ] })),
      command: vi.fn(async () => ({ ok: 1 })),
    }

    await expect(runTopicTaxonomyMigration({ db, writerMode: 'paused' })).resolves.toHaveLength(6)
  })

  it('blocks strict cutover when the final residue scan finds a legacy document', async () => {
    const cursor = (batches) => {
      const result = {
        sort: () => result,
        limit: () => result,
        toArray: vi.fn(async () => batches.shift() ?? []),
      }
      return result
    }
    const articleBatches = [[], [{ _id: new ObjectId() }]]
    const userBatches = [[], []]
    const articles = {
      find: vi.fn(() => cursor(articleBatches)),
      createIndex: vi.fn(async () => 'index-created'),
    }
    const users = { find: vi.fn(() => cursor(userBatches)) }
    const db = {
      collection: vi.fn((name) => name === 'articles' ? articles : users),
      listCollections: vi.fn(() => ({ toArray: async () => [
        { name: 'articles', options: { validator: SUMMARY_DETAIL_ARTICLE_VALIDATOR } },
        { name: 'users', options: { validator: GOOGLE_OAUTH_USERS_VALIDATOR } },
      ] })),
      command: vi.fn(async () => ({ ok: 1 })),
    }

    await expect(runTopicTaxonomyMigration({ db, writerMode: 'paused' })).rejects.toThrow(/residue/i)
    expect(db.command).toHaveBeenCalledTimes(2)
  })

  it('runs CAS backfill over articles and users with resumable _id cursor and conflict counting', async () => {
    const articleId = new ObjectId()
    const userId = new ObjectId()
    const now = new Date('2026-08-20T00:00:00.000Z')

    const legacyArticle = {
      _id: articleId,
      status: 'published',
      titleOriginal: 'AI and Robotics Overview',
      topics: ['ai', 'robot', 'safety'],
      updatedAt: now,
    }
    const legacyUser = {
      _id: userId,
      status: 'active',
      topicPreferences: ['AI', 'Robot'],
      updatedAt: now,
    }

    const articlesCollection = {
      find: vi.fn(() => ({
        sort: () => ({
          limit: () => ({
            toArray: vi.fn().mockResolvedValueOnce([legacyArticle]).mockResolvedValueOnce([]),
          }),
        }),
      })),
      updateOne: vi.fn(async () => ({ matchedCount: 1, modifiedCount: 1 })),
    }

    const usersCollection = {
      find: vi.fn(() => ({
        sort: () => ({
          limit: () => ({
            toArray: vi.fn().mockResolvedValueOnce([legacyUser]).mockResolvedValueOnce([]),
          }),
        }),
      })),
      updateOne: vi.fn(async () => ({ matchedCount: 1, modifiedCount: 1 })),
    }

    const db = {
      collection: vi.fn((name) => {
        if (name === 'articles') return articlesCollection
        if (name === 'users') return usersCollection
        throw new Error(`Unknown collection ${name}`)
      }),
      listCollections: vi.fn(() => ({
        toArray: async () => [
          { name: 'articles', options: { validator: SUMMARY_DETAIL_ARTICLE_VALIDATOR } },
          { name: 'users', options: { validator: GOOGLE_OAUTH_USERS_VALIDATOR } },
        ],
      })),
      command: vi.fn(async () => ({ ok: 1 })),
    }

    const result = await runTopicTaxonomyBackfill({ db, batchSize: 10 })

    expect(result.articles.scanned).toBe(1)
    expect(result.articles.migrated).toBe(1)
    expect(result.articles.unmapped).toBe(1) // 'safety' has no canonical ID
    expect(result.articles.conflict).toBe(0)

    expect(result.users.scanned).toBe(1)
    expect(result.users.migrated).toBe(1)
    expect(result.users.conflict).toBe(0)

    // Check that articles updateOne used CAS filter with _id and updatedAt
    expect(articlesCollection.updateOne).toHaveBeenCalledWith(
      expect.objectContaining({
        _id: articleId,
        updatedAt: now,
        status: { $ne: 'removed' },
      }),
      expect.objectContaining({
        $set: expect.objectContaining({
          topicIds: expect.arrayContaining(['ai-ml', 'robotics']),
          topicTaxonomyVersion: 1,
        }),
      }),
    )

    // Check that users updateOne used CAS filter with _id and status !== 'deleted'
    expect(usersCollection.updateOne).toHaveBeenCalledWith(
      expect.objectContaining({
        _id: userId,
        updatedAt: now,
        status: { $ne: 'deleted' },
      }),
      expect.objectContaining({
        $set: expect.objectContaining({
          topicPreferenceIds: expect.arrayContaining(['ai-ml', 'robotics']),
          topicPreferenceTaxonomyVersion: 1,
        }),
      }),
    )
  })

  it('drains article and user cursors before installing final validators', async () => {
    const articleBatches = [
      [{ _id: new ObjectId(), status: 'published', titleOriginal: 'AI one', topics: ['ai'], updatedAt: new Date('2026-08-20T00:00:00.000Z') }],
      [{ _id: new ObjectId(), status: 'published', titleOriginal: 'AI two', topics: ['ai'], updatedAt: new Date('2026-08-20T00:00:00.000Z') }],
      [],
    ]
    const userBatches = [
      [{ _id: new ObjectId(), status: 'active', topicPreferences: ['AI'], updatedAt: new Date('2026-08-20T00:00:00.000Z') }],
      [{ _id: new ObjectId(), status: 'active', topicPreferences: ['AI'], updatedAt: new Date('2026-08-20T00:00:00.000Z') }],
      [],
    ]
    const cursor = (batches) => ({
      sort: () => ({
        limit: () => ({ toArray: vi.fn(async () => batches.shift() ?? []) }),
      }),
    })
    const articlesCollection = {
      find: vi.fn(() => cursor(articleBatches)),
      updateOne: vi.fn(async () => ({ matchedCount: 1 })),
      createIndex: vi.fn(async () => 'index-created'),
    }
    const usersCollection = {
      find: vi.fn(() => cursor(userBatches)),
      updateOne: vi.fn(async () => ({ matchedCount: 1 })),
    }
    const db = {
      collection: vi.fn((name) => name === 'articles' ? articlesCollection : usersCollection),
      listCollections: vi.fn(() => ({
        toArray: async () => [
          { name: 'articles', options: { validator: SUMMARY_DETAIL_ARTICLE_VALIDATOR } },
          { name: 'users', options: { validator: GOOGLE_OAUTH_USERS_VALIDATOR } },
        ],
      })),
      command: vi.fn(async () => ({ ok: 1 })),
    }

    await runTopicTaxonomyMigration({ db, batchSize: 1, writerMode: 'paused' })

    expect(articlesCollection.updateOne).toHaveBeenCalledTimes(2)
    expect(usersCollection.updateOne).toHaveBeenCalledTimes(2)
    expect(articlesCollection.find).toHaveBeenCalledTimes(4)
    expect(usersCollection.find).toHaveBeenCalledTimes(4)
    expect(db.command).toHaveBeenCalledTimes(4)
  })

  it('is idempotent when records are already migrated and reports zero changes', async () => {
    const articlesCollection = {
      find: vi.fn(() => ({
        sort: () => ({
          limit: () => ({
            toArray: async () => [],
          }),
        }),
      })),
      updateOne: vi.fn(),
    }
    const usersCollection = {
      find: vi.fn(() => ({
        sort: () => ({
          limit: () => ({
            toArray: async () => [],
          }),
        }),
      })),
      updateOne: vi.fn(),
    }
    const db = {
      collection: vi.fn((name) => {
        if (name === 'articles') return articlesCollection
        if (name === 'users') return usersCollection
      }),
    }

    const result = await runTopicTaxonomyBackfill({ db, batchSize: 10 })
    expect(result.articles.migrated).toBe(0)
    expect(result.users.migrated).toBe(0)
    expect(articlesCollection.updateOne).not.toHaveBeenCalled()
    expect(usersCollection.updateOne).not.toHaveBeenCalled()
  })

  it('skips already-migrated documents without rewriting canonical fields', async () => {
    const articleId = new ObjectId()
    const userId = new ObjectId()
    const now = new Date('2026-08-20T00:00:00.000Z')

    const migratedArticle = {
      _id: articleId,
      status: 'published',
      titleOriginal: 'Cloud data infrastructure with Kubernetes',
      excerptOriginal: 'A database pipeline stores analytics for modern teams.',
      topics: ['devops', 'dữ liệu'],
      topicIds: ['devops-cloud', 'containers-orchestration', 'computer-science', 'databases', 'data-engineering'],
      topicTaxonomyVersion: 1,
      updatedAt: now,
    }
    const migratedUser = {
      _id: userId,
      status: 'active',
      topicPreferences: ['AI', 'Robot'],
      topicPreferenceIds: ['ai-ml', 'ai-agent', 'robotics'],
      topicPreferenceTaxonomyVersion: 1,
      updatedAt: now,
    }

    const articlesCollection = {
      find: vi.fn(() => ({
        sort: () => ({
          limit: () => ({
            toArray: vi.fn().mockResolvedValueOnce([migratedArticle]).mockResolvedValueOnce([]),
          }),
        }),
      })),
      updateOne: vi.fn(async () => ({ matchedCount: 1 })),
    }
    const usersCollection = {
      find: vi.fn(() => ({
        sort: () => ({
          limit: () => ({
            toArray: vi.fn().mockResolvedValueOnce([migratedUser]).mockResolvedValueOnce([]),
          }),
        }),
      })),
      updateOne: vi.fn(async () => ({ matchedCount: 1 })),
    }
    const db = {
      collection: vi.fn((name) => {
        if (name === 'articles') return articlesCollection
        if (name === 'users') return usersCollection
      }),
    }

    const result = await runTopicTaxonomyBackfill({ db, batchSize: 10 })

    expect(result.articles).toMatchObject({ scanned: 1, migrated: 0, conflict: 0 })
    expect(result.users).toMatchObject({ scanned: 1, migrated: 0, conflict: 0 })
    expect(articlesCollection.updateOne).not.toHaveBeenCalled()
    expect(usersCollection.updateOne).not.toHaveBeenCalled()
  })
})
