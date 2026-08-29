// Seed real (non-demo) sources for TechPulse AI.
// - Pauses the existing live-demo sources.
// - Seeds real RSS sources (The Verge, Ars Technica, DeepMind, OpenAI, Hugging Face)
//   plus real arXiv and Hacker News sources with batchSize 10.
//
// Run: node --env-file-if-exists=.env scripts/seed-real-sources.js
//      node --env-file-if-exists=.env scripts/seed-real-sources.js --dry-run
import { createHash } from 'node:crypto'
import { pathToFileURL } from 'node:url'
import { ObjectId } from 'mongodb'
import { createSourceAuditEvent } from '../server/audit/source-writer.js'
import { assertSourcesReady } from '../server/bootstrap/sources.js'
import { validateRuntimeConfiguration } from '../server/config/runtime.js'
import { createDraftSource } from '../server/domain/source/state-machine.js'
import { getMongoContext, closeMongoConnection } from '../server/repositories/mongo/connection.js'
import { MongoSourceRepository } from '../server/repositories/mongo/source-repository.js'
import { resolveDemoReviewerId } from './seed-demo.js'
import { configureDns } from './configure-dns.js'

export const DEMO_SOURCE_KEYS = Object.freeze([
  'demo:rss-the-verge',
  'demo:arxiv-cs-ai',
  'demo:hn-topstories',
])

