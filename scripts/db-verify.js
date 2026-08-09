import { validateMongoConfiguration } from '../server/config/runtime.js'
import { getMongoContext, closeMongoConnection } from '../server/repositories/mongo/connection.js'
import { AUTH_CORE_COLLECTIONS, AUTH_CORE_INDEXES } from './migrations/auth-core.js'
import { actionsForCollection, probeAuditRoleCapabilities, probeHmacLifecycleRoleCapabilities } from './mongo-role-probe.js'
import { configureDns } from './configure-dns.js'

configureDns()

const target = process.argv.slice(2).find((value) => !value.startsWith('-')) ?? 'auth-core'
const requireRole = process.argv.includes('--require-role')

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`
  return JSON.stringify(value)
}
if (target !== 'auth-core') {
  console.error('Only auth-core verification is supported in Step 2')
  process.exitCode = 2
} else {
  try {
    const runtime = { mongo: validateMongoConfiguration(process.env) }
    const context = await getMongoContext(runtime)
    const collections = await context.db.listCollections({}, { nameOnly: false }).toArray()
    const collectionMap = new Map(collections.map((collection) => [collection.name, collection]))
    const missing = []
    const validatorProblems = []
    for (const name of Object.keys(AUTH_CORE_COLLECTIONS)) {
      const collection = collectionMap.get(name)
      if (!collection) { missing.push(`${name}:collection`); continue }
      if (collection.options?.validationLevel !== 'strict' || collection.options?.validationAction !== 'error' || !collection.options?.validator) validatorProblems.push(`${name}:validator`)
      else if (stableJson(collection.options.validator) !== stableJson(AUTH_CORE_COLLECTIONS[name].validator)) validatorProblems.push(`${name}:validator-definition`)
      const actualIndexes = await context.db.collection(name).indexes()
      const actualByName = new Map(actualIndexes.map((index) => [index.name, index]))
      for (const index of AUTH_CORE_INDEXES[name]) {
        const actual = actualByName.get(index.name)
        if (!actual) { missing.push(`${name}:index:${index.name}`); continue }
        if (JSON.stringify(actual.key) !== JSON.stringify(index.key)) missing.push(`${name}:index:${index.name}:key`)
        for (const option of ['unique', 'expireAfterSeconds']) if (index.options?.[option] !== undefined && actual[option] !== index.options[option]) missing.push(`${name}:index:${index.name}:${option}`)
        if (index.options?.partialFilterExpression && JSON.stringify(actual.partialFilterExpression) !== JSON.stringify(index.options.partialFilterExpression)) missing.push(`${name}:index:${index.name}:partial`)
      }
    }
    const plans = [
      ['users_email', 'users', { $and: [{ emailNormalized: 'probe@example.com' }, { emailNormalized: { $type: 'string' } }] }, { emailNormalized: 1 }],
      ['sessions_token', 'sessions', { tokenHash: 'a'.repeat(64) }, { tokenHash: 1 }],
      ['sessions_user_status', 'sessions', { userId: 'probe', status: 'active' }, { userId: 1, status: 1 }],
      ['rate_limit_key_version', 'rateLimitBuckets', { keyVersion: 1 }, { keyVersion: 1 }],
      ['audit_event', 'adminAuditLogs', { eventId: 'probe-event' }, { eventId: 1 }],
      ['audit_ip_cleanup', 'adminAuditLogs', { ipHmacPurgeAfter: { $lte: new Date() } }, { ipHmacPurgeAfter: 1, _id: 1 }],
      ['audit_cleanup', 'adminAuditLogs', { purgeAfter: { $lte: new Date() } }, { purgeAfter: 1, _id: 1 }],
      ['hmac_lifecycle_latest', 'hmacKeyLifecycleSnapshots', { inventoryId: 'quota-hmac' }, { revision: -1 }],
    ]
    const planProblems = []
    for (const [label, collectionName, filter, sort] of plans) {
      const explain = await context.db.collection(collectionName).find(filter).sort(sort).explain('queryPlanner')
      const stages = []
      const visit = (node) => {
        if (!node || typeof node !== 'object') return
        if (node.stage) stages.push(node.stage)
        for (const value of Object.values(node)) if (value && typeof value === 'object') visit(value)
      }
      visit(explain.queryPlanner?.winningPlan)
      if (stages.includes('COLLSCAN') || stages.includes('SORT')) planProblems.push(`${label}:${stages.join(',')}`)
    }
    let roleStatus = 'unavailable-local'
    const roleProblems = []
    try {
      const connection = await context.db.command({ connectionStatus: 1, showPrivileges: true })
      const privileges = connection.authInfo?.authenticatedUserPrivileges
      if (Array.isArray(privileges) && privileges.length > 0) {
        roleStatus = 'verified'
        for (const [collectionName, label] of [['adminAuditLogs', 'audit'], ['hmacKeyLifecycleSnapshots', 'HMAC lifecycle']]) {
          const actions = actionsForCollection(privileges, context.database, collectionName)
          if (!actions.has('find') || !actions.has('insert')) roleProblems.push(`${label} role needs find+insert`)
          if (['update', 'remove', 'delete'].some((action) => actions.has(action))) roleProblems.push(`${label} role has forbidden mutation privilege`)
        }
      }
    } catch {
      roleStatus = 'unavailable-local'
    }
    if (requireRole) {
      const probe = await probeAuditRoleCapabilities(context)
      if (!probe.inserted || !probe.findAllowed || !probe.updateDenied || !probe.deleteDenied) roleProblems.push('runtime Mongo role capability probe failed')
      const lifecycleProbe = await probeHmacLifecycleRoleCapabilities(context)
      if (!lifecycleProbe.inserted || !lifecycleProbe.findAllowed || !lifecycleProbe.updateDenied || !lifecycleProbe.deleteDenied) roleProblems.push('runtime HMAC lifecycle role capability probe failed')
      if (roleProblems.length === 0) roleStatus = 'verified'
    }
    if (missing.length > 0 || validatorProblems.length > 0 || planProblems.length > 0 || roleProblems.length > 0) {
      console.error(JSON.stringify({ verified: false, missing, validatorProblems, planProblems, roleProblems, roleStatus }))
      process.exitCode = 1
    } else {
      console.log(JSON.stringify({ verified: true, collections: Object.keys(AUTH_CORE_COLLECTIONS).length, roleStatus }))
    }
  } catch {
    console.error('Verification failed: runtime_or_database_error')
    process.exitCode = 1
  } finally {
    await closeMongoConnection()
  }
}
