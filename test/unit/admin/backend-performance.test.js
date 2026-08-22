import { ObjectId } from 'mongodb'
import { describe, expect, it, vi } from 'vitest'
import { MongoAdminRepository } from '../../../server/repositories/mongo/admin-repository.js'
import { MongoJobRepository } from '../../../server/repositories/mongo/job-repository.js'
import { MongoIndexingJobRepository } from '../../../server/repositories/mongo/indexing-job-repository.js'

function aggregateCollection(result) {
  return { aggregate: vi.fn(() => ({
    next: vi.fn(async () => Array.isArray(result) ? result[0] : result),
    toArray: vi.fn(async () => Array.isArray(result) ? result : [result]),
  })) }
}

function listCollection(document) {
  const cursor = {
    sort: vi.fn(() => cursor),
    hint: vi.fn(() => cursor),
    project: vi.fn(() => cursor),
    limit: vi.fn(() => cursor),
    toArray: vi.fn(async () => [document]),
  }
  return { collection: { find: vi.fn(() => cursor) }, cursor }
}

describe('admin Mongo performance boundaries', () => {
  it('groups overview counters into at most one command per collection', async () => {
    const collections = new Map([
      ['sources', aggregateCollection([
        { key: 'activeSources', value: 2 },
        { key: 'pausedSources', value: 1 },
        { key: 'sourcesNeedingReview', value: 3 },
      ])],
      ['ingestionJobs', aggregateCollection([
        { key: 'queuedJobs', value: 4 },
        { key: 'failedJobs', value: 5 },
        { key: 'lastSuccessfulIngestionAt', value: new Date('2026-08-20T00:00:00.000Z') },
      ])],
      ['articles', aggregateCollection({ count: 6 })],
      ['indexingJobs', aggregateCollection({ count: 7 })],
      ['takedownRequests', aggregateCollection({ count: 8 })],
      ['accountDeletionRequests', aggregateCollection({ count: 9 })],
    ])
    const repository = new MongoAdminRepository({
      db: { collection: (name) => collections.get(name) },
      client: {},
    })

    await expect(repository.getOverview()).resolves.toEqual({
      activeSources: 2,
      pausedSources: 1,
      sourcesNeedingReview: 3,
      queuedJobs: 4,
      failedJobs: 5,
      articlesNeedingReview: 6,
      failedIndexes: 7,
      openTakedowns: 8,
      failedAccountDeletions: 9,
      lastSuccessfulIngestionAt: new Date('2026-08-20T00:00:00.000Z'),
    })
    expect([...collections.values()].every(({ aggregate }) => aggregate.mock.calls.length === 1)).toBe(true)
    for (const name of ['sources', 'ingestionJobs']) {
      const pipeline = collections.get(name).aggregate.mock.calls[0][0]
      expect(pipeline.some((stage) => stage.$group)).toBe(false)
      expect(pipeline.filter((stage) => stage.$unionWith)).toHaveLength(2)
    }
  })

  it('projects only admin-list ingestion fields before materializing Mongo documents', async () => {
    const now = new Date('2026-08-20T00:00:00.000Z')
    const { collection, cursor } = listCollection({
      _id: new ObjectId(),
      idempotencyKey: 'admin-ingestion-key',
      sourceId: new ObjectId(),
      connectorType: 'rss',
      expectedSourcePolicyVersion: 1,
      trigger: 'admin',
      status: 'queued',
      attempt: 1,
      availableAt: now,
      leaseGeneration: 0,
      batchSize: 20,
      counters: { fetched: 0, created: 0, updated: 0, duplicate: 0, skipped: 0, failed: 0 },
      createdAt: now,
    })
    const repository = new MongoJobRepository({ db: { collection: () => collection }, client: {} })

    await repository.listIngestionJobs({ limit: 20 })

    expect(cursor.project).toHaveBeenCalledWith(expect.objectContaining({
      _id: 1,
      idempotencyKey: 1,
      sourceId: 1,
      counters: 1,
      createdAt: 1,
    }))
    expect(cursor.project.mock.calls[0][0]).not.toHaveProperty('requestHash')
    expect(cursor.project.mock.calls[0][0]).not.toHaveProperty('checkpoint')
    expect(cursor.hint).not.toHaveBeenCalled()
  })

  it('projects only admin-list indexing fields before materializing Mongo documents', async () => {
    const now = new Date('2026-08-20T00:00:00.000Z')
    const { collection, cursor } = listCollection({
      _id: new ObjectId(),
      idempotencyKey: 'admin-indexing-key',
      articleId: new ObjectId(),
      sourceId: new ObjectId(),
      expectedSourcePolicyVersion: 1,
      task: 'summary',
      trigger: 'admin',
      status: 'queued',
      attempt: 1,
      availableAt: now,
      leaseGeneration: 0,
      createdAt: now,
    })
    const repository = new MongoIndexingJobRepository({ db: { collection: () => collection }, client: {} })

    await repository.listIndexingJobs({ limit: 20 })

    expect(cursor.project).toHaveBeenCalledWith(expect.objectContaining({
      _id: 1,
      idempotencyKey: 1,
      articleId: 1,
      sourceId: 1,
      createdAt: 1,
    }))
    expect(cursor.project.mock.calls[0][0]).not.toHaveProperty('requestHash')
    expect(cursor.project.mock.calls[0][0]).not.toHaveProperty('inputHash')
    expect(cursor.hint).not.toHaveBeenCalled()
  })
})