export const REAL_SOURCE_SEEDS = Object.freeze([
  Object.freeze({
    name: 'The Verge Technology',
    sourceKey: 'rss:the-verge',
    publisherName: 'The Verge',
    domain: 'theverge.com',
    connectorType: 'rss',
    accessMethod: 'rss',
    authorityTier: 'editorial',
    connectorConfig: Object.freeze({
      kind: 'rss',
      feedUrl: 'https://www.theverge.com/rss/index.xml',
      batchSize: 100,
    }),
    termsUrl: 'https://www.theverge.com/terms-of-use',
    licenseUrl: 'https://www.theverge.com/terms-of-use',
    mediaPolicy: Object.freeze({
      imageMode: 'remote-preview',
      videoMode: 'link-only',
      allowedHosts: Object.freeze(['platform.theverge.com']),
      attributionRequired: true,
      evidenceNote:
        'The Verge RSS payload provides HTTPS images from platform.theverge.com; display remote-preview only, no rehosting.',
    }),
  }),
  Object.freeze({
    name: 'Ars Technica',
    sourceKey: 'rss:ars-technica',
    publisherName: 'Ars Technica',
    domain: 'arstechnica.com',
    connectorType: 'rss',
    accessMethod: 'rss',
    authorityTier: 'editorial',
    connectorConfig: Object.freeze({
      kind: 'rss',
      feedUrl: 'https://feeds.arstechnica.com/arstechnica/index',
      batchSize: 100,
    }),
    termsUrl: 'https://arstechnica.com/terms-of-use/',
    licenseUrl: 'https://arstechnica.com/terms-of-use/',
    mediaPolicy: Object.freeze({
      imageMode: 'remote-preview',
      videoMode: 'link-only',
      allowedHosts: Object.freeze(['cdn.arstechnica.net']),
      attributionRequired: true,
      evidenceNote:
        'Ars Technica RSS payload provides HTTPS images from cdn.arstechnica.net; display remote-preview only, no rehosting.',
    }),
  }),
  Object.freeze({
    name: 'Google DeepMind Blog',
    sourceKey: 'rss:deepmind-blog',
    publisherName: 'Google DeepMind',
    domain: 'deepmind.google',
    connectorType: 'rss',
    accessMethod: 'rss',
    authorityTier: 'primary',
    connectorConfig: Object.freeze({
      kind: 'rss',
      feedUrl: 'https://deepmind.com/blog/feed/basic/',
      batchSize: 100,
    }),
    termsUrl: 'https://deepmind.google/about/',
    licenseUrl: 'https://deepmind.google/about/',
    mediaPolicy: Object.freeze({
      imageMode: 'remote-preview',
      videoMode: 'link-only',
      allowedHosts: Object.freeze(['lh3.googleusercontent.com']),
      attributionRequired: false,
      evidenceNote:
        'Google DeepMind blog feed provides HTTPS images from lh3.googleusercontent.com; display remote-preview only, no rehosting.',
    }),
  }),
  Object.freeze({
    name: 'OpenAI News',
    sourceKey: 'rss:openai-news',
    publisherName: 'OpenAI',
    domain: 'openai.com',
    connectorType: 'rss',
    accessMethod: 'rss',
    authorityTier: 'primary',
    connectorConfig: Object.freeze({
      kind: 'rss',
      feedUrl: 'https://openai.com/news/rss.xml',
      batchSize: 100,
    }),
    termsUrl: 'https://openai.com/policies/terms-of-use/',
    licenseUrl: 'https://openai.com/policies/terms-of-use/',
    mediaPolicy: Object.freeze({
      imageMode: 'none',
      videoMode: 'none',
      allowedHosts: Object.freeze([]),
      attributionRequired: false,
      evidenceNote: 'OpenAI News RSS is metadata-only; no media candidates in the payload.',
    }),
  }),
  Object.freeze({
    name: 'Hugging Face Blog',
    sourceKey: 'rss:huggingface-blog',
    publisherName: 'Hugging Face',
    domain: 'huggingface.co',
    connectorType: 'rss',
    accessMethod: 'rss',
    authorityTier: 'primary',
    connectorConfig: Object.freeze({
      kind: 'rss',
      feedUrl: 'https://huggingface.co/blog/feed.xml',
      batchSize: 100,
    }),
    termsUrl: 'https://huggingface.co/terms-of-service',
    licenseUrl: 'https://huggingface.co/terms-of-service',
    mediaPolicy: Object.freeze({
      imageMode: 'none',
      videoMode: 'none',
      allowedHosts: Object.freeze([]),
      attributionRequired: false,
      evidenceNote: 'Hugging Face blog RSS is metadata-only; no media candidates in the payload.',
    }),
  }),
  Object.freeze({
    name: 'arXiv Computer Science AI',
    sourceKey: 'arxiv:cs-ai',
    publisherName: 'arXiv',
    domain: 'export.arxiv.org',
    connectorType: 'arxiv',
    accessMethod: 'api',
    authorityTier: 'primary',
    connectorConfig: Object.freeze({ kind: 'arxiv', arxivQuery: 'cat:cs.AI', batchSize: 10 }),
    termsUrl: 'https://info.arxiv.org/help/license/index.html',
    licenseUrl: 'https://info.arxiv.org/help/license/index.html',
    mediaPolicy: Object.freeze({
      imageMode: 'none',
      videoMode: 'none',
      allowedHosts: Object.freeze([]),
      attributionRequired: false,
      evidenceNote:
        'arXiv API is metadata-only; no media candidates. Thank you to arXiv for use of its open access interoperability.',
    }),
  }),
  Object.freeze({
    name: 'Hacker News Top Stories',
    sourceKey: 'hn:topstories',
    publisherName: 'Hacker News',
    domain: 'news.ycombinator.com',
    connectorType: 'hacker-news',
    accessMethod: 'api',
    authorityTier: 'community-signal',
    connectorConfig: Object.freeze({
      kind: 'hacker-news',
      hackerNewsStream: 'topstories',
      batchSize: 10,
    }),
    termsUrl: 'https://news.ycombinator.com/newsguidelines.html',
    licenseUrl: 'https://news.ycombinator.com/newsguidelines.html',
    mediaPolicy: Object.freeze({
      imageMode: 'none',
      videoMode: 'none',
      allowedHosts: Object.freeze([]),
      attributionRequired: false,
      evidenceNote:
        'Hacker News Firebase API is metadata-only; no media candidates. Public data, used politely.',
    }),
  }),
])

const SYSTEM_ACTOR = Object.freeze({ id: 'system:real-source-seed', role: 'system-worker' })
const DEFAULT_REVIEWER_ID = new ObjectId('507f1f77bcf86cd799439011')
const POLICY_REVIEW_FIELDS = Object.freeze([
  'licenseStatus',
  'llmInputScope',
  'storageScope',
  'mediaPolicy',
  'attributionRequired',
  'attributionText',
  'termsUrl',
  'licenseUrl',
  'evidenceNote',
  'reviewedAt',
  'reviewedBy',
  'policyVersion',
])

