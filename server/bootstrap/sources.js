import { createSourceService } from '../application/sources/service.js'
import { createCurrentSourcePolicy } from '../application/sources/current-policy.js'
import { MongoSourceRepository } from '../repositories/mongo/source-repository.js'
import { SOURCE_AUDIT_VALIDATOR, SOURCE_COLLECTIONS, SOURCE_INDEXES } from '../../scripts/migrations/sources.js'
import { DURABLE_JOB_AUDIT_VALIDATOR } from '../../scripts/migrations/durable-jobs.js'
import { INDEXING_JOB_AUDIT_VALIDATOR } from '../../scripts/migrations/indexing-jobs.js'
import { GOVERNANCE_AUDIT_VALIDATOR } from '../../scripts/migrations/governance-audit.js'
import { exactMongoIndex } from '../repositories/mongo/index-contract.js'

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`
  return JSON.stringify(value)
}

export async function assertSourcesReady(context) {
  const collections = await context.db.listCollections({}, { nameOnly: false }).toArray()
  const collectionMap = new Map(collections.map((collection) => [collection.name, collection]))
  const sourceCollection = collectionMap.get('sources')
  const auditCollection = collectionMap.get('adminAuditLogs')
  if (!sourceCollection || sourceCollection.options?.validationLevel !== 'strict' || sourceCollection.options?.validationAction !== 'error' || stableJson(sourceCollection.options?.validator) !== stableJson(SOURCE_COLLECTIONS.sources.validator)) throw new Error('sources validator is not ready')
  const acceptedAuditValidators = [SOURCE_AUDIT_VALIDATOR, DURABLE_JOB_AUDIT_VALIDATOR, INDEXING_JOB_AUDIT_VALIDATOR, GOVERNANCE_AUDIT_VALIDATOR]
  if (!auditCollection || auditCollection.options?.validationLevel !== 'strict' || auditCollection.options?.validationAction !== 'error' || !acceptedAuditValidators.some((validator) => stableJson(auditCollection.options?.validator) === stableJson(validator))) throw new Error('source audit validator is not ready')
  const actualByName = new Map((await context.db.collection('sources').indexes()).map((index) => [index.name, index]))
  for (const expected of SOURCE_INDEXES.sources) {
    const actual = actualByName.get(expected.name)
    if (!exactMongoIndex(actual, expected)) throw new Error('sources indexes are not ready')
  }
}

export async function createConfiguredSourceService({ context, technicalCheckAdapter, rateLimitAdmission } = {}) {
  if (!context) throw new Error('Mongo context is required')
  if (typeof rateLimitAdmission?.reserve !== 'function') throw new Error('Rate-limit admission is required')
  await assertSourcesReady(context)
  const repository = new MongoSourceRepository(context)
  return { sourceService: createSourceService({ repository, technicalCheckAdapter, rateLimitAdmission }), currentSourcePolicy: createCurrentSourcePolicy({ repository }) }
}
