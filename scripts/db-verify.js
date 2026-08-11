import { validateMongoConfiguration } from '../server/config/runtime.js'
import { ObjectId } from 'mongodb'
import { getMongoContext, closeMongoConnection } from '../server/repositories/mongo/connection.js'
import { AUTH_CORE_COLLECTIONS, AUTH_CORE_INDEXES } from './migrations/auth-core.js'
import { SOURCE_AUDIT_VALIDATOR, SOURCE_COLLECTIONS, SOURCE_INDEXES } from './migrations/sources.js'
import {
  DURABLE_JOB_AUDIT_VALIDATOR,
  DURABLE_JOB_COLLECTIONS,
  DURABLE_JOB_INDEXES,
} from './migrations/durable-jobs.js'
import { ARTICLE_COLLECTIONS, ARTICLE_INDEXES } from './migrations/articles.js'
import {
  INDEXING_ARTICLE_INDEXES,
  INDEXING_JOB_AUDIT_VALIDATOR,
  INDEXING_JOB_COLLECTIONS,
  INDEXING_JOB_INDEXES,
} from './migrations/indexing-jobs.js'
import {
  actionsForCollection,
  probeAuditRoleCapabilities,
  probeHmacLifecycleRoleCapabilities,
  probeSourcesRoleCapabilities,
} from './mongo-role-probe.js'
import { configureDns } from './configure-dns.js'
import { exactMongoIndex } from '../server/repositories/mongo/index-contract.js'

configureDns()