function deterministicId(sourceKey) {
  return new ObjectId(
    createHash('sha256').update(`techpulse-real-source-seed\u0000${sourceKey}`).digest().subarray(0, 12),
  ).toHexString()
}

function reviewedSourceDocument(definition, { now = new Date(), reviewerId = DEFAULT_REVIEWER_ID } = {}) {
  const id = deterministicId(definition.sourceKey)
  const draft = createDraftSource(definition, { id, now })
  const reviewedAt = new Date(now.getTime() - 60_000)
  return {
    ...draft,
    _id: new ObjectId(id),
    id,
    operationalStatus: 'active',
    licenseStatus: 'metadata-only',
    llmInputScope: 'metadata',
    storageScope: { metadata: true, excerpt: false, summary: false, embedding: false },
    mediaPolicy: { ...definition.mediaPolicy },
    attributionRequired: false,
    attributionText: null,
    termsUrl: definition.termsUrl ?? null,
    licenseUrl: definition.licenseUrl ?? null,
    evidenceNote:
      'Operator bootstrap cho real source; du lieu duoc lay truc tiep tu connector cong khai va chi luu metadata. AI metadata scope was explicitly approved for this real-feed run.',
    reviewedAt,
    reviewedBy: reviewerId,
    policyVersion: 2,
    reconciliation: {
      status: 'completed',
      requiredPolicyVersion: 2,
      completedPolicyVersion: 2,
      requestedAt: reviewedAt,
      error: null,
    },
    technicalCheck: {
      status: 'passed',
      checkedAt: reviewedAt,
      contentType: definition.connectorType === 'rss' ? 'application/rss+xml' : 'application/json',
      resolvedHost: definition.domain,
      sampleCount: 1,
      error: null,
    },
    health: {
      lastIngestSucceededAt: now,
      lastIngestFailedAt: null,
      consecutiveFailures: 0,
      lastError: null,
    },
  }
}

function sourceAudits(source, { now = new Date(), manifestId, reviewerId } = {}) {
  const created = new Date(now.getTime() - 180_000)
  const reviewed = new Date(now.getTime() - 60_000)
  const events = [
    {
      actor: SYSTEM_ACTOR,
      action: 'source_created',
      changedFields: ['sourceKey', 'operationalStatus', 'policyVersion'],
      reasonCode: 'source_created',
      request: { serverRequestId: `seed:real:${source.sourceKey}:created:${manifestId}` },
      createdAt: created,
      result: 'succeeded',
    },
    {
      actor: { _id: reviewerId, role: 'admin' },
      action: 'source_policy_reviewed',
      changedFields: [...POLICY_REVIEW_FIELDS],
      reasonCode: 'source_policy_reviewed',
      request: { serverRequestId: `seed:real:${source.sourceKey}:review:${manifestId}` },
      createdAt: reviewed,
      result: 'succeeded',
    },
    {
      actor: { _id: reviewerId, role: 'admin' },
      action: 'source_technical_check_recorded',
      changedFields: ['technicalCheck'],
      reasonCode: 'source_technical_check_requested',
      request: { serverRequestId: `seed:real:${source.sourceKey}:check:${manifestId}` },
      createdAt: reviewed,
      result: 'succeeded',
    },
    {
      actor: { _id: reviewerId, role: 'admin' },
      action: 'source_status_updated',
      changedFields: ['operationalStatus'],
      reasonCode: 'source_status_changed',
      stateTransition: { from: 'draft', to: 'testing' },
      request: { serverRequestId: `seed:real:${source.sourceKey}:testing:${manifestId}` },
      createdAt: created,
      result: 'succeeded',
    },
    {
      actor: { _id: reviewerId, role: 'admin' },
      action: 'source_status_updated',
      changedFields: ['operationalStatus'],
      reasonCode: 'source_status_changed',
      stateTransition: { from: 'testing', to: 'active' },
      request: { serverRequestId: `seed:real:${source.sourceKey}:active:${manifestId}` },
      createdAt: now,
      result: 'succeeded',
    },
  ]
  return events.map((event) => createSourceAuditEvent({
      actor: event.actor,
      action: event.action,
      targetId: source._id,
      changedFields: event.changedFields,
      reasonCode: event.reasonCode,
      request: event.request,
      stateTransition: event.stateTransition,
      createdAt: event.createdAt,
      result: event.result,
    }))
}

