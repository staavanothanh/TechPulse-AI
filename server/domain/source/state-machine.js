import {
  SourceValidationError,
  normalizeMediaPolicy,
  normalizeSourceDefinition,
  validateConnectorUnit,
  validatePolicyCompatibility,
  validatePolicyReviewEvidence,
} from './validation.js'

const VERSIONED_UPDATE_FIELDS = new Set(['domain', 'authorityTier', 'connectorConfig', 'mediaPolicy', 'attributionRequired', 'attributionText'])
const UPDATE_FIELDS = new Set(['name', 'publisherName', ...VERSIONED_UPDATE_FIELDS, 'operationalStatus'])
const RIGHTS_EVIDENCE_UPDATE_FIELDS = new Set(['publisherName', ...VERSIONED_UPDATE_FIELDS])
const TECHNICAL_EVIDENCE_UPDATE_FIELDS = new Set(['domain', 'authorityTier', 'connectorConfig'])
const TRANSITIONS = Object.freeze({
  draft: new Set(['testing']),
  testing: new Set(['active', 'paused']),
  active: new Set(['paused']),
  paused: new Set(['active', 'archived']),
  archived: new Set(),
})
const EMPTY_STORAGE = Object.freeze({ metadata: false, excerpt: false, summary: false, embedding: false })
const DEFAULT_MEDIA = Object.freeze({ imageMode: 'none', videoMode: 'none', allowedHosts: [], attributionRequired: false, evidenceNote: null })
const EMPTY_TECHNICAL_CHECK = Object.freeze({ status: 'not-run', checkedAt: null, contentType: null, resolvedHost: null, sampleCount: null, error: null })

function same(left, right) {
  return JSON.stringify(left) === JSON.stringify(right)
}

function pendingMarker(policyVersion, now) {
  return { status: 'pending', requiredPolicyVersion: policyVersion, completedPolicyVersion: null, requestedAt: now, error: null }
}

function validateActivation(source) {
  if (source.technicalCheck?.status !== 'passed') throw new SourceValidationError('technical check must pass before activation', { reasonCode: 'invalid_state_transition' })
  if (!['permitted', 'metadata-only'].includes(source.licenseStatus) || !source.reviewedAt || !source.reviewedBy || typeof source.evidenceNote !== 'string' || !source.evidenceNote.trim()) throw new SourceValidationError('policy review evidence must exist before activation', { reasonCode: 'invalid_state_transition' })
  validatePolicyCompatibility(source)
}

function changedFields(current, patch) {
  return Object.keys(patch).filter((field) => field !== 'reasonCode' && UPDATE_FIELDS.has(field) && !same(current[field], patch[field])).sort()
}

export function createDraftSource(input, { id, now = new Date() } = {}) {
  validateConnectorUnit(input)
  const identity = normalizeSourceDefinition(input)
  const mediaPolicy = input.mediaPolicy ? normalizeMediaPolicy(input.mediaPolicy) : { ...DEFAULT_MEDIA }
  return {
    id,
    name: identity.name,
    sourceKey: identity.sourceKey,
    publisherName: identity.publisherName,
    domain: identity.domain,
    connectorType: input.connectorType,
    accessMethod: input.accessMethod,
    authorityTier: input.authorityTier,
    connectorConfig: { ...input.connectorConfig },
    operationalStatus: 'draft',
    licenseStatus: 'review-needed',
    llmInputScope: 'none',
    storageScope: { ...EMPTY_STORAGE },
    mediaPolicy,
    attributionRequired: false,
    attributionText: null,
    termsUrl: null,
    licenseUrl: null,
    evidenceNote: null,
    reviewedAt: null,
    reviewedBy: null,
    policyVersion: 1,
    reconciliation: { status: 'idle', requiredPolicyVersion: 1, completedPolicyVersion: null, requestedAt: null, error: null },
    technicalCheck: { status: 'not-run', checkedAt: null, contentType: null, resolvedHost: null, sampleCount: null, error: null },
    health: { lastIngestSucceededAt: null, lastIngestFailedAt: null, consecutiveFailures: 0, lastError: null },
    createdAt: now,
    updatedAt: now,
  }
}

export function transitionOperationalStatus(source, to, { now = new Date() } = {}) {
  if (!TRANSITIONS[source.operationalStatus]?.has(to)) throw new SourceValidationError('source status transition is not allowed', { reasonCode: 'invalid_state_transition' })
  if (to === 'active') validateActivation(source)
  return { source: { ...source, operationalStatus: to, updatedAt: now }, changedFields: ['operationalStatus'], versionChanged: false, stateTransition: { from: source.operationalStatus, to } }
}

