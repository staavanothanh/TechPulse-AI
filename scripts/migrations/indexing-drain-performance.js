import { exactMongoIndex } from '../../server/repositories/mongo/index-contract.js'

// These indexes are intentionally separate from the original indexing-jobs
// migration. The drain adds task to its due-lane predicate, so the existing
// indexes remain valid for older callers and for rollback compatibility.
export const INDEXING_DRAIN_PERFORMANCE_INDEXES = Object.freeze({
  indexingJobs: Object.freeze([
    Object.freeze({
      name: 'indexing_drain_task_aged',
      key: { status: 1, task: 1, agingEligibleAt: 1, availableAt: 1, createdAt: 1, _id: 1 },
    }),
    Object.freeze({
      name: 'indexing_drain_task_normal',
      key: { status: 1, task: 1, priority: -1, availableAt: 1, createdAt: 1, _id: 1 },
    }),
  ]),
})

export function buildIndexingDrainPerformanceMigration({ dryRun = false, existingIndexes = {} } = {}) {
  const operations = []
  for (const [collection, indexes] of Object.entries(INDEXING_DRAIN_PERFORMANCE_INDEXES)) {
    for (const index of indexes) {
      const existing = (existingIndexes[collection] ?? []).find((actual) => actual?.name === index.name)
      if (existing && !exactMongoIndex(existing, index)) throw new Error(`Indexing drain performance index ${collection}.${index.name} is incompatible`)
      if (existing) continue
      operations.push({ type: 'createIndex', collection, ...index, ...(dryRun ? { dryRun: true } : {}) })
    }
  }
  return operations
}

export async function runIndexingDrainPerformanceMigration({ db, dryRun = false } = {}) {
  if (!db || typeof db.collection !== 'function') throw new Error('MongoDB database is required')
  const existingIndexes = {}
  for (const collection of Object.keys(INDEXING_DRAIN_PERFORMANCE_INDEXES)) {
    existingIndexes[collection] = await db.collection(collection).indexes()
  }
  const plan = buildIndexingDrainPerformanceMigration({ dryRun, existingIndexes })
  if (dryRun) return plan
  for (const operation of plan) {
    await db.collection(operation.collection).createIndex(operation.key, {
      ...(operation.options ?? {}),
      name: operation.name,
    })
  }
  return plan
}
