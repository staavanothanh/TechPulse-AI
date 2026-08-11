import { createHash } from 'node:crypto'
import { evaluateContentPolicy } from '../domain/policy/content-policy.js'
import { sanitizeText } from '../domain/article/normalization.js'

const PURPOSES = new Set(['summary', 'embedding'])
const DATE_FIELDS = new Set(['publishedAt'])
const ARRAY_FIELDS = new Set(['topics'])
const SENSITIVE_PROVIDER_INPUT = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b|\bgh[pousr]_[A-Za-z0-9_]{16,}\b|\bgithub_pat_[A-Za-z0-9_]{16,}\b|\b(?:AKIA|ASIA)[A-Z0-9]{16}\b|\bbearer\s+[A-Za-z0-9._~+/=-]{12,}\b|\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b|-----BEGIN(?: [A-Z0-9]+)* PRIVATE KEY-----|\b(?:sk|pk|rk|xox[baprs]|AIza|hf|npm|pypi|glpat|gitlab_pat|provider[_-]?key)[_-][A-Za-z0-9_-]{8,}\b|\b(?:api[_-]?key|authorization|bearer|token|secret|password|credential(?:s)?)\s*[:=]\s*["']?[^\s"',;}{\]]{8,}/i

export class PolicyInputError extends Error {
  constructor(code, message) {
    super(message)
    this.name = 'PolicyInputError'
    this.code = code
  }
}

export function containsSensitiveProviderInput(value) {
  return typeof value === 'string' && SENSITIVE_PROVIDER_INPUT.test(value)
}

function sourceIdentity(source) {
  return source?.id ?? source?._id ?? source?.sourceId
}

function articleSourceIdentity(article) {
  return article?.sourceId?.toHexString?.() ?? article?.sourceId
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`
  return JSON.stringify(value)
}

function safeDate(value) {
  const date = value instanceof Date ? value : new Date(value)
  if (Number.isNaN(date.getTime())) throw new PolicyInputError('policy_input_invalid', 'AI input date is invalid')
  return date.toISOString()
}

function safeField(field, value) {
  if (value === undefined || value === null || value === '') return undefined
  if (DATE_FIELDS.has(field)) return safeDate(value)
  if (ARRAY_FIELDS.has(field)) {
    if (!Array.isArray(value)) throw new PolicyInputError('policy_input_invalid', 'AI input topics are invalid')
    return [...new Set(value.map((item) => sanitizeText(item, 100)).filter(Boolean))].slice(0, 50)
  }
  return sanitizeText(value, field === 'excerptOriginal' || field === 'fullTextTemporary' ? 20_000 : 2_000)
}

function inputBasis(gate) {
  if (gate.inputScope === 'fulltext-temporary') return 'fulltext-temporary'
  if (gate.inputScope === 'excerpt') return 'excerpt'
  return 'metadata'
}

export function buildPolicyDerivedInput({ article, source, purpose, fullTextTemporary } = {}) {
  if (!PURPOSES.has(purpose)) throw new PolicyInputError('policy_purpose_invalid', 'AI input purpose is invalid')
  const sourceId = sourceIdentity(source)?.toHexString?.() ?? sourceIdentity(source)
  if (!article || !sourceId || String(articleSourceIdentity(article)) !== String(sourceId)) throw new PolicyInputError('source_mismatch', 'Article source does not match current source policy')
  if (source.technicalCheck?.status !== 'passed') throw new PolicyInputError('source_policy_blocked', 'Current source policy is not production eligible')
  const gate = evaluateContentPolicy(source, purpose)
  if (!gate.allowed) throw new PolicyInputError(gate.code, 'Current source policy does not permit this AI artifact')
  if (gate.inputScope === 'fulltext-temporary' && (typeof fullTextTemporary !== 'string' || fullTextTemporary.trim() === '')) throw new PolicyInputError('temporary_input_unavailable', 'Temporary full-text input is unavailable')

  const values = {
    titleOriginal: article.titleOriginal,
    titleVi: article.titleVi,
    author: article.author,
    publishedAt: article.publishedAt,
    topics: article.topics,
    sourceName: source.name,
    excerptOriginal: article.excerptOriginal,
    summaryVi: article.summaryStatus === 'ready' ? article.summaryVi : undefined,
    fullTextTemporary,
  }
  const fields = {}
  for (const field of gate.allowedFields) {
    const safe = safeField(field, values[field])
    if (safe !== undefined && (!Array.isArray(safe) || safe.length > 0)) fields[field] = safe
  }
  if (!fields.titleOriginal) throw new PolicyInputError('policy_input_invalid', 'AI input needs an allowed title')
  if (containsSensitiveProviderInput(JSON.stringify(fields))) throw new PolicyInputError('privacy_input_blocked', 'Privacy boundary rejected provider input')
  const canonical = stableJson({ purpose, policyVersion: gate.policyVersion, fields })
  return Object.freeze({
    purpose,
    policyVersion: gate.policyVersion,
    basis: inputBasis(gate),
    fields: Object.freeze(fields),
    text: `<external-source-data>\n${canonical}\n</external-source-data>`,
    inputHash: createHash('sha256').update(canonical).digest('hex'),
  })
}
