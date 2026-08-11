const PURPOSES = Object.freeze({
  metadata: Object.freeze({ storageField: 'metadata', provider: false }),
  excerpt: Object.freeze({ storageField: 'excerpt', provider: false }),
  summary: Object.freeze({ storageField: 'summary', provider: true }),
  embedding: Object.freeze({ storageField: 'embedding', provider: true }),
  retrieval: Object.freeze({ storageField: 'metadata', provider: false }),
})

function reject(source, purpose, code) {
  return { allowed: false, code, purpose, policyVersion: source?.policyVersion ?? null }
}

const METADATA_FIELDS = Object.freeze(['titleOriginal', 'author', 'publishedAt', 'topics', 'sourceName'])

function fieldsFor(purpose, inputScope) {
  if (purpose === 'embedding') return ['titleOriginal', 'titleVi', 'summaryVi', 'topics']
  if (purpose !== 'summary') return purpose === 'excerpt' ? [...METADATA_FIELDS, 'excerptOriginal'] : [...METADATA_FIELDS]
  if (inputScope === 'excerpt') return [...METADATA_FIELDS, 'excerptOriginal']
  if (inputScope === 'fulltext-temporary') return [...METADATA_FIELDS, 'fullTextTemporary']
  return [...METADATA_FIELDS]
}

export function evaluateContentPolicy(source, purpose) {
  const rule = PURPOSES[purpose]
  if (!rule) return reject(source, purpose, 'source_purpose_unknown')
  if (!source || source.operationalStatus !== 'active') return reject(source, purpose, 'source_inactive')
  try {
    if (!Number.isInteger(source.policyVersion) || source.policyVersion < 1) throw new Error('invalid policy version')
    validatePolicyCompatibility(source)
  } catch { return reject(source, purpose, 'source_policy_invalid') }
  if (!['permitted', 'metadata-only'].includes(source.licenseStatus)) return reject(source, purpose, 'source_policy_blocked')
  if (!source.storageScope?.[rule.storageField]) return reject(source, purpose, 'source_scope_denied')
  if (purpose === 'excerpt' && source.licenseStatus === 'metadata-only') return reject(source, purpose, 'source_scope_denied')
  if (rule.provider && source.llmInputScope === 'none') return reject(source, purpose, 'source_scope_denied')
  return {
    allowed: true,
    purpose,
    policyVersion: source.policyVersion,
    inputScope: rule.provider ? source.llmInputScope : purpose === 'retrieval' ? source.llmInputScope : purpose,
    allowedFields: fieldsFor(purpose, source.llmInputScope),
  }
}

export const CONTENT_POLICY_PURPOSES = Object.freeze(Object.keys(PURPOSES))
import { validatePolicyCompatibility } from '../source/validation.js'
