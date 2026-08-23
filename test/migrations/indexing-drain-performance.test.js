import { readFileSync } from 'node:fs'
import { describe, expect, it, vi } from 'vitest'
import {
  INDEXING_DRAIN_PERFORMANCE_INDEXES,
  buildIndexingDrainPerformanceMigration,
  runIndexingDrainPerformanceMigration,
} from '../../scripts/migrations/indexing-drain-performance.js'
import { RUNTIME_SCHEMA_GENERATIONS } from '../../server/bootstrap/schema-readiness.js'

function materialize(index) {
  return { name: index.name, key: index.key, ...(index.options ?? {}) }
}

describe('indexing drain performance migration', () => {
  it('defines separate task-aware aged and normal due indexes', () => {
    expect(INDEXING_DRAIN_PERFORMANCE_INDEXES).toEqual({
      indexingJobs: [
        {
          name: 'indexing_drain_task_aged',
          key: { status: 1, task: 1, agingEligibleAt: 1, availableAt: 1, createdAt: 1, _id: 1 },
        },
        {
          name: 'indexing_drain_task_normal',
          key: { status: 1, task: 1, priority: -1, availableAt: 1, createdAt: 1, _id: 1 },
        },
      ],
    })
  })

  it('is idempotent and emits no destructive operation', () => {
    const existingIndexes = {
      indexingJobs: INDEXING_DRAIN_PERFORMANCE_INDEXES.indexingJobs.map(materialize),
    }
    expect(buildIndexingDrainPerformanceMigration({ existingIndexes })).toEqual([])
    const plan = buildIndexingDrainPerformanceMigration({ dryRun: true })
    expect(plan).toHaveLength(2)
    expect(plan.every((operation) => operation.type === 'createIndex' && operation.dryRun === true)).toBe(true)
  })

  it('rejects same-name index drift before touching MongoDB', () => {
    expect(() => buildIndexingDrainPerformanceMigration({
      existingIndexes: {
        indexingJobs: [{ name: 'indexing_drain_task_aged', key: { status: 1, task: 1, agingEligibleAt: 1 } }],
      },
    })).toThrow(/incompatible/i)
  })

  it('discovers current indexes and applies only missing definitions', async () => {
    const aged = materialize(INDEXING_DRAIN_PERFORMANCE_INDEXES.indexingJobs[0])
    const collection = {
      indexes: vi.fn(async () => [{ name: '_id_', key: { _id: 1 } }, aged]),
      createIndex: vi.fn(async () => 'created'),
    }
    const plan = await runIndexingDrainPerformanceMigration({ db: { collection: () => collection } })

    expect(plan).toEqual([expect.objectContaining({ name: 'indexing_drain_task_normal', type: 'createIndex' })])
    expect(collection.createIndex).toHaveBeenCalledOnce()
    expect(collection.createIndex).toHaveBeenCalledWith(
      INDEXING_DRAIN_PERFORMANCE_INDEXES.indexingJobs[1].key,
      { name: 'indexing_drain_task_normal' },
    )
  })

  it('wires the standalone migration target without changing older targets', () => {
    const migrate = readFileSync(new URL('../../scripts/db-migrate.js', import.meta.url), 'utf8')
    const verify = readFileSync(new URL('../../scripts/db-verify.js', import.meta.url), 'utf8')
    expect(migrate).toContain("'indexing-drain-performance'")
    expect(migrate).toContain('runIndexingDrainPerformanceMigration')
    for (const index of INDEXING_DRAIN_PERFORMANCE_INDEXES.indexingJobs) expect(verify).toContain(index.name)
  })

  it('binds the existing indexing runtime attestation to the drain indexes', () => {
    const verify = readFileSync(new URL('../../scripts/db-verify.js', import.meta.url), 'utf8')
    expect(RUNTIME_SCHEMA_GENERATIONS['indexing-jobs']).toBe('indexing-jobs-drain-performance-v1')
    expect(verify).toMatch(/target === 'indexing-jobs'[\s\S]*INDEXING_DRAIN_PERFORMANCE_INDEXES/)
    expect(verify).toContain("target === 'indexing-drain-performance' ? 'indexing-jobs' : target")
  })
})
