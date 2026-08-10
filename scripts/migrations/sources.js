import { ObjectId } from 'mongodb'
import { AUTH_CORE_COLLECTIONS } from './auth-core.js'
import { validateConnectorUnit, validatePolicyCompatibility } from '../../server/domain/source/validation.js'

const date = Object.freeze({ bsonType: 'date' })
const nullableDate = Object.freeze({ bsonType: ['date', 'null'] })
const nullableString = (maximum = 4000) => ({ bsonType: ['string', 'null'], maxLength: maximum })
const publicHostnamePattern = '^(?!\\d{1,3}(?:\\.\\d{1,3}){3}$)(?!.*\\.(?:internal|local|localhost|localdomain|home|lan)$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$'
const publicHostname = Object.freeze({ bsonType: 'string', maxLength: 253, pattern: publicHostnamePattern })
const nullableHttpsUrl = Object.freeze({ bsonType: ['string', 'null'], maxLength: 2048, pattern: '^https://(?![^/?#]*@)' })
const safeError = Object.freeze({
  bsonType: 'object', additionalProperties: false, required: ['code', 'message', 'retryable', 'occurredAt'],
  properties: { code: { bsonType: 'string', minLength: 1, maxLength: 128 }, message: { bsonType: 'string', minLength: 1, maxLength: 500 }, retryable: { bsonType: 'bool' }, occurredAt: date, upstreamStatus: { bsonType: 'int', minimum: 100, maximum: 599 } },
})
const storageScope = Object.freeze({ bsonType: 'object', additionalProperties: false, required: ['metadata', 'excerpt', 'summary', 'embedding'], properties: { metadata: { bsonType: 'bool' }, excerpt: { bsonType: 'bool' }, summary: { bsonType: 'bool' }, embedding: { bsonType: 'bool' } } })
const mediaPolicy = Object.freeze({
  bsonType: 'object', additionalProperties: false, required: ['imageMode', 'videoMode', 'allowedHosts', 'attributionRequired', 'evidenceNote'],
  properties: {
    imageMode: { enum: ['none', 'remote-preview'] }, videoMode: { enum: ['none', 'link-only'] },
    allowedHosts: { bsonType: 'array', maxItems: 20, uniqueItems: true, items: publicHostname },
    attributionRequired: { bsonType: 'bool' }, evidenceNote: nullableString(),
  },
})
const connectorConfig = Object.freeze({ oneOf: [
  { bsonType: 'object', additionalProperties: false, required: ['kind', 'feedUrl', 'batchSize'], properties: { kind: { enum: ['rss'] }, feedUrl: { bsonType: 'string', pattern: '^https://(?![^/?#]*@)' }, batchSize: { bsonType: 'int', minimum: 1, maximum: 100 } } },
  { bsonType: 'object', additionalProperties: false, required: ['kind', 'arxivQuery', 'batchSize'], properties: { kind: { enum: ['arxiv'] }, arxivQuery: { bsonType: 'string', minLength: 1, maxLength: 200 }, batchSize: { bsonType: 'int', minimum: 1, maximum: 100 } } },
  { bsonType: 'object', additionalProperties: false, required: ['kind', 'hackerNewsStream', 'batchSize'], properties: { kind: { enum: ['hacker-news'] }, hackerNewsStream: { enum: ['topstories', 'newstories', 'beststories'] }, batchSize: { bsonType: 'int', minimum: 1, maximum: 100 } } },
] })