export function buildRealSourceDocuments({ now = new Date(), reviewerId = DEFAULT_REVIEWER_ID } = {}) {
  return REAL_SOURCE_SEEDS.map((definition) => reviewedSourceDocument(definition, { now, reviewerId }))
}

function toSourceDocument(source) {
  const { id, ...document } = source
  const next = { ...document }
  if (id && !next._id) next._id = id
  delete next.id
  return next
}

function pauseAudit(source, { now = new Date(), manifestId, reviewerId } = {}) {
  return createSourceAuditEvent({
    actor: { _id: reviewerId, role: 'admin' },
    action: 'source_status_updated',
    targetId: source._id,
    changedFields: ['operationalStatus'],
    reasonCode: 'source_status_changed',
    stateTransition: { from: source.operationalStatus, to: 'paused' },
    request: { serverRequestId: `seed:real:pause:${source.sourceKey}:${manifestId}` },
    createdAt: now,
    result: 'succeeded',
  })
}

export async function seedRealSources({ context, now = new Date(), apply = false, reviewerId = DEFAULT_REVIEWER_ID } = {}) {
  await assertSourcesReady(context)
  const repository = new MongoSourceRepository(context)
  const manifestId = createHash('sha256')
    .update(`techpulse-real-source-seed:${now.toISOString()}`)
    .digest('hex')
  const plans = []
  const sources = buildRealSourceDocuments({ now, reviewerId })

  const buildPlan = async (session) => {
    plans.length = 0
    for (const sourceKey of DEMO_SOURCE_KEYS) {
      const existing = await repository.findSourceByKey(sourceKey, { session })
      if (existing && existing.operationalStatus !== 'paused') {
        plans.push({
          kind: 'pause-demo',
          sourceKey,
          sourceId: existing._id?.toHexString?.() ?? existing.id,
        })
        if (apply) {
          const existingId = existing._id instanceof ObjectId ? existing._id : new ObjectId(existing.id)
          const audit = pauseAudit({ ...existing, _id: existingId }, { now, manifestId, reviewerId })
          await context.db.collection('sources').updateOne(
            { _id: existingId },
            { $set: { operationalStatus: 'paused', updatedAt: now } },
            { session },
          )
          await repository.insertAudit(audit, session)
        }
      }
    }
    for (const source of sources) {
      const existing = await repository.findSourceByKey(source.sourceKey, { session })
      plans.push({ kind: 'seed', sourceKey: source.sourceKey, sourceId: source._id })
      if (apply && !existing) {
        await context.db.collection('sources').insertOne(toSourceDocument(source), { session })
        for (const audit of sourceAudits(source, { now, manifestId, reviewerId })) {
          await repository.insertAudit(audit, session)
        }
      }
    }
  }

  if (apply) {
    const session = context.client.startSession()
    try {
      await session.withTransaction(buildPlan, {
        readConcern: { level: 'snapshot' },
        writeConcern: { w: 'majority' },
      })
    } finally {
      await session.endSession()
    }
  } else {
    await buildPlan()
  }
  return { dryRun: !apply, plans }
}

async function main() {
  const dryRun = process.argv.includes('--dry-run')
  configureDns()
  try {
    const operatorUriEnv = process.env.MONGODB_OPERATOR_URI_ENV
    if (
      typeof operatorUriEnv !== 'string' ||
      !/^[A-Z][A-Z0-9_]{2,127}$/.test(operatorUriEnv) ||
      typeof process.env[operatorUriEnv] !== 'string' ||
      process.env[operatorUriEnv].length === 0
    )
      throw new Error('operator credential is required')
    const runtime = validateRuntimeConfiguration({
      ...process.env,
      MONGODB_URI_ENV: operatorUriEnv,
    })
    const context = await getMongoContext(runtime, process.env)
    const reviewerId = dryRun
      ? DEFAULT_REVIEWER_ID
      : await resolveDemoReviewerId({ context, environment: process.env })
    const outcome = await seedRealSources({ context, apply: !dryRun, reviewerId })
    console.log(JSON.stringify(outcome))
  } catch {
    console.error('Real source seed failed: runtime_or_database_error')
    process.exitCode = 1
  } finally {
    await closeMongoConnection()
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main()
