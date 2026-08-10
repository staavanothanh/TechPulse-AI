import { validateMongoConfiguration } from '../server/config/runtime.js'
import { getMongoContext, closeMongoConnection } from '../server/repositories/mongo/connection.js'
import { AUTH_CORE_COLLECTIONS, AUTH_CORE_INDEXES } from './migrations/auth-core.js'
import { SOURCE_AUDIT_VALIDATOR, SOURCE_COLLECTIONS, SOURCE_INDEXES } from './migrations/sources.js'
import { actionsForCollection, probeAuditRoleCapabilities, probeHmacLifecycleRoleCapabilities, probeSourcesRoleCapabilities } from './mongo-role-probe.js'
import { configureDns } from './configure-dns.js'

configureDns()

const target = process.argv.slice(2).find((value) => !value.startsWith('-')) ?? 'auth-core'
const requireRole = process.argv.includes('--require-role')

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`
  return JSON.stringify(value)
}
if (!['auth-core', 'sources'].includes(target)) {
  console.error('Supported verification targets: auth-core, sources')
  process.exitCode = 2
} else {
  try {
    const runtime = { mongo: validateMongoConfiguration(process.env) }
    const context = await getMongoContext(runtime)
    const collections = await context.db.listCollections({}, { nameOnly: false }).toArray()
    const collectionMap = new Map(collections.map((collection) => [collection.name, collection]))
    const missing = []
    const validatorProblems = []
    const expectedCollections = target === 'sources' ? SOURCE_COLLECTIONS : AUTH_CORE_COLLECTIONS
    const expectedIndexes = target === 'sources' ? SOURCE_INDEXES : AUTH_CORE_INDEXES
    for (const name of Object.keys(expectedCollections)) {
      const collection = collectionMap.get(name)
      if (!collection) { missing.push(`${name}:collection`); continue }
      if (collection.options?.validationLevel !== 'strict' || collection.options?.validationAction !== 'error' || !collection.options?.validator) validatorProblems.push(`${name}:validator`)
      else {
        const accepted = target === 'auth-core' && name === 'adminAuditLogs' ? [AUTH_CORE_COLLECTIONS[name].validator, SOURCE_AUDIT_VALIDATOR] : [expectedCollections[name].validator]
        if (!accepted.some((validator) => stableJson(collection.options.validator) === stableJson(validator))) validatorProblems.push(`${name}:validator-definition`)
      }
      const actualIndexes = await context.db.collection(name).indexes()
      const actualByName = new Map(actualIndexes.map((index) => [index.name, index]))
      for (const index of expectedIndexes[name]) {
        const actual = actualByName.get(index.name)
        if (!actual) { missing.push(`${name}:index:${index.name}`); continue }
        if (JSON.stringify(actual.key) !== JSON.stringify(index.key)) missing.push(`${name}:index:${index.name}:key`)
        for (const option of ['unique', 'expireAfterSeconds']) if (index.options?.[option] !== undefined && actual[option] !== index.options[option]) missing.push(`${name}:index:${index.name}:${option}`)
        if (index.options?.partialFilterExpression && JSON.stringify(actual.partialFilterExpression) !== JSON.stringify(index.options.partialFilterExpression)) missing.push(`${name}:index:${index.name}:partial`)
      }
    }
    if (target === 'sources') {
      const auditCollection = collectionMap.get('adminAuditLogs')
      if (!auditCollection) missing.push('adminAuditLogs:collection')
      else if (auditCollection.options?.validationLevel !== 'strict' || auditCollection.options?.validationAction !== 'error' || stableJson(auditCollection.options?.validator) !== stableJson(SOURCE_AUDIT_VALIDATOR)) validatorProblems.push('adminAuditLogs:source-audit-validator-definition')
    }
    const plans = target === 'sources' ? [
      ['sources_cursor', 'sources', {}, { createdAt: -1, _id: -1 }],
      ['sources_connector_status', 'sources', { connectorType: 'rss', operationalStatus: 'active' }, { connectorType: 1, operationalStatus: 1 }],
      ['sources_reconciliation', 'sources', { 'reconciliation.status': 'pending' }, { 'reconciliation.status': 1, 'reconciliation.requiredPolicyVersion': 1 }],
    ] : [
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
      if (!collectionMap.has(collectionName)) continue
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
    let roleStatus = target === 'sources' ? 'not-requested' : 'unavailable-local'
    const roleProblems = []
    try {
      const connection = await context.db.command({ connectionStatus: 1, showPrivileges: true })
      const privileges = connection.authInfo?.authenticatedUserPrivileges
      if (Array.isArray(privileges) && privileges.length > 0) {
        if (target === 'auth-core') roleStatus = 'verified'
        for (const [collectionName, label] of (target === 'sources' ? [['sources', 'sources'], ['adminAuditLogs', 'audit']] : [['adminAuditLogs', 'audit'], ['hmacKeyLifecycleSnapshots', 'HMAC lifecycle']])) {
          const actions = actionsForCollection(privileges, context.database, collectionName)
          const required = collectionName === 'sources' ? ['find', 'insert', 'update', 'listIndexes', 'listCollections'] : ['find', 'insert']
          for (const action of required) if (!actions.has(action)) roleProblems.push(`${label} role needs ${action}`)
          const forbidden = collectionName === 'sources' ? ['remove', 'delete'] : ['update', 'remove', 'delete']
          for (const action of forbidden) if (actions.has(action)) roleProblems.push(`${label} role has forbidden ${action}`)
        }
      }
    } catch {
      roleStatus = 'unavailable-local'
    }
    const schemaReady = missing.length === 0 && validatorProblems.length === 0 && planProblems.length === 0
    if (requireRole && !schemaReady) {
      roleStatus = 'blocked-by-schema'
    } else if (requireRole && target === 'sources') {
      const sourceProbe = await probeSourcesRoleCapabilities(context)
      for (const [capability, passed] of Object.entries(sourceProbe)) if (!passed) roleProblems.push(`sources runtime capability failed: ${capability}`)
      const auditProbe = await probeAuditRoleCapabilities(context)
      for (const [capability, passed] of Object.entries(auditProbe)) if (!passed) roleProblems.push(`source audit runtime capability failed: ${capability}`)
      if (roleProblems.length === 0) roleStatus = 'verified'
    } else if (requireRole) {
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
      console.log(JSON.stringify({ verified: true, collections: Object.keys(expectedCollections).length, roleStatus }))
    }
  } catch {
    console.error('Verification failed: runtime_or_database_error')
    process.exitCode = 1
  } finally {
    await closeMongoConnection()
  }
}