const sourceJsonSchema = Object.freeze({
  bsonType: 'object', additionalProperties: false,
  required: ['_id', 'name', 'sourceKey', 'publisherName', 'domain', 'connectorType', 'accessMethod', 'authorityTier', 'connectorConfig', 'operationalStatus', 'licenseStatus', 'llmInputScope', 'storageScope', 'mediaPolicy', 'attributionRequired', 'policyVersion', 'reconciliation', 'technicalCheck', 'health', 'createdAt', 'updatedAt'],
  properties: {
    _id: { bsonType: 'objectId' }, name: { bsonType: 'string', minLength: 1, maxLength: 120 }, sourceKey: { bsonType: 'string', pattern: '^[a-z0-9][a-z0-9:-]{2,119}$' }, publisherName: { bsonType: 'string', minLength: 1, maxLength: 160 },
    rightsHolderNote: nullableString(), domain: publicHostname, connectorType: { enum: ['rss', 'arxiv', 'hacker-news'] }, accessMethod: { enum: ['rss', 'atom', 'api'] }, authorityTier: { enum: ['primary', 'editorial', 'community-signal'] }, connectorConfig,
    operationalStatus: { enum: ['draft', 'testing', 'active', 'paused', 'archived'] }, licenseStatus: { enum: ['permitted', 'metadata-only', 'review-needed', 'blocked'] }, llmInputScope: { enum: ['metadata', 'excerpt', 'fulltext-temporary', 'none'] }, storageScope, mediaPolicy,
    attributionRequired: { bsonType: 'bool' }, attributionText: nullableString(500), termsUrl: nullableHttpsUrl, licenseUrl: nullableHttpsUrl, evidenceNote: nullableString(), reviewedAt: nullableDate, reviewedBy: { bsonType: ['objectId', 'null'] }, policyVersion: { bsonType: 'int', minimum: 1 },
    reconciliation: { bsonType: 'object', additionalProperties: false, required: ['status', 'requiredPolicyVersion', 'completedPolicyVersion', 'requestedAt', 'error'], properties: { status: { enum: ['idle', 'pending', 'processing', 'completed', 'failed'] }, requiredPolicyVersion: { bsonType: 'int', minimum: 1 }, completedPolicyVersion: { bsonType: ['int', 'null'], minimum: 1 }, requestedAt: nullableDate, cursorArticleId: { bsonType: 'objectId' }, error: { oneOf: [{ bsonType: 'null' }, safeError] } } },
    technicalCheck: { bsonType: 'object', additionalProperties: false, required: ['status', 'checkedAt', 'contentType', 'resolvedHost', 'sampleCount', 'error'], properties: { status: { enum: ['not-run', 'passed', 'failed'] }, checkedAt: nullableDate, contentType: nullableString(255), resolvedHost: { oneOf: [{ bsonType: 'null' }, publicHostname] }, sampleCount: { bsonType: ['int', 'null'], minimum: 0, maximum: 100 }, error: { oneOf: [{ bsonType: 'null' }, safeError] } } },
    health: { bsonType: 'object', additionalProperties: false, required: ['lastIngestSucceededAt', 'lastIngestFailedAt', 'consecutiveFailures', 'lastError'], properties: { lastIngestSucceededAt: nullableDate, lastIngestFailedAt: nullableDate, consecutiveFailures: { bsonType: 'int', minimum: 0 }, lastError: { oneOf: [{ bsonType: 'null' }, safeError] } } },
    createdAt: date, updatedAt: date,
  },
})

