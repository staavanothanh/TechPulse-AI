import { INDEXING_JOB_AUDIT_VALIDATOR } from './indexing-jobs.js'
import { GOVERNANCE_AUDIT_VALIDATOR } from './governance-audit.js'
import { GOOGLE_OAUTH_AUDIT_VALIDATOR } from './google-oauth.js'

const reconciliationAuditRule = Object.freeze({
  action: 'source_policy_reconciliation_requested',
  targetType: 'source',
  reasonCode: 'source_policy_reconciliation_requested',
  changedFields: ['reconciliation'],
  result: 'pending',
  stateTransition: { $exists: false },
})

const baseParts = GOOGLE_OAUTH_AUDIT_VALIDATOR.$and
export const SOURCE_POLICY_RECONCILIATION_AUDIT_VALIDATOR = Object.freeze({
  $and: [
    { $or: [...baseParts[0].$or, reconciliationAuditRule] },
    baseParts[1],
  ],
})

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`
  return JSON.stringify(value)
}
const KNOWN_PREDECESSORS = Object.freeze([
  INDEXING_JOB_AUDIT_VALIDATOR,
  GOVERNANCE_AUDIT_VALIDATOR,
  GOOGLE_OAUTH_AUDIT_VALIDATOR,
])

async function assertPredecessor(db) {
  const audit = (await db.listCollections({ name: 'adminAuditLogs' }, { nameOnly: false }).toArray())[0]
  const current = audit?.options?.validator
  if (!KNOWN_PREDECESSORS.some((validator) => stableJson(current) === stableJson(validator)) && stableJson(current) !== stableJson(SOURCE_POLICY_RECONCILIATION_AUDIT_VALIDATOR)) {
    throw new Error('indexing-jobs audit migration must precede source-policy-reconciliation')
  }
}
export const SOURCE_POLICY_RECONCILIATION_INDEXES = Object.freeze([
  { name: 'source_reconciliation_idempotency_unique', key: { action: 1, actorId: 1, requestId: 1 }, options: { unique: true, partialFilterExpression: { action: 'source_policy_reconciliation_requested' } } },
])

export function buildSourcePolicyReconciliationMigration({ dryRun = false } = {}) {
  const operations = [
    {
      type: 'collMod',
      collection: 'adminAuditLogs',
      options: { validator: SOURCE_POLICY_RECONCILIATION_AUDIT_VALIDATOR, validationLevel: 'strict', validationAction: 'error' },
    },
    ...SOURCE_POLICY_RECONCILIATION_INDEXES.map((index) => ({ type: 'createIndex', collection: 'adminAuditLogs', ...index })),
  ]
  return dryRun ? operations.map((operation) => ({ ...operation, dryRun: true })) : operations
}

export async function runSourcePolicyReconciliationMigration({ db, dryRun = false } = {}) {
  if (!db || typeof db.command !== 'function') throw new Error('MongoDB database is required')
  const plan = buildSourcePolicyReconciliationMigration({ dryRun })
  if (dryRun) return plan
  await assertPredecessor(db)
  for (const operation of plan) {
    if (operation.type === 'collMod') await db.command({ collMod: operation.collection, ...operation.options })
    else await db.collection(operation.collection).createIndex(operation.key, { ...(operation.options ?? {}), name: operation.name })
  }
  return plan

}

