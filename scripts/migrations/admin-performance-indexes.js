import { exactMongoIndex } from '../../server/repositories/mongo/index-contract.js'

export const ADMIN_PERFORMANCE_INDEXES = Object.freeze({
  sources: Object.freeze([
    { name: 'sources_operational_overview', key: { operationalStatus: 1 } },
  ]),
  articles: Object.freeze([
    { name: 'articles_admin_updated', key: { updatedAt: -1, _id: -1 } },
    { name: 'articles_admin_status_updated', key: { status: 1, updatedAt: -1, _id: -1 } },
  ]),
  ingestionJobs: Object.freeze([
    { name: 'ingestion_admin_created', key: { createdAt: -1, _id: -1 } },
    { name: 'ingestion_admin_status_created', key: { status: 1, createdAt: -1, _id: -1 } },
    { name: 'ingestion_overview_finished', key: { status: 1, finishedAt: -1, _id: -1 } },
  ]),
  indexingJobs: Object.freeze([
    { name: 'indexing_admin_created', key: { createdAt: -1, _id: -1 } },
    { name: 'indexing_admin_status_created', key: { status: 1, createdAt: -1, _id: -1 } },
  ]),
  takedownRequests: Object.freeze([
    { name: 'takedown_admin_created', key: { createdAt: -1, _id: -1 } },
  ]),
  accountDeletionRequests: Object.freeze([
    { name: 'account_deletion_admin_requested', key: { requestedAt: -1, _id: -1 } },
    { name: 'account_deletion_next_available', key: { status: 1, availableAt: 1, _id: 1 } },
    {
      name: 'account_deletion_expired_lease',
      key: { status: 1, leaseExpiresAt: 1, _id: 1 },
      options: { partialFilterExpression: { status: 'running', leaseExpiresAt: { $type: 'date' } } },
    },
  ]),
})

export function buildAdminPerformanceIndexesMigration({ dryRun = false, existingIndexes = {} } = {}) {
  const operations = []
  for (const [collection, indexes] of Object.entries(ADMIN_PERFORMANCE_INDEXES)) {
    for (const index of indexes) {
      const existing = (existingIndexes[collection] ?? []).find((actual) => actual?.name === index.name)
      if (existing && !exactMongoIndex(existing, index)) throw new Error(`Admin performance index ${collection}.${index.name} is incompatible`)
      if (existing) continue
      operations.push({ type: 'createIndex', collection, ...index, ...(dryRun ? { dryRun: true } : {}) })
    }
  }
  return operations
}

export async function runAdminPerformanceIndexesMigration({ db, dryRun = false } = {}) {
  if (!db || typeof db.collection !== 'function') throw new Error('MongoDB database is required')
  const existingIndexes = {}
  for (const collection of Object.keys(ADMIN_PERFORMANCE_INDEXES)) {
    existingIndexes[collection] = await db.collection(collection).indexes()
  }
  const plan = buildAdminPerformanceIndexesMigration({ dryRun, existingIndexes })
  if (dryRun) return plan
  for (const operation of plan) {
    await db.collection(operation.collection).createIndex(operation.key, {
      ...(operation.options ?? {}),
      name: operation.name,
    })
  }
  return plan
}