const connectorRules = Object.freeze({ $or: [
  { connectorType: 'rss', accessMethod: { $in: ['rss', 'atom'] }, authorityTier: { $in: ['primary', 'editorial'] }, 'connectorConfig.kind': 'rss' },
  { connectorType: 'arxiv', accessMethod: 'api', authorityTier: 'primary', 'connectorConfig.kind': 'arxiv' },
  { connectorType: 'hacker-news', accessMethod: 'api', authorityTier: 'community-signal', 'connectorConfig.kind': 'hacker-news' },
] })
const policyRules = Object.freeze({ $or: [
  { licenseStatus: 'review-needed', llmInputScope: 'none', storageScope: { metadata: false, excerpt: false, summary: false, embedding: false } },
  { licenseStatus: 'blocked', llmInputScope: 'none', storageScope: { metadata: false, excerpt: false, summary: false, embedding: false }, 'mediaPolicy.imageMode': 'none', 'mediaPolicy.videoMode': 'none', 'mediaPolicy.allowedHosts': { $size: 0 } },
  { licenseStatus: 'metadata-only', llmInputScope: { $in: ['none', 'metadata'] }, 'storageScope.metadata': true, 'storageScope.excerpt': false },
  { licenseStatus: 'permitted' },
] })
const noProviderWithoutInput = Object.freeze({ $or: [{ llmInputScope: { $ne: 'none' } }, { 'storageScope.summary': false, 'storageScope.embedding': false }] })
const attributionRule = Object.freeze({ $or: [{ attributionRequired: false }, { attributionRequired: true, attributionText: { $type: 'string', $ne: '' } }] })
const activeRule = Object.freeze({ $or: [
  { operationalStatus: { $ne: 'active' } },
  { operationalStatus: 'active', licenseStatus: { $in: ['permitted', 'metadata-only'] }, reviewedAt: { $type: 'date' }, reviewedBy: { $type: 'objectId' }, 'technicalCheck.status': 'passed' },
] })
const reviewEvidenceRule = Object.freeze({ $or: [
  { licenseStatus: 'review-needed' },
  { licenseStatus: { $in: ['permitted', 'metadata-only', 'blocked'] }, reviewedAt: { $type: 'date' }, reviewedBy: { $type: 'objectId' }, evidenceNote: { $type: 'string', $ne: '' } },
] })
const reconciliationRule = Object.freeze({ $or: [
  { 'reconciliation.status': 'idle', 'reconciliation.requestedAt': null, 'reconciliation.error': null },
  { 'reconciliation.status': { $in: ['pending', 'processing'] }, 'reconciliation.requestedAt': { $type: 'date' }, 'reconciliation.completedPolicyVersion': null, 'reconciliation.error': null },
  { 'reconciliation.status': 'completed', 'reconciliation.requestedAt': { $type: 'date' }, 'reconciliation.completedPolicyVersion': { $type: 'int' }, 'reconciliation.error': null, $expr: { $eq: ['$reconciliation.completedPolicyVersion', '$reconciliation.requiredPolicyVersion'] } },
  { 'reconciliation.status': 'failed', 'reconciliation.requestedAt': { $type: 'date' }, 'reconciliation.completedPolicyVersion': null, 'reconciliation.error': { $type: 'object' } },
] })
const reconciliationVersionRule = Object.freeze({ $expr: { $eq: ['$reconciliation.requiredPolicyVersion', '$policyVersion'] } })
const technicalRule = Object.freeze({ $or: [
  { 'technicalCheck.status': 'not-run', 'technicalCheck.checkedAt': null, 'technicalCheck.contentType': null, 'technicalCheck.resolvedHost': null, 'technicalCheck.sampleCount': null, 'technicalCheck.error': null },
  { 'technicalCheck.status': 'passed', 'technicalCheck.checkedAt': { $type: 'date' }, 'technicalCheck.contentType': { $type: 'string', $ne: '' }, 'technicalCheck.resolvedHost': { $type: 'string', $ne: '' }, 'technicalCheck.sampleCount': { $gte: 1 }, 'technicalCheck.error': null },
  { 'technicalCheck.status': 'failed', 'technicalCheck.checkedAt': { $type: 'date' }, 'technicalCheck.contentType': null, 'technicalCheck.resolvedHost': null, 'technicalCheck.sampleCount': null, 'technicalCheck.error': { $type: 'object' } },
] })