const target = process.argv.slice(2).find((value) => !value.startsWith('-')) ?? 'auth-core'
const requireRole = process.argv.includes('--require-role')

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`
  if (value && typeof value === 'object')
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`)
      .join(',')}}`
  return JSON.stringify(value)
}

function exactArticleIndex(actual, expected) {
  if (expected.name !== 'articles_search_text') return exactMongoIndex(actual, expected)
  const expectedFields = Object.keys(expected.key)
    .filter((field) => expected.key[field] === 'text')
    .sort()
  const expectedWeights = Object.fromEntries(expectedFields.map((field) => [field, 1]))
  return (
    stableJson(actual?.key) === stableJson({ _fts: 'text', _ftsx: 1 }) &&
    stableJson(actual?.weights) === stableJson(expectedWeights) &&
    stableJson(actual.default_language) === stableJson(expected.options?.default_language)
  )
}
if (!['auth-core', 'sources', 'durable-jobs', 'articles', 'indexing-jobs'].includes(target)) {
  console.error(
    'Supported verification targets: auth-core, sources, durable-jobs, articles, indexing-jobs',
  )
  process.exitCode = 2
} else {
  try {
    const runtime = { mongo: validateMongoConfiguration(process.env) }
    const context = await getMongoContext(runtime)
    const collections = await context.db.listCollections({}, { nameOnly: false }).toArray()
    const collectionMap = new Map(collections.map((collection) => [collection.name, collection]))
    const missing = []
    const validatorProblems = []
    const expectedCollections =
      target === 'sources'
        ? SOURCE_COLLECTIONS
        : target === 'durable-jobs'
          ? DURABLE_JOB_COLLECTIONS
          : target === 'articles'
            ? ARTICLE_COLLECTIONS
            : target === 'indexing-jobs'
              ? INDEXING_JOB_COLLECTIONS
              : AUTH_CORE_COLLECTIONS
    const expectedIndexes =
      target === 'sources'
        ? SOURCE_INDEXES
        : target === 'durable-jobs'
          ? DURABLE_JOB_INDEXES
          : target === 'articles'
            ? ARTICLE_INDEXES
            : target === 'indexing-jobs'
              ? INDEXING_JOB_INDEXES
              : AUTH_CORE_INDEXES
    for (const name of Object.keys(expectedCollections)) {
      const collection = collectionMap.get(name)
      if (!collection) {
        missing.push(`${name}:collection`)
        continue
      }
      if (
        collection.options?.validationLevel !== 'strict' ||
        collection.options?.validationAction !== 'error' ||
        !collection.options?.validator
      )
        validatorProblems.push(`${name}:validator`)
      else {
        const accepted =
          target === 'auth-core' && name === 'adminAuditLogs'
            ? [
                AUTH_CORE_COLLECTIONS[name].validator,
                SOURCE_AUDIT_VALIDATOR,
                DURABLE_JOB_AUDIT_VALIDATOR,
                INDEXING_JOB_AUDIT_VALIDATOR,
              ]
            : [expectedCollections[name].validator]
        if (
          !accepted.some(
            (validator) => stableJson(collection.options.validator) === stableJson(validator),
          )
        )
          validatorProblems.push(`${name}:validator-definition`)
      }
      const actualIndexes = await context.db.collection(name).indexes()
      const actualByName = new Map(actualIndexes.map((index) => [index.name, index]))
      for (const index of expectedIndexes[name]) {
        const actual = actualByName.get(index.name)
        if (!actual) {
          missing.push(`${name}:index:${index.name}`)
          continue
        }
        if (
          index.name !== 'articles_search_text' &&
          stableJson(actual.key) !== stableJson(index.key)
        )
          missing.push(`${name}:index:${index.name}:key`)
        const exact =
          target === 'articles' ? exactArticleIndex(actual, index) : exactMongoIndex(actual, index)
        if (!exact) missing.push(`${name}:index:${index.name}:semantic-options`)
      }
    }
    if (
      target === 'sources' ||
      target === 'durable-jobs' ||
      target === 'articles' ||
      target === 'indexing-jobs'
    ) {
      const auditCollection = collectionMap.get('adminAuditLogs')
      if (!auditCollection) missing.push('adminAuditLogs:collection')
      else {
        const acceptedAuditValidators =
          target === 'indexing-jobs'
            ? [INDEXING_JOB_AUDIT_VALIDATOR]
            : target === 'durable-jobs' || target === 'articles'
              ? [DURABLE_JOB_AUDIT_VALIDATOR, INDEXING_JOB_AUDIT_VALIDATOR]
              : [SOURCE_AUDIT_VALIDATOR, DURABLE_JOB_AUDIT_VALIDATOR, INDEXING_JOB_AUDIT_VALIDATOR]
        if (
          auditCollection.options?.validationLevel !== 'strict' ||
          auditCollection.options?.validationAction !== 'error' ||
          !acceptedAuditValidators.some(
            (validator) => stableJson(auditCollection.options?.validator) === stableJson(validator),
          )
        )
          validatorProblems.push(`adminAuditLogs:${target}-audit-validator-definition`)
      }
    }
    if (target === 'durable-jobs') {
      const leaseIndexes = await context.db.collection('jobLeases').indexes()
      for (const index of leaseIndexes)
        if (index.expireAfterSeconds !== undefined)
          missing.push(`jobLeases:index:${index.name}:ttl-forbidden`)
    }
    if (target === 'indexing-jobs') {
      if (!collectionMap.has('articles')) missing.push('articles:collection')
      else {
        const actualByName = new Map(
          (await context.db.collection('articles').indexes()).map((index) => [index.name, index]),
        )
        for (const expected of INDEXING_ARTICLE_INDEXES)
          if (!exactMongoIndex(actualByName.get(expected.name), expected))
            missing.push(`articles:index:${expected.name}`)
      }
    }
    const plans =
      target === 'sources'
        ? [
            ['sources_cursor', 'sources', {}, { createdAt: -1, _id: -1 }],
            [
              'sources_connector_status',
              'sources',
              { connectorType: 'rss', operationalStatus: 'active' },
              { connectorType: 1, operationalStatus: 1 },
            ],
            [
              'sources_reconciliation',
              'sources',
              { 'reconciliation.status': 'pending' },
              { 'reconciliation.status': 1, 'reconciliation.requiredPolicyVersion': 1 },
            ],
          ]
        : target === 'durable-jobs'
          ? [
              [
                'ingestion_due_normal',
                'ingestionJobs',
                {
                  status: 'queued',
                  availableAt: { $lte: new Date() },
                  agingEligibleAt: { $gt: new Date() },
                },
                { priority: -1, availableAt: 1, createdAt: 1, _id: 1 },
                'ingestion_due_normal',
              ],
              [
                'ingestion_due_aged',
                'ingestionJobs',
                {
                  status: 'queued',
                  agingEligibleAt: { $lte: new Date() },
                  availableAt: { $lte: new Date() },
                },
                { agingEligibleAt: 1, availableAt: 1, createdAt: 1, _id: 1 },
                'ingestion_due_aged',
              ],
              [
                'ingestion_purge',
                'ingestionJobs',
                { purgeAfter: { $lte: new Date() } },
                { purgeAfter: 1, _id: 1 },
                'ingestion_purge_deadline',
              ],
              [
                'job_lease_expiry',
                'jobLeases',
                { 'activeOwner.expiresAt': { $lte: new Date() } },
                { 'activeOwner.expiresAt': 1 },
                'job_lease_expiry',
              ],
              [
                'ingestion_schedule_period',
                'ingestionScheduleProgress',
                { period: '2026-08-10' },
                { period: 1 },
                'ingestion_schedule_period_unique',
              ],
            ]
          : target === 'indexing-jobs'
            ? [
                [
                  'indexing_due_normal',
                  'indexingJobs',
                  {
                    status: 'queued',
                    availableAt: { $lte: new Date() },
                    agingEligibleAt: { $gt: new Date() },
                  },
                  { priority: -1, availableAt: 1, createdAt: 1, _id: 1 },
                  'indexing_due_normal',
                ],
                [
                  'indexing_due_aged',
                  'indexingJobs',
                  {
                    status: 'queued',
                    agingEligibleAt: { $lte: new Date() },
                    availableAt: { $lte: new Date() },
                  },
                  { agingEligibleAt: 1, availableAt: 1, createdAt: 1, _id: 1 },
                  'indexing_due_aged',
                ],
                [
                  'indexing_article_created',
                  'indexingJobs',
                  { articleId: new ObjectId('000000000000000000000001') },
                  { createdAt: -1 },
                  'indexing_article_created',
                ],
                [
                  'indexing_source_status_available',
                  'indexingJobs',
                  { sourceId: new ObjectId('000000000000000000000001'), status: 'queued' },
                  { availableAt: 1 },
                  'indexing_source_status_available',
                ],
                [
                  'indexing_purge',
                  'indexingJobs',
                  { purgeAfter: { $lte: new Date() } },
                  { purgeAfter: 1, _id: 1 },
                  'indexing_purge_deadline',
                ],
                [
                  'provider_domain',
                  'providerAdmissionStates',
                  { admissionDomainId: 'probe' },
                  undefined,
                  'provider_admission_domain_unique',
                ],
                [
                  'provider_route',
                  'providerAdmissionStates',
                  { 'routeCircuits.routeId': 'probe' },
                  { _id: 1 },
                  'provider_route_circuit',
                ],
                [
                  'articles_source_reconciliation',
                  'articles',
                  { sourceId: new ObjectId('000000000000000000000001') },
                  { _id: 1 },
                  'articles_source_reconciliation',
                ],
              ]
            : target === 'articles'
              ? [
                  [
                    'articles_published',
                    'articles',
                    { status: 'published' },
                    { publishedAt: -1, _id: -1 },
                    'articles_status_published',
                  ],
                  [
                    'articles_topic_time',
                    'articles',
                    { status: 'published', topics: 'ai' },
                    { publishedAt: -1 },
                    'articles_status_topic_time',
                  ],
                  [
                    'articles_source_time',
                    'articles',
                    { status: 'published', sourceId: new ObjectId('000000000000000000000001') },
                    { publishedAt: -1 },
                    'articles_status_source_time',
                  ],
                  [
                    'articles_embedding_status',
                    'articles',
                    { embeddingStatus: 'pending' },
                    undefined,
                    'articles_embedding_status',
                  ],
                  ['articles_search_text', 'articles', { $text: { $search: 'ai' } }],
                ]
              : [
                  [
                    'users_email',
                    'users',
                    {
                      $and: [
                        { emailNormalized: 'probe@example.com' },
                        { emailNormalized: { $type: 'string' } },
                      ],
                    },
                    { emailNormalized: 1 },
                  ],
                  ['sessions_token', 'sessions', { tokenHash: 'a'.repeat(64) }, { tokenHash: 1 }],
                  [
                    'sessions_user_status',
                    'sessions',
                    { userId: 'probe', status: 'active' },
                    { userId: 1, status: 1 },
                  ],
                  [
                    'rate_limit_key_version',
                    'rateLimitBuckets',
                    { keyVersion: 1 },
                    { keyVersion: 1 },
                  ],
                  ['audit_event', 'adminAuditLogs', { eventId: 'probe-event' }, { eventId: 1 }],
                  [
                    'audit_ip_cleanup',
                    'adminAuditLogs',
                    { ipHmacPurgeAfter: { $lte: new Date() } },
                    { ipHmacPurgeAfter: 1, _id: 1 },
                  ],
                  [
                    'audit_cleanup',
                    'adminAuditLogs',
                    { purgeAfter: { $lte: new Date() } },
                    { purgeAfter: 1, _id: 1 },
                  ],
                  [
                    'hmac_lifecycle_latest',
                    'hmacKeyLifecycleSnapshots',
                    { inventoryId: 'quota-hmac' },
                    { revision: -1 },
                  ],
                ]
    const planProblems = []
    for (const [label, collectionName, filter, sort, hint] of plans) {
      if (!collectionMap.has(collectionName)) continue
      const cursor = context.db.collection(collectionName).find(filter).sort(sort)
      if (hint) cursor.hint(hint)
      const explain = await cursor.explain('queryPlanner')
      const stages = []
      const visit = (node) => {
        if (!node || typeof node !== 'object') return
        if (node.stage) stages.push(node.stage)
        for (const value of Object.values(node))
          if (value && typeof value === 'object') visit(value)
      }
      visit(explain.queryPlanner?.winningPlan)
      if (stages.includes('COLLSCAN') || stages.includes('SORT'))
        planProblems.push(`${label}:${stages.join(',')}`)
    }
    let roleStatus =
      target === 'sources' ||
      target === 'durable-jobs' ||
      target === 'articles' ||
      target === 'indexing-jobs'
        ? 'not-requested'
        : 'unavailable-local'
    const roleProblems = []
    try {
      const connection = await context.db.command({ connectionStatus: 1, showPrivileges: true })
      const privileges = connection.authInfo?.authenticatedUserPrivileges
      if (Array.isArray(privileges) && privileges.length > 0) {
        if (target === 'auth-core') roleStatus = 'verified'
        for (const [collectionName, label] of target === 'sources'
          ? [
              ['sources', 'sources'],
              ['adminAuditLogs', 'audit'],
            ]
          : ['durable-jobs', 'indexing-jobs'].includes(target)
            ? []
            : [
                ['adminAuditLogs', 'audit'],
                ['hmacKeyLifecycleSnapshots', 'HMAC lifecycle'],
              ]) {
          const actions = actionsForCollection(privileges, context.database, collectionName)
          const required =
            collectionName === 'sources'
              ? ['find', 'insert', 'update', 'listIndexes', 'listCollections']
              : ['find', 'insert']
          for (const action of required)
            if (!actions.has(action)) roleProblems.push(`${label} role needs ${action}`)
          const forbidden =
            collectionName === 'sources' ? ['remove', 'delete'] : ['update', 'remove', 'delete']
          for (const action of forbidden)
            if (actions.has(action)) roleProblems.push(`${label} role has forbidden ${action}`)
        }
      }
    } catch {
      roleStatus = 'unavailable-local'
    }
    const schemaReady =
      missing.length === 0 && validatorProblems.length === 0 && planProblems.length === 0
    if (requireRole && !schemaReady) {
      roleStatus = 'blocked-by-schema'
    } else if (requireRole && target === 'sources') {
      const sourceProbe = await probeSourcesRoleCapabilities(context)
      for (const [capability, passed] of Object.entries(sourceProbe))
        if (!passed) roleProblems.push(`sources runtime capability failed: ${capability}`)
      const auditProbe = await probeAuditRoleCapabilities(context)
      for (const [capability, passed] of Object.entries(auditProbe))
        if (!passed) roleProblems.push(`source audit runtime capability failed: ${capability}`)
      if (roleProblems.length === 0) roleStatus = 'verified'
    } else if (requireRole && target === 'auth-core') {
      const probe = await probeAuditRoleCapabilities(context)
      if (!probe.inserted || !probe.findAllowed || !probe.updateDenied || !probe.deleteDenied)
        roleProblems.push('runtime Mongo role capability probe failed')
      const lifecycleProbe = await probeHmacLifecycleRoleCapabilities(context)
      if (
        !lifecycleProbe.inserted ||
        !lifecycleProbe.findAllowed ||
        !lifecycleProbe.updateDenied ||
        !lifecycleProbe.deleteDenied
      )
        roleProblems.push('runtime HMAC lifecycle role capability probe failed')
      if (roleProblems.length === 0) roleStatus = 'verified'
    } else if (requireRole && (target === 'articles' || target === 'indexing-jobs')) {
      roleStatus = 'not-requested'
    } else if (requireRole) {
      roleProblems.push('durable-jobs runtime role capability probe is not registered')
    }
    if (
      missing.length > 0 ||
      validatorProblems.length > 0 ||
      planProblems.length > 0 ||
      roleProblems.length > 0
    ) {
      console.error(
        JSON.stringify({
          verified: false,
          missing,
          validatorProblems,
          planProblems,
          roleProblems,
          roleStatus,
        }),
      )
      process.exitCode = 1
    } else {
      console.log(
        JSON.stringify({
          verified: true,
          collections: Object.keys(expectedCollections).length,
          roleStatus,
        }),
      )
    }
  } catch {
    console.error('Verification failed: runtime_or_database_error')
    process.exitCode = 1
  } finally {
    await closeMongoConnection()
  }
}