export function applySourceUpdate(source, patch, { now = new Date() } = {}) {
  const fields = changedFields(source, patch)
  if (fields.length === 0) throw new SourceValidationError('source update has no changes')
  const hasConfiguration = fields.some((field) => field !== 'operationalStatus')
  const expectedReason = hasConfiguration ? 'source_configuration_changed' : 'source_status_changed'
  if (patch.reasonCode !== expectedReason) throw new SourceValidationError('source update reasonCode does not match changed fields')
  if (source.licenseStatus !== 'review-needed' && fields.some((field) => RIGHTS_EVIDENCE_UPDATE_FIELDS.has(field))) {
    throw new SourceValidationError('source must enter re-review before rights-affecting configuration changes', { reasonCode: 'invalid_state_transition' })
  }
  let next = { ...source }
  for (const field of fields) next[field] = field === 'connectorConfig' || field === 'mediaPolicy' ? { ...patch[field] } : patch[field]
  validateConnectorUnit(next)
  const identity = normalizeSourceDefinition(next)
  next = { ...next, ...identity }
  next = { ...next, mediaPolicy: normalizeMediaPolicy(next.mediaPolicy) }
  const technicalEvidenceChanged = fields.some((field) => TECHNICAL_EVIDENCE_UPDATE_FIELDS.has(field))
  const technicalCheckInvalidated = technicalEvidenceChanged && source.technicalCheck?.status !== 'not-run'
  if (technicalCheckInvalidated) next.technicalCheck = { ...EMPTY_TECHNICAL_CHECK }
  validatePolicyCompatibility(next)
  let stateTransition
  if (fields.includes('operationalStatus')) {
    const transition = transitionOperationalStatus({ ...next, operationalStatus: source.operationalStatus }, patch.operationalStatus, { now })
    next = transition.source
    stateTransition = transition.stateTransition
  }
  const versionChanged = fields.some((field) => VERSIONED_UPDATE_FIELDS.has(field))
  if (versionChanged) {
    next.policyVersion = source.policyVersion + 1
    next.reconciliation = pendingMarker(next.policyVersion, now)
  }
  next.updatedAt = now
  const persistedFields = technicalCheckInvalidated ? [...fields, 'technicalCheck'].sort() : fields
  return { source: next, changedFields: persistedFields, versionChanged, stateTransition }
}

export function reviewSourcePolicy(source, review, { reviewerId, now = new Date() } = {}) {
  if (!reviewerId) throw new SourceValidationError('reviewer identity is required')
  if (review.reasonCode !== 'source_policy_reviewed') throw new SourceValidationError('policy review reasonCode is invalid')
  if (source.operationalStatus === 'active') throw new SourceValidationError('active source must enter re-review before policy review', { reasonCode: 'invalid_state_transition' })
  const normalized = validatePolicyReviewEvidence(review)
  const policyVersion = source.policyVersion + 1
  const next = {
    ...source,
    licenseStatus: normalized.licenseStatus,
    llmInputScope: normalized.llmInputScope,
    storageScope: { ...normalized.storageScope },
    mediaPolicy: { ...normalized.mediaPolicy },
    attributionRequired: normalized.attributionRequired,
    attributionText: normalized.attributionText ?? null,
    termsUrl: normalized.termsUrl ?? null,
    licenseUrl: normalized.licenseUrl ?? null,
    evidenceNote: normalized.evidenceNote,
    reviewedAt: now,
    reviewedBy: reviewerId,
    policyVersion,
    reconciliation: pendingMarker(policyVersion, now),
    updatedAt: now,
  }
  const changedFields = ['licenseStatus', 'llmInputScope', 'storageScope', 'mediaPolicy', 'attributionRequired', 'attributionText', 'termsUrl', 'licenseUrl', 'evidenceNote', 'reviewedAt', 'reviewedBy', 'policyVersion']
  return {
    source: next,
    changedFields,
    versionChanged: true,
  }
}

export function requestPolicyReReview(source, { reviewerId, now = new Date() } = {}) {
  if (!reviewerId) throw new SourceValidationError('reviewer identity is required')
  if (source.operationalStatus === 'archived') throw new SourceValidationError('archived source cannot enter re-review', { reasonCode: 'invalid_state_transition' })
  const policyVersion = source.policyVersion + 1
  const next = {
    ...source,
    operationalStatus: source.operationalStatus === 'active' ? 'paused' : source.operationalStatus,
    licenseStatus: 'review-needed',
    llmInputScope: 'none',
    storageScope: { ...EMPTY_STORAGE },
    reviewedAt: now,
    reviewedBy: reviewerId,
    policyVersion,
    reconciliation: pendingMarker(policyVersion, now),
    updatedAt: now,
  }
  validatePolicyCompatibility(next)
  const changedFields = ['licenseStatus', 'llmInputScope', 'storageScope', 'reviewedAt', 'reviewedBy', 'policyVersion']
  if (source.operationalStatus === 'active') changedFields.unshift('operationalStatus')
  return {
    source: next,
    changedFields,
    versionChanged: true,
    stateTransition: source.operationalStatus === 'active' ? { from: 'active', to: 'paused' } : undefined,
  }
}

export const SOURCE_VERSIONED_UPDATE_FIELDS = VERSIONED_UPDATE_FIELDS
