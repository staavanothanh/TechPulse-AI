import { describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import {
  ADMIN_PERFORMANCE_INDEXES,
  buildAdminPerformanceIndexesMigration,
  runAdminPerformanceIndexesMigration,
} from '../../scripts/migrations/admin-performance-indexes.js'

describe('admin performance follow-on migration', () => {
  it('adds only indexes that match existing admin and account-deletion query order', () => {
    expect(ADMIN_PERFORMANCE_INDEXES).toMatchObject({
      sources: [
        { name: 'sources_operational_overview', key: { operationalStatus: 1 } },
      ],
      articles: expect.arrayContaining([
        { name: 'articles_admin_updated', key: { updatedAt: -1, _id: -1 } },
        { name: 'articles_admin_status_updated', key: { status: 1, updatedAt: -1, _id: -1 } },
      ]),
      ingestionJobs: expect.arrayContaining([
        { name: 'ingestion_admin_created', key: { createdAt: -1, _id: -1 } },
        { name: 'ingestion_admin_status_created', key: { status: 1, createdAt: -1, _id: -1 } },
        { name: 'ingestion_overview_finished', key: { status: 1, finishedAt: -1, _id: -1 } },
      ]),
      indexingJobs: expect.arrayContaining([
        { name: 'indexing_admin_created', key: { createdAt: -1, _id: -1 } },
        { name: 'indexing_admin_status_created', key: { status: 1, createdAt: -1, _id: -1 } },
      ]),
      takedownRequests: [
        { name: 'takedown_admin_created', key: { createdAt: -1, _id: -1 } },
      ],
      accountDeletionRequests: expect.arrayContaining([
        { name: 'account_deletion_admin_requested', key: { requestedAt: -1, _id: -1 } },
        { name: 'account_deletion_next_available', key: { status: 1, availableAt: 1, _id: 1 } },
        expect.objectContaining({ name: 'account_deletion_expired_lease', key: { status: 1, leaseExpiresAt: 1, _id: 1 } }),
      ]),
    })
  })

  it('skips exact existing names and never emits destructive operations', () => {
    const existingIndexes = Object.fromEntries(Object.entries(ADMIN_PERFORMANCE_INDEXES)
      .map(([collection, indexes]) => [collection, indexes.map(({ options, ...index }) => ({ ...index, ...(options ?? {}) }))]))
    expect(buildAdminPerformanceIndexesMigration({ existingIndexes })).toEqual([])
    expect(buildAdminPerformanceIndexesMigration({ dryRun: true }).every((operation) => operation.type === 'createIndex' && operation.dryRun === true)).toBe(true)
  })

  it.each([
    [{ name: 'account_deletion_next_available', key: { status: 1, availableAt: -1, _id: 1 } }],
    [{ name: 'account_deletion_expired_lease', key: { status: 1, leaseExpiresAt: 1, _id: 1 }, partialFilterExpression: { status: 'failed', leaseExpiresAt: { $type: 'date' } } }],
  ])('rejects a same-name index with incompatible key or options', (actual) => {
    expect(() => buildAdminPerformanceIndexesMigration({ existingIndexes: { accountDeletionRequests: [actual] } })).toThrow(/incompatible/i)
  })

  it('discovers existing indexes before applying only missing definitions', async () => {
    const collections = new Map()
    for (const [name, indexes] of Object.entries(ADMIN_PERFORMANCE_INDEXES)) {
      collections.set(name, {
        indexes: vi.fn(async () => [{ name: '_id_', key: { _id: 1 } }, ...(name === 'sources' ? [{ name: indexes[0].name, key: indexes[0].key, ...(indexes[0].options ?? {}) }] : [])]),
        createIndex: vi.fn(async () => 'created'),
      })
    }
    const plan = await runAdminPerformanceIndexesMigration({ db: { collection: (name) => collections.get(name) } })

    expect(plan.some((operation) => operation.collection === 'sources')).toBe(false)
    expect(collections.get('sources').createIndex).not.toHaveBeenCalled()
    expect(collections.get('articles').createIndex).toHaveBeenCalledTimes(ADMIN_PERFORMANCE_INDEXES.articles.length)
  })

  it('wires the follow-on migration and plan verification into the governance target', () => {
    const migrate = readFileSync(new URL('../../scripts/db-migrate.js', import.meta.url), 'utf8')
    const verify = readFileSync(new URL('../../scripts/db-verify.js', import.meta.url), 'utf8')
    expect(migrate).toContain('runAdminPerformanceIndexesMigration({ db: context.db })')
    expect(migrate).toContain('buildAdminPerformanceIndexesMigration({ dryRun: true })')
    for (const index of Object.values(ADMIN_PERFORMANCE_INDEXES).flat()) expect(verify).toContain(index.name)
    expect(verify).toContain("['account_deletion_expired_lease', 'accountDeletionRequests', { status: 'running', leaseExpiresAt: { $type: 'date', $lte: new Date() } }, { leaseExpiresAt: 1, _id: 1 }, undefined]")
    expect(verify).toContain('admin read')
  })
})
