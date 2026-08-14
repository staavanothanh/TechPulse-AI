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
  CHAT_SESSION_COLLECTIONS,
  CHAT_SESSION_INDEXES,
} from './migrations/chat-sessions.js'
import { GOVERNANCE_COLLECTIONS, GOVERNANCE_INDEXES, GOVERNANCE_DATABASE_COLLECTIONS, GOVERNANCE_DATABASE_INDEXES } from './migrations/governance.js'
import { GOVERNANCE_AUDIT_VALIDATOR } from './migrations/governance-audit.js'
import { GOVERNANCE_HARDENING_INDEXES } from './migrations/governance-hardening.js'
import {
  actionsForCollection,
  probeAuditRoleCapabilities,
  probeHmacLifecycleRoleCapabilities,
  probeSourcesRoleCapabilities,
  probeGovernanceRoleCapabilities,
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

const CHAT_ROLE_PROBE_USER_ID = new ObjectId('000000000000000000000001')
const CHAT_ROLE_PROBE_SESSION_ID = new ObjectId('000000000000000000000002')
const CHAT_ROLE_PROBE_CHAT_ID = new ObjectId('000000000000000000000003')
const CHAT_ROLE_PROBE_ATTEMPT_ID = new ObjectId('000000000000000000000004')

async function runChatRoleTransaction(client, work) {
  let session
  let transactionStarted = false
  let sessionHealthy = true
  let outcome
  try {
    session = client.startSession()
    await session.startTransaction()
    transactionStarted = true
    const value = await work(session)
    outcome = { transactionStarted, operationFailed: false, value }
  } catch (error) {
    outcome = { transactionStarted, operationFailed: true, error }
  } finally {
    try { if (session && transactionStarted) await session.abortTransaction() } catch { sessionHealthy = false }
    try { if (session) await session.endSession() } catch { sessionHealthy = false }
  }
  return { ...outcome, sessionHealthy }
}

async function probeChatSessionsRoleCapabilities({ client, db } = {}) {
  if (!client?.startSession || !db?.collection) {
    return {
      transaction: false,
      chatSessionsRuntime: false,
      answerAttemptsRuntime: false,
      answerAttemptsMaintenanceDelete: false,
    }
  }
  const now = new Date()
  const chatSession = {
    _id: CHAT_ROLE_PROBE_CHAT_ID,
    userId: CHAT_ROLE_PROBE_USER_ID,
    title: null,
    scope: { topics: ['role-probe'] },
    messages: [],
    messageCount: 0,
    expiresAt: new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000),
    createdAt: now,
    updatedAt: now,
  }
  const answerAttempt = {
    _id: CHAT_ROLE_PROBE_ATTEMPT_ID,
    userId: CHAT_ROLE_PROBE_USER_ID,
    sessionId: CHAT_ROLE_PROBE_SESSION_ID,
    expectedSessionVersion: 1,
    idempotencyKeyHash: 'b'.repeat(64),
    requestHash: 'c'.repeat(64),
    status: 'reserved',
    quotaReservationKey: 'role-probe',
    expiresAt: new Date(now.getTime() + 24 * 60 * 60 * 1000),
    createdAt: now,
    updatedAt: now,
  }
  const chat = await runChatRoleTransaction(client, async (session) => {
    const collection = db.collection('chatSessions')
    await collection.insertOne(chatSession, { session })
    await collection.updateOne({ _id: chatSession._id }, { $set: { title: 'role-probe' } }, { session })
    const found = await collection.findOne({ _id: chatSession._id }, { session, projection: { _id: 1 } })
    return found?._id?.equals?.(chatSession._id) === true
  })
  const attempts = await runChatRoleTransaction(client, async (session) => {
    const collection = db.collection('answerAttempts')
    await collection.insertOne(answerAttempt, { session })
    await collection.updateOne({ _id: answerAttempt._id }, { $set: { status: 'provider-running' } }, { session })
    const found = await collection.findOne({ _id: answerAttempt._id }, { session, projection: { _id: 1 } })
    return found?._id?.equals?.(answerAttempt._id) === true
  })
  const maintenance = await runChatRoleTransaction(client, async (session) => {
    const collection = db.collection('answerAttempts')
    const expiredAt = new Date(now.getTime() - 1)
    const expiredCreatedAt = new Date(expiredAt.getTime() - 24 * 60 * 60 * 1000)
    await collection.insertOne({ ...answerAttempt, createdAt: expiredCreatedAt, updatedAt: expiredCreatedAt, expiresAt: expiredAt }, { session })
    const deleted = await collection.deleteMany({ _id: answerAttempt._id, expiresAt: { $lte: now } }, { session })
    return deleted.deletedCount === 1
  })
  return {
    transaction: chat.transactionStarted && attempts.transactionStarted && maintenance.transactionStarted && chat.sessionHealthy && attempts.sessionHealthy && maintenance.sessionHealthy,
    chatSessionsRuntime: chat.value === true && !chat.operationFailed && chat.sessionHealthy,
    answerAttemptsRuntime: attempts.value === true && !attempts.operationFailed && attempts.sessionHealthy,
    answerAttemptsMaintenanceDelete: maintenance.value === true && !maintenance.operationFailed && maintenance.sessionHealthy,
  }
}
if (!['auth-core', 'sources', 'durable-jobs', 'articles', 'indexing-jobs', 'chat-sessions', 'governance'].includes(target)) {
  console.error(
    'Supported verification targets: auth-core, sources, durable-jobs, articles, indexing-jobs, chat-sessions, governance',
  )
  process.exitCode = 2
} else {
  let verificationStage = 'configuration'
  try {
    const runtime = { mongo: validateMongoConfiguration(process.env) }
    verificationStage = 'connection'
    const context = await getMongoContext(runtime)
    verificationStage = 'schema-list-app'
    const collections = await context.db.listCollections({}, { nameOnly: false }).toArray()
    const collectionMap = new Map(collections.map((collection) => [collection.name, collection]))
    const missing = []
    const validatorProblems = []
    const governanceContext = target === 'governance' ? { db: context.client.db('techpulse_governance') } : null
    verificationStage = 'schema-list-governance'
    let governanceMetadataUnavailable = false
    let governanceCollections = []
    if (governanceContext) {
      try { governanceCollections = await governanceContext.db.listCollections({}, { nameOnly: false }).toArray() } catch { governanceMetadataUnavailable = true }
    }
    const governanceMap = new Map(governanceCollections.map((collection) => [collection.name, collection]))
    const expectedCollections =
      target === 'sources'
        ? SOURCE_COLLECTIONS
        : target === 'durable-jobs'
          ? DURABLE_JOB_COLLECTIONS
          : target === 'articles'
            ? ARTICLE_COLLECTIONS
            : target === 'indexing-jobs'
              ? INDEXING_JOB_COLLECTIONS
              : target === 'chat-sessions'
                ? CHAT_SESSION_COLLECTIONS
              : target === 'governance' ? GOVERNANCE_COLLECTIONS : AUTH_CORE_COLLECTIONS
    const expectedIndexes =
      target === 'sources'
        ? SOURCE_INDEXES
        : target === 'durable-jobs'
          ? DURABLE_JOB_INDEXES
          : target === 'articles'
            ? ARTICLE_INDEXES
            : target === 'indexing-jobs'
              ? INDEXING_JOB_INDEXES
              : target === 'chat-sessions'
                ? CHAT_SESSION_INDEXES
              : target === 'governance' ? { ...GOVERNANCE_INDEXES, takedownRequests: [...GOVERNANCE_INDEXES.takedownRequests, ...GOVERNANCE_HARDENING_INDEXES.takedownRequests] } : AUTH_CORE_INDEXES
    verificationStage = 'schema-app'
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
                GOVERNANCE_AUDIT_VALIDATOR,
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
    if (target === 'governance') {
      verificationStage = 'schema-governance'
      if (governanceMetadataUnavailable) validatorProblems.push('techpulse_governance:metadata-unavailable')
      for (const [name, definition] of governanceMetadataUnavailable ? [] : Object.entries(GOVERNANCE_DATABASE_COLLECTIONS)) {
        const collection = governanceMap.get(name)
        if (!collection) { missing.push(`techpulse_governance:${name}:collection`); continue }
        if (collection.options?.validationLevel !== 'strict' || collection.options?.validationAction !== 'error' || stableJson(collection.options?.validator) !== stableJson(definition.validator)) validatorProblems.push(`techpulse_governance:${name}:validator-definition`)
        const actual = new Map((await governanceContext.db.collection(name).indexes()).map((index) => [index.name, index]))
        for (const expected of GOVERNANCE_DATABASE_INDEXES[name]) if (!exactMongoIndex(actual.get(expected.name), expected)) missing.push(`techpulse_governance:${name}:index:${expected.name}`)
      }
      verificationStage = 'schema-citation-indexes'
      const chatCollection = collectionMap.get('chatSessions')
      if (!chatCollection) missing.push('chatSessions:collection:governance-citation-probe')
      else {
        const chatIndexes = new Map((await context.db.collection('chatSessions').indexes()).map((index) => [index.name, index]))
        for (const expected of CHAT_SESSION_INDEXES.chatSessions.filter(({ name }) => name === 'chat_sessions_citation_article' || name === 'chat_sessions_citation_source')) {
          if (!exactMongoIndex(chatIndexes.get(expected.name), expected)) missing.push(`chatSessions:index:${expected.name}:governance-citation-probe`)
        }
      }
    }
    if (
      target === 'sources' ||
      target === 'durable-jobs' ||
      target === 'articles' ||
      target === 'indexing-jobs' ||
      target === 'chat-sessions'
    ) {
      const auditCollection = collectionMap.get('adminAuditLogs')
      if (!auditCollection) missing.push('adminAuditLogs:collection')
      else {
        const acceptedAuditValidators =
          target === 'indexing-jobs' || target === 'chat-sessions'
            ? [INDEXING_JOB_AUDIT_VALIDATOR, GOVERNANCE_AUDIT_VALIDATOR]
            : target === 'durable-jobs' || target === 'articles'
              ? [DURABLE_JOB_AUDIT_VALIDATOR, INDEXING_JOB_AUDIT_VALIDATOR, GOVERNANCE_AUDIT_VALIDATOR]
              : [SOURCE_AUDIT_VALIDATOR, DURABLE_JOB_AUDIT_VALIDATOR, INDEXING_JOB_AUDIT_VALIDATOR, GOVERNANCE_AUDIT_VALIDATOR]
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
            : target === 'chat-sessions'
              ? [
                  [
                    'chat_user_updated',
                    'chatSessions',
                    { userId: new ObjectId('000000000000000000000001') },
                    { updatedAt: -1, _id: -1 },
                    'chat_sessions_user_updated',
                  ],
                  [
                    'chat_citation_article',
                    'chatSessions',
                    { 'messages.citations.articleId': new ObjectId('000000000000000000000001') },
                    { _id: 1 },
                    'chat_sessions_citation_article',
                  ],
                  [
                    'chat_citation_source',
                    'chatSessions',
                    { 'messages.citations.sourceId': new ObjectId('000000000000000000000001') },
                    { _id: 1 },
                    'chat_sessions_citation_source',
                  ],
                  [
                    'chat_expiry',
                    'chatSessions',
                    { expiresAt: { $lte: new Date() } },
                    { expiresAt: 1 },
                    'chat_sessions_expires_ttl',
                  ],
                  [
                    'answer_attempts_identity',
                    'answerAttempts',
                    {
                      userId: new ObjectId('000000000000000000000001'),
                      sessionId: new ObjectId('000000000000000000000002'),
                      expectedSessionVersion: 1,
                      idempotencyKeyHash: 'a'.repeat(64),
                    },
                    undefined,
                    'answer_attempts_identity_unique',
                  ],
                  [
                    'answer_attempts_user_created',
                    'answerAttempts',
                    { userId: new ObjectId('000000000000000000000001') },
                    { createdAt: -1, _id: -1 },
                    'answer_attempts_user_created',
                  ],
                  [
                    'answer_attempts_expiry',
                    'answerAttempts',
                    { expiresAt: { $lte: new Date() } },
                    { expiresAt: 1, _id: 1 },
                    'answer_attempts_expiry_deadline',
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
              : target === 'governance'
                ? [
                    ['takedown_cleanup_due', 'takedownRequests', { status: 'approved', 'completion.historicalChatCitationsRedacted': false }, { updatedAt: 1, _id: 1 }, 'takedown_cleanup_due'],
                    ['takedown_pii_deadline', 'takedownRequests', { status: 'completed', piiPurgeAfter: { $lte: new Date() } }, { piiPurgeAfter: 1, _id: 1 }, 'takedown_pii_deadline'],
                    ['takedown_workflow_deadline', 'takedownRequests', { status: 'completed', workflowPurgeAfter: { $lte: new Date() } }, { workflowPurgeAfter: 1, _id: 1 }, 'takedown_workflow_deadline'],
                    ['account_deletion_aged', 'accountDeletionRequests', { status: 'queued', agingEligibleAt: { $lte: new Date() }, availableAt: { $lte: new Date() } }, { agingEligibleAt: 1, availableAt: 1, requestedAt: 1, _id: 1 }, 'account_deletion_aged'],
                    // Takedown cleanup traverses historical citations directly
                    // by article/source. These direct citation explain probes
                    // verify both compound indexes during the governance
                    // check; they do not depend on a separate chat-sessions
                    // verification run.
                    ['governance_chat_citation_article', 'chatSessions', { 'messages.citations.articleId': new ObjectId('000000000000000000000001') }, { _id: 1 }, 'chat_sessions_citation_article'],
                    ['governance_chat_citation_source', 'chatSessions', { 'messages.citations.sourceId': new ObjectId('000000000000000000000001') }, { _id: 1 }, 'chat_sessions_citation_source'],
                    ['governance_source_article_hide', 'articles', { status: { $in: ['published', 'processing', 'review-needed'] }, sourceId: new ObjectId('000000000000000000000001') }, { publishedAt: -1 }, 'articles_status_source_time'],
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
    verificationStage = 'query-plans'
    const planProblems = []
    for (const [label, collectionName, filter, sort, hint] of plans) {
      if (!collectionMap.has(collectionName)) continue
      verificationStage = `query-plan-${label}`
      try {
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
        if (stages.includes('COLLSCAN') || stages.includes('SORT')) planProblems.push(`${label}:${stages.join(',')}`)
      } catch {
        planProblems.push(`${label}:explain-unavailable`)
      }
    }
    verificationStage = 'role-inspection'
    let roleStatus =
      target === 'sources' ||
      target === 'durable-jobs' ||
      target === 'articles' ||
      target === 'indexing-jobs' ||
      target === 'chat-sessions' || target === 'governance'
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
          : ['durable-jobs', 'indexing-jobs', 'chat-sessions'].includes(target)
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
    if (requireRole && !schemaReady && target !== 'governance') {
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
    } else if (requireRole && target === 'chat-sessions') {
      const probe = await probeChatSessionsRoleCapabilities(context)
      for (const [capability, passed] of Object.entries(probe)) {
        if (passed) continue
        if (capability === 'answerAttemptsMaintenanceDelete') roleProblems.push('answerAttempts maintenance capability failed: delete')
        else roleProblems.push(`chat-sessions runtime capability failed: ${capability}`)
      }
      roleStatus = roleProblems.length === 0 ? 'verified' : 'unverified'
    } else if (requireRole && target === 'governance') {
      verificationStage = 'governance-role-probe'
      const probe = await probeGovernanceRoleCapabilities({ ...context, governanceDb: governanceContext.db })
      for (const [capability, passed] of Object.entries(probe)) if (!passed) roleProblems.push(`governance runtime capability failed: ${capability}`)
      roleStatus = roleProblems.length === 0 ? schemaReady ? 'verified' : 'capabilities-verified-schema-unverified' : 'unverified'
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
    console.error(`Verification failed: ${verificationStage}_error`)
    process.exitCode = 1
  } finally {
    await closeMongoConnection()
  }
}