const sourceConfigurationFields = ['name', 'publisherName', 'domain', 'authorityTier', 'connectorConfig', 'mediaPolicy', 'attributionRequired', 'attributionText', 'operationalStatus', 'technicalCheck']
const sourcePolicyFields = ['licenseStatus', 'llmInputScope', 'storageScope', 'mediaPolicy', 'attributionRequired', 'attributionText', 'termsUrl', 'licenseUrl', 'evidenceNote', 'reviewedAt', 'reviewedBy', 'policyVersion']
const sourceReReviewFields = ['operationalStatus', 'licenseStatus', 'llmInputScope', 'storageScope', 'reviewedAt', 'reviewedBy', 'policyVersion']
const sourceStatusTransitions = [
  ['draft', 'testing'], ['testing', 'active'], ['testing', 'paused'], ['active', 'paused'], ['paused', 'active'], ['paused', 'archived'],
]
const sourceOperationalStatuses = ['draft', 'testing', 'active', 'paused', 'archived']
const sourceConfigurationBaseExpression = [{ $gt: [{ $size: '$changedFields' }, 0] }, { $setIsSubset: ['$changedFields', sourceConfigurationFields] }, { $eq: [{ $size: '$changedFields' }, { $size: { $setUnion: ['$changedFields', []] } }] }, { $gt: [{ $size: { $setDifference: ['$changedFields', ['operationalStatus']] } }, 0] }]
const sourceConfigurationWithoutTransitionExpression = { $and: [...sourceConfigurationBaseExpression, { $not: [{ $in: ['operationalStatus', '$changedFields'] }] }] }
const sourceConfigurationWithTransitionExpression = { $and: [...sourceConfigurationBaseExpression, { $in: ['operationalStatus', '$changedFields'] }] }
const noStateTransition = { stateTransition: { $exists: false } }
const sourceAuditRules = [
  { action: 'source_created', targetType: 'source', reasonCode: 'source_created', changedFields: ['sourceKey', 'operationalStatus', 'policyVersion'], ...noStateTransition },
  {
    action: 'source_configuration_updated', targetType: 'source', reasonCode: 'source_configuration_changed', ...noStateTransition,
    $expr: sourceConfigurationWithoutTransitionExpression,
  },
  ...sourceStatusTransitions.map(([from, to]) => ({ action: 'source_configuration_updated', targetType: 'source', reasonCode: 'source_configuration_changed', 'stateTransition.from': from, 'stateTransition.to': to, $expr: sourceConfigurationWithTransitionExpression })),
  { action: 'source_configuration_updated', targetType: 'source', reasonCode: 'source_configuration_changed', result: 'failed', 'stateTransition.from': { $in: sourceOperationalStatuses }, 'stateTransition.to': { $in: sourceOperationalStatuses }, $expr: sourceConfigurationWithTransitionExpression },
  ...sourceStatusTransitions.map(([from, to]) => ({ action: 'source_status_updated', targetType: 'source', reasonCode: 'source_status_changed', changedFields: ['operationalStatus'], 'stateTransition.from': from, 'stateTransition.to': to })),
  { action: 'source_status_updated', targetType: 'source', reasonCode: 'source_status_changed', result: 'failed', changedFields: ['operationalStatus'], 'stateTransition.from': { $in: sourceOperationalStatuses }, 'stateTransition.to': { $in: sourceOperationalStatuses } },
  { action: 'source_policy_reviewed', targetType: 'source', reasonCode: 'source_policy_reviewed', changedFields: sourcePolicyFields, ...noStateTransition },
  { action: 'source_policy_re_review_requested', targetType: 'source', reasonCode: 'source_policy_re_review_requested', changedFields: sourceReReviewFields.slice(1), ...noStateTransition },
  { action: 'source_policy_re_review_requested', targetType: 'source', reasonCode: 'source_policy_re_review_requested', changedFields: sourceReReviewFields, 'stateTransition.from': 'active', 'stateTransition.to': 'paused' },
  { action: 'source_technical_check_recorded', targetType: 'source', reasonCode: 'source_technical_check_requested', changedFields: ['technicalCheck'], ...noStateTransition },
]
const authAuditValidatorParts = AUTH_CORE_COLLECTIONS.adminAuditLogs.validator.$and
export const SOURCE_AUDIT_VALIDATOR = Object.freeze({
  $and: [
    { $or: [...authAuditValidatorParts[0].$or, ...sourceAuditRules] },
    authAuditValidatorParts[1],
  ],
})

export const SOURCE_COLLECTIONS = Object.freeze({
  sources: Object.freeze({ validator: { $and: [{ $jsonSchema: sourceJsonSchema }, connectorRules, policyRules, noProviderWithoutInput, attributionRule, reviewEvidenceRule, activeRule, reconciliationRule, reconciliationVersionRule, technicalRule] } }),
})

