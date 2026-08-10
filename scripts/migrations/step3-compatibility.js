import { AUTH_CORE_COLLECTIONS, runAuthCoreMigration } from './auth-core.js'
import { SOURCE_AUDIT_VALIDATOR } from './sources.js'

const KNOWN_AUDIT_VALIDATORS = Object.freeze([
  AUTH_CORE_COLLECTIONS.adminAuditLogs.validator,
  SOURCE_AUDIT_VALIDATOR,
])

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`
  }
  return JSON.stringify(value)
}

export function resolveStep3AuditValidator(current) {
  const currentRevision = stableJson(current)
  const known = KNOWN_AUDIT_VALIDATORS.find((validator) => stableJson(validator) === currentRevision)
  if (!known) throw new Error('unknown audit validator revision')
  return known
}

function compatibleDatabase(db, auditValidator) {
  return {
    createCollection: (...args) => db.createCollection(...args),
    collection: (...args) => db.collection(...args),
    command: (command, ...args) => db.command(
      command?.collMod === 'adminAuditLogs'
        ? { ...command, validator: auditValidator }
        : command,
      ...args,
    ),
  }
}

export async function runAuthCoreWithStep3Compatibility({ db, dryRun = false } = {}) {
  if (!db || typeof db.listCollections !== 'function') throw new Error('MongoDB database is required')
  if (dryRun) return runAuthCoreMigration({ db, dryRun: true })

  const existingAuditCollection = (await db
    .listCollections({ name: 'adminAuditLogs' }, { nameOnly: false })
    .toArray())[0]
  const auditValidator = existingAuditCollection
    ? resolveStep3AuditValidator(existingAuditCollection.options?.validator)
    : AUTH_CORE_COLLECTIONS.adminAuditLogs.validator

  return runAuthCoreMigration({ db: compatibleDatabase(db, auditValidator) })
}
