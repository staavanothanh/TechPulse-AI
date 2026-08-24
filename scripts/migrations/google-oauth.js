import { AUTH_CORE_COLLECTIONS } from './auth-core.js'
import { GOVERNANCE_AUDIT_VALIDATOR } from './governance-audit.js'

const GOOGLE_SUB_PATTERN = '^[A-Za-z0-9._-]{1,255}$'

function clone(value) {
  return structuredClone(value)
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`
  return JSON.stringify(value)
}

const authUserValidator = AUTH_CORE_COLLECTIONS.users.validator
const activeUserSchema = clone(authUserValidator.$or[0].$jsonSchema)
const deletedUserSchema = clone(authUserValidator.$or[1].$jsonSchema)
activeUserSchema.properties.googleSub = { bsonType: 'string', minLength: 1, maxLength: 255, pattern: GOOGLE_SUB_PATTERN }

export const GOOGLE_OAUTH_USERS_VALIDATOR = Object.freeze({
  $or: [
    { $jsonSchema: activeUserSchema },
    { $jsonSchema: deletedUserSchema },
  ],
})

const governanceAuditParts = GOVERNANCE_AUDIT_VALIDATOR.$and
const oauthAuditRules = [
  { action: 'google_oauth_registered', reasonCode: 'google_oauth_registered', changedFields: ['status'], stateTransition: { $exists: false } },
  { action: 'google_oauth_login', reasonCode: 'google_oauth_login', changedFields: [], stateTransition: { $exists: false } },
]

export const GOOGLE_OAUTH_AUDIT_VALIDATOR = Object.freeze({
  $and: [
    { $or: [...governanceAuditParts[0].$or, ...oauthAuditRules] },
    clone(governanceAuditParts[1]),
  ],
})

export const GOOGLE_OAUTH_COLLECTIONS = Object.freeze({
  users: Object.freeze({ validator: GOOGLE_OAUTH_USERS_VALIDATOR }),
  adminAuditLogs: Object.freeze({ validator: GOOGLE_OAUTH_AUDIT_VALIDATOR }),
})

export const GOOGLE_OAUTH_INDEXES = Object.freeze({
  users: Object.freeze([
    {
      name: 'users_google_sub_unique',
      key: { googleSub: 1 },
      options: { unique: true, partialFilterExpression: { googleSub: { $type: 'string' } } },
    },
  ]),
})

function migrationOperations() {
  return [
    {
      type: 'collMod',
      collection: 'users',
      options: { validator: GOOGLE_OAUTH_USERS_VALIDATOR, validationLevel: 'strict', validationAction: 'error' },
    },
    {
      type: 'collMod',
      collection: 'adminAuditLogs',
      options: { validator: GOOGLE_OAUTH_AUDIT_VALIDATOR, validationLevel: 'strict', validationAction: 'error' },
    },
    { type: 'createIndex', collection: 'users', ...GOOGLE_OAUTH_INDEXES.users[0] },
  ]
}

async function assertPredecessor(db) {
  if (typeof db.listCollections !== 'function') throw new Error('Google OAuth migration predecessor check is unavailable')
  // MongoDB's listCollections command accepts a string/regex name filter;
  // using a query-style $in here is rejected by Atlas before any mutation.
  const collections = await db.listCollections({ name: /^(users|adminAuditLogs)$/ }, { nameOnly: false }).toArray()
  const byName = new Map(collections.map((collection) => [collection.name, collection]))
  const users = byName.get('users')
  const audit = byName.get('adminAuditLogs')
  const usersReady = users && [AUTH_CORE_COLLECTIONS.users.validator, GOOGLE_OAUTH_USERS_VALIDATOR].some((validator) => stableJson(users.options?.validator) === stableJson(validator))
  const auditReady = audit && [GOVERNANCE_AUDIT_VALIDATOR, GOOGLE_OAUTH_AUDIT_VALIDATOR].some((validator) => stableJson(audit.options?.validator) === stableJson(validator))
  if (!usersReady || !auditReady) throw new Error('Google OAuth migration predecessor is not ready')
}

export function buildGoogleOAuthMigration({ dryRun = false } = {}) {
  const plan = migrationOperations()
  return dryRun ? plan.map((operation) => ({ ...operation, dryRun: true })) : plan
}

export async function runGoogleOAuthMigration({ db, dryRun = false } = {}) {
  if (!db || typeof db.command !== 'function' || typeof db.collection !== 'function') throw new Error('MongoDB database is required')
  const plan = buildGoogleOAuthMigration({ dryRun })
  if (dryRun) return plan
  await assertPredecessor(db)
  for (const operation of plan) {
    if (operation.type === 'collMod') await db.command({ collMod: operation.collection, ...operation.options })
    else await db.collection(operation.collection).createIndex(operation.key, { ...(operation.options ?? {}), name: operation.name })
  }
  return plan
}

/**
 * Governance is an earlier release chain but its audit collMod must not
 * overwrite the OAuth successor validator when both are applied together.
 */
export function withGoogleOAuthAuditCompatibility(db) {
  if (!db || typeof db.command !== 'function') throw new Error('MongoDB database is required')
  return new Proxy(db, {
    get(target, property, receiver) {
      if (property !== 'command') return Reflect.get(target, property, receiver)
      return (command, ...args) => {
        if (command?.collMod !== 'adminAuditLogs') return target.command(command, ...args)
        return target.command({ ...command, validator: GOOGLE_OAUTH_AUDIT_VALIDATOR })
      }
    },
  })
}
