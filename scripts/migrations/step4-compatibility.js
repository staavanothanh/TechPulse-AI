import { AUTH_CORE_COLLECTIONS, runAuthCoreMigration } from './auth-core.js'
import { SOURCE_AUDIT_VALIDATOR, runSourcesMigration } from './sources.js'
import { DURABLE_JOB_AUDIT_VALIDATOR, runDurableJobsMigration } from './durable-jobs.js'

const KNOWN_AUDIT_VALIDATORS = Object.freeze([
  AUTH_CORE_COLLECTIONS.adminAuditLogs.validator,
  SOURCE_AUDIT_VALIDATOR,
  DURABLE_JOB_AUDIT_VALIDATOR,
])

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`
  return JSON.stringify(value)
}

export function resolveStep4AuditValidator(current) {
  const revision = stableJson(current)
  const known = KNOWN_AUDIT_VALIDATORS.find((validator) => stableJson(validator) === revision)
  if (!known) throw new Error('unknown audit validator revision')
  return known
}

function compatibleDatabase(db, auditValidator) {
  return {
    createCollection: (...args) => db.createCollection(...args),
    collection: (...args) => db.collection(...args),
    command: (command, ...args) => db.command(command?.collMod === 'adminAuditLogs' ? { ...command, validator: auditValidator } : command, ...args),
  }
}

async function currentAuditValidator(db) {
  const current = (await db.listCollections({ name: 'adminAuditLogs' }, { nameOnly: false }).toArray())[0]
  return current ? resolveStep4AuditValidator(current.options?.validator) : null
}

export async function runAuthCoreWithStep4Compatibility({ db, dryRun = false } = {}) {
  if (!db || typeof db.listCollections !== 'function') throw new Error('MongoDB database is required')
  if (dryRun) return runAuthCoreMigration({ db, dryRun: true })
  const current = await currentAuditValidator(db)
  return runAuthCoreMigration({ db: compatibleDatabase(db, current ?? AUTH_CORE_COLLECTIONS.adminAuditLogs.validator) })
}

export async function runSourcesWithStep4Compatibility({ db, dryRun = false } = {}) {
  if (!db || typeof db.listCollections !== 'function') throw new Error('MongoDB database is required')
  if (dryRun) return runSourcesMigration({ db, dryRun: true })
  const current = await currentAuditValidator(db)
  const target = current === DURABLE_JOB_AUDIT_VALIDATOR ? current : SOURCE_AUDIT_VALIDATOR
  return runSourcesMigration({ db: compatibleDatabase(db, target) })
}

export async function runDurableJobsWithStep4Compatibility({ db, dryRun = false } = {}) {
  if (!db || typeof db.listCollections !== 'function') throw new Error('MongoDB database is required')
  if (dryRun) return runDurableJobsMigration({ db, dryRun: true })
  const current = await currentAuditValidator(db)
  if (current !== SOURCE_AUDIT_VALIDATOR && current !== DURABLE_JOB_AUDIT_VALIDATOR) throw new Error('sources migration must be applied before durable-jobs')
  return runDurableJobsMigration({ db })
}
