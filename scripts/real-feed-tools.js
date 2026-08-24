import { ObjectId } from 'mongodb'
import { buildIngestionArtifactJobs } from '../server/repositories/mongo/indexing-job-repository.js'
import { createSourceAuditEvent } from '../server/audit/source-writer.js'

export const APP_DATABASE = 'techpulse_app'
export const GOVERNANCE_DATABASE = 'techpulse_governance'
export const PRESERVED_APP_COLLECTIONS = Object.freeze([
  'users', 'sessions', 'accountDeletionRequests', 'adminAuditLogs', 'hmacKeyLifecycleSnapshots',
])
export const PRESERVED_GOVERNANCE_COLLECTIONS = Object.freeze([
  'governanceSuppressions', 'governanceCheckpoints', 'auditRetentionManifests',
])

const APP_CLEARABLE_COLLECTIONS = Object.freeze([
  'rateLimitBuckets', 'savedArticles', 'sources', 'articles', 'ingestionJobs', 'jobLeases',
  'ingestionScheduleProgress', 'indexingJobs', 'providerAdmissionStates', 'providerFailureDomainStates',
  'chatSessions', 'answerAttempts', 'takedownRequests', 'runtimeCapabilityProbes',
])
const GOVERNANCE_CLEARABLE_COLLECTIONS = Object.freeze(['runtimeCapabilityProbes'])
const RESERVED_COLLECTION_PREFIX = /^system\./
const DEFAULT_MAX_ARTICLES = 30
const MAX_ARTICLES = 50

export function parseClearArgs(args = []) {
  if (args.length === 0) return { apply: false }
  if (args.length === 1 && args[0] === '--apply') return { apply: true }
  throw new Error('clear tool accepts no arguments or --apply only')
}

export function planCollectionClears({ database, collections } = {}) {
  if (typeof database !== 'string' || !Array.isArray(collections)) throw new Error('clear plan input is invalid')
  const preserved = new Set(database === APP_DATABASE ? PRESERVED_APP_COLLECTIONS : database === GOVERNANCE_DATABASE ? PRESERVED_GOVERNANCE_COLLECTIONS : [])
  const known = new Set([...preserved, ...(database === APP_DATABASE ? APP_CLEARABLE_COLLECTIONS : database === GOVERNANCE_DATABASE ? GOVERNANCE_CLEARABLE_COLLECTIONS : [])])
  const unknown = collections.filter((collection) => typeof collection === 'string' && !RESERVED_COLLECTION_PREFIX.test(collection) && !known.has(collection))
  if (unknown.length > 0) throw new Error(`unsupported collection: ${unknown[0]}`)
  return collections.filter((collection) => typeof collection === 'string' && !RESERVED_COLLECTION_PREFIX.test(collection) && !preserved.has(collection)).map((collection) => ({ database, collection }))
}

export function parseSeedArgs(args = []) {
  let apply = false
  let confirmAiPolicy = false
  let maxArticles = DEFAULT_MAX_ARTICLES
  for (const arg of args) {
    if (arg === '--apply') apply = true
    else if (arg === '--confirm-ai-policy') confirmAiPolicy = true
    else if (arg.startsWith('--max-articles=')) {
      maxArticles = Number(arg.slice('--max-articles='.length))
      if (!Number.isInteger(maxArticles) || maxArticles < 20 || maxArticles > MAX_ARTICLES) throw new Error(`--max-articles must be between 20 and ${MAX_ARTICLES}`)
    } else throw new Error('seed tool arguments are invalid')
  }
  if (confirmAiPolicy && !apply) throw new Error('--confirm-ai-policy requires --apply')
  return { apply, maxArticles, ...(confirmAiPolicy ? { confirmAiPolicy: true } : {}) }
}

export function aiReadySource(source) {
  if (!source || source.llmInputScope !== 'metadata' || !['metadata-only', 'permitted'].includes(source.licenseStatus)) throw new Error('real feed source policy must permit metadata AI input')
  return {
    ...source,
    storageScope: { ...source.storageScope, metadata: true, excerpt: false, summary: true, embedding: true },
    evidenceNote: `${source.evidenceNote ?? ''} AI metadata scope was explicitly approved for this real-feed run.`,
  }
}

export function buildIndexingJobs({ source, article, now = new Date(), embeddingTarget } = {}) {
  return buildIngestionArtifactJobs({ source, article, now, embeddingTarget })
}

export function refreshAuditIdentities(audits, runId = new ObjectId().toHexString()) {
  if (!Array.isArray(audits) || typeof runId !== 'string' || runId.length < 8) throw new Error('audit refresh input is invalid')
  return audits.map((audit, index) => {
    const actor = { id: audit.actorId, role: audit.actorType === 'admin' ? 'admin' : 'system-worker' }
    const event = createSourceAuditEvent({
      actor,
      action: audit.action,
      targetId: audit.targetId,
      changedFields: audit.changedFields,
      reasonCode: audit.reasonCode,
      request: { serverRequestId: `seed:real-demo:${runId}:${index}` },
      result: audit.result,
      stateTransition: audit.stateTransition,
      createdAt: audit.createdAt,
    })
    return { ...event, _id: new ObjectId() }
  })
}