export const SOURCE_INDEXES = Object.freeze({
  sources: Object.freeze([
    { name: 'sources_key_unique', key: { sourceKey: 1 }, options: { unique: true } },
    { name: 'sources_connector_status', key: { connectorType: 1, operationalStatus: 1 } },
    { name: 'sources_license_reviewed', key: { licenseStatus: 1, reviewedAt: 1 } },
    { name: 'sources_reconciliation', key: { 'reconciliation.status': 1, 'reconciliation.requiredPolicyVersion': 1 } },
    { name: 'sources_health_success', key: { 'health.lastIngestSucceededAt': 1 } },
    { name: 'sources_created_cursor', key: { createdAt: -1, _id: -1 } },
  ]),
})

export function buildSourcesMigration({ dryRun = false, existingCollections, existingIndexes = {} } = {}) {
  const operations = []
  for (const [name, definition] of Object.entries(SOURCE_COLLECTIONS)) {
    if (!existingCollections || !existingCollections.includes(name)) operations.push({ type: 'createCollection', collection: name, options: { validator: definition.validator, validationLevel: 'strict', validationAction: 'error' } })
    operations.push({ type: 'collMod', collection: name, options: { validator: definition.validator, validationLevel: 'strict', validationAction: 'error' } })
    for (const index of SOURCE_INDEXES[name]) if (!existingIndexes[name]?.includes(index.name)) operations.push({ type: 'createIndex', collection: name, ...index })
  }
  operations.push({ type: 'collMod', collection: 'adminAuditLogs', options: { validator: SOURCE_AUDIT_VALIDATOR, validationLevel: 'strict', validationAction: 'error' } })
  return dryRun ? operations.map((operation) => ({ ...operation, dryRun: true })) : operations
}

export async function runSourcesMigration({ db, dryRun = false } = {}) {
  if (!db || typeof db.createCollection !== 'function') throw new Error('MongoDB database is required')
  const plan = buildSourcesMigration({ dryRun })
  if (dryRun) return plan
  for (const operation of plan) {
    if (operation.type === 'createCollection') {
      try { await db.createCollection(operation.collection, operation.options) } catch (error) { if (error?.codeName !== 'NamespaceExists' && error?.code !== 48) throw error }
    } else if (operation.type === 'collMod') {
      await db.command({ collMod: operation.collection, ...operation.options })
    } else {
      await db.collection(operation.collection).createIndex(operation.key, { ...(operation.options ?? {}), name: operation.name })
    }
  }
  return plan
}

export function validateSourceDocument(document) {
  const errors = []
  if (!document || typeof document !== 'object') return { valid: false, errors: ['document must be an object'] }
  if (!(document._id instanceof ObjectId)) errors.push('_id must be an ObjectId')
  try { validateConnectorUnit(document) } catch (error) { errors.push(error.message) }
  try { validatePolicyCompatibility(document) } catch (error) { errors.push(error.message) }
  if (document.attributionRequired && (typeof document.attributionText !== 'string' || !document.attributionText.trim())) errors.push('attributionText is required')
  if (document.operationalStatus === 'active' && (document.technicalCheck?.status !== 'passed' || !['permitted', 'metadata-only'].includes(document.licenseStatus))) errors.push('active source prerequisites are invalid')
  if (document.licenseStatus !== 'review-needed' && (!(document.reviewedAt instanceof Date) || !(document.reviewedBy instanceof ObjectId) || typeof document.evidenceNote !== 'string' || !document.evidenceNote.trim())) errors.push('reviewed policy evidence is required')
  const reconciliation = document.reconciliation
  if (!reconciliation || reconciliation.requiredPolicyVersion !== document.policyVersion) errors.push('reconciliation version must match policyVersion')
  if (reconciliation?.status === 'completed' && reconciliation.completedPolicyVersion !== reconciliation.requiredPolicyVersion) errors.push('completed reconciliation version mismatch')
  if (reconciliation?.status === 'failed' && !reconciliation.error) errors.push('failed reconciliation requires error')
  if (['pending', 'processing', 'completed', 'failed'].includes(reconciliation?.status) && !(reconciliation.requestedAt instanceof Date)) errors.push('reconciliation requestedAt is required')
  return { valid: errors.length === 0, errors }
}
