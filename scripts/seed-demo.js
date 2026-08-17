import { createHash } from 'node:crypto'
import { pathToFileURL } from 'node:url'
import { ObjectId } from 'mongodb'
import { createSourceAuditEvent } from '../server/audit/source-writer.js'
import { assertArticlesReady } from '../server/bootstrap/content.js'
import { assertSourcesReady } from '../server/bootstrap/sources.js'
import { validateRuntimeConfiguration } from '../server/config/runtime.js'
import { normalizeCandidateToArticle } from '../server/domain/article/normalization.js'
import { createArxivConnector, ARXIV_CONTENT_TYPES } from '../server/connectors/arxiv/index.js'
import { createHackerNewsConnector } from '../server/connectors/hacker-news/index.js'
import { createRssConnector, RSS_CONTENT_TYPES } from '../server/connectors/rss/index.js'
import { createSafeFetch } from '../server/infrastructure/http/safe-fetch.js'
import { articleDocument } from '../server/repositories/mongo/article-repository.js'
import { closeMongoConnection, getMongoContext } from '../server/repositories/mongo/connection.js'
import { validateArticleDocument } from './migrations/articles.js'
import { validateSourceDocument } from './migrations/sources.js'
import { configureDns } from './configure-dns.js'

export const MAX_DEMO_ARTICLES = 50
export const MIN_LIVE_DEMO_ARTICLES = 20
export const MIN_LIVE_DEMO_ARTICLES_PER_SOURCE = 5
export const LIVE_SOURCE_DEFINITIONS = Object.freeze([
  Object.freeze({
    name: 'The Verge Technology (live demo)',
    sourceKey: 'demo:rss-the-verge',
    publisherName: 'The Verge',
    domain: 'www.theverge.com',
    connectorType: 'rss',
    accessMethod: 'rss',
    authorityTier: 'editorial',
    connectorConfig: Object.freeze({
      kind: 'rss',
      feedUrl: 'https://www.theverge.com/rss/index.xml',
      batchSize: 17,
    }),
    termsUrl: 'https://www.theverge.com/terms-of-use',
    licenseUrl: 'https://www.theverge.com/terms-of-use',
  }),
  Object.freeze({
    name: 'arXiv Computer Science AI (live demo)',
    sourceKey: 'demo:arxiv-cs-ai',
    publisherName: 'arXiv',
    domain: 'export.arxiv.org',
    connectorType: 'arxiv',
    accessMethod: 'api',
    authorityTier: 'primary',
    connectorConfig: Object.freeze({ kind: 'arxiv', arxivQuery: 'cat:cs.AI', batchSize: 30 }),
    termsUrl: 'https://info.arxiv.org/help/license/index.html',
    licenseUrl: 'https://info.arxiv.org/help/license/index.html',
  }),
  Object.freeze({
    name: 'Hacker News Top Stories (live demo)',
    sourceKey: 'demo:hn-topstories',
    publisherName: 'Hacker News',
    domain: 'news.ycombinator.com',
    connectorType: 'hacker-news',
    accessMethod: 'api',
    authorityTier: 'community-signal',
    connectorConfig: Object.freeze({
      kind: 'hacker-news',
      hackerNewsStream: 'topstories',
      batchSize: 20,
    }),
    termsUrl: 'https://news.ycombinator.com/newsguidelines.html',
    licenseUrl: 'https://news.ycombinator.com/newsguidelines.html',
  }),
])

const SOURCE_POLICY_FIELDS = Object.freeze([
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
const SYSTEM_ACTOR = Object.freeze({ id: 'system:real-demo-seed', role: 'system-worker' })
const DEFAULT_REVIEWER_ID = new ObjectId('507f1f77bcf86cd799439011')

function deterministicObjectId(namespace, value) {
  return new ObjectId(
    createHash('sha256').update(`${namespace}\u0000${value}`).digest().subarray(0, 12),
  )
}

function asDate(value, label) {
  const date = value instanceof Date ? new Date(value) : new Date(value)
  if (Number.isNaN(date.getTime())) throw new Error(`${label} is invalid`)
  return date
}

function lifecycleTimes(value) {
  const active = asDate(value, 'source lifecycle time')
  const atOffset = (milliseconds) => new Date(active.getTime() + milliseconds)
  return {
    created: atOffset(-4),
    reviewed: atOffset(-3),
    technicalCheck: atOffset(-2),
    testing: atOffset(-1),
    active,
  }
}

function sourceId(source) {
  const value = source?._id ?? source?.id
  if (value instanceof ObjectId) return value
  if (typeof value === 'string' && ObjectId.isValid(value)) return new ObjectId(value)
  return deterministicObjectId('techpulse-real-demo-source', source?.sourceKey)
}

function sourceView(source) {
  const id = sourceId(source)
  return { ...source, _id: id, id: id.toHexString() }
}

function sourceDocument(
  definition,
  { now, reviewerId = DEFAULT_REVIEWER_ID, technicalCheck } = {},
) {
  const retrievedAt = asDate(now, 'retrievedAt')
  const lifecycle = lifecycleTimes(retrievedAt)
  const id = sourceId(definition)
  const check = technicalCheck ?? {
    status: 'passed',
    checkedAt: retrievedAt,
    contentType: 'application/json',
    resolvedHost: definition.domain,
    sampleCount: 1,
    error: null,
  }
  return {
    _id: id,
    name: definition.name,
    sourceKey: definition.sourceKey,
    publisherName: definition.publisherName,
    domain: definition.domain,
    connectorType: definition.connectorType,
    accessMethod: definition.accessMethod,
    authorityTier: definition.authorityTier,
    connectorConfig: { ...definition.connectorConfig },
    operationalStatus: 'active',
    licenseStatus: 'metadata-only',
    llmInputScope: 'metadata',
    storageScope: { metadata: true, excerpt: false, summary: false, embedding: false },
    mediaPolicy: {
      imageMode: 'none',
      videoMode: 'none',
      allowedHosts: [],
      attributionRequired: false,
      evidenceNote: 'Chi luu metadata cong khai; khong tai media vao demo local.',
    },
    attributionRequired: false,
    attributionText: null,
    termsUrl: definition.termsUrl,
    licenseUrl: definition.licenseUrl,
    evidenceNote:
      'Operator bootstrap cho demo local; du lieu duoc lay truc tiep tu connector cong khai va chi luu metadata.',
    reviewedAt: lifecycle.reviewed,
    reviewedBy: reviewerId instanceof ObjectId ? reviewerId : new ObjectId(reviewerId),
    policyVersion: 2,
    reconciliation: {
      status: 'completed',
      requiredPolicyVersion: 2,
      completedPolicyVersion: 2,
      requestedAt: lifecycle.reviewed,
      error: null,
    },
    technicalCheck: {
      status: check.status,
      checkedAt: lifecycle.technicalCheck,
      contentType: check.contentType ?? null,
      resolvedHost: check.resolvedHost ?? null,
      sampleCount: check.sampleCount ?? null,
      error: check.error ?? null,
    },
    health: {
      lastIngestSucceededAt: retrievedAt,
      lastIngestFailedAt: null,
      consecutiveFailures: 0,
      lastError: null,
    },
    createdAt: lifecycle.created,
    updatedAt: lifecycle.active,
  }
}

function auditRequest(source, suffix, manifestId) {
  return { serverRequestId: `seed:real-demo:${source.sourceKey}:${suffix}:${manifestId}` }
}

function sourceAudits(source, { now, reviewerId = DEFAULT_REVIEWER_ID, manifestId } = {}) {
  if (typeof manifestId !== 'string' || !/^[a-f0-9]{64}$/.test(manifestId))
    throw new Error('demo source manifest is required')
  const lifecycle = lifecycleTimes(now)
  const targetId = source._id
  const admin = {
    _id: reviewerId instanceof ObjectId ? reviewerId : new ObjectId(reviewerId),
    role: 'admin',
  }
  const events = [
    {
      actor: SYSTEM_ACTOR,
      action: 'source_created',
      changedFields: ['sourceKey', 'operationalStatus', 'policyVersion'],
      reasonCode: 'source_created',
      suffix: 'created',
      createdAt: lifecycle.created,
    },
    {
      actor: admin,
      action: 'source_policy_reviewed',
      changedFields: [...SOURCE_POLICY_FIELDS],
      reasonCode: 'source_policy_reviewed',
      suffix: 'policy-review',
      createdAt: lifecycle.reviewed,
    },
    {
      actor: admin,
      action: 'source_technical_check_recorded',
      changedFields: ['technicalCheck'],
      reasonCode: 'source_technical_check_requested',
      suffix: 'technical-check',
      createdAt: lifecycle.technicalCheck,
    },
    {
      actor: admin,
      action: 'source_status_updated',
      changedFields: ['operationalStatus'],
      reasonCode: 'source_status_changed',
      stateTransition: { from: 'draft', to: 'testing' },
      suffix: 'draft-testing',
      createdAt: lifecycle.testing,
    },
    {
      actor: admin,
      action: 'source_status_updated',
      changedFields: ['operationalStatus'],
      reasonCode: 'source_status_changed',
      stateTransition: { from: 'testing', to: 'active' },
      suffix: 'testing-active',
      createdAt: lifecycle.active,
    },
  ]
  return events.map(({ suffix, createdAt, ...input }) => ({
    _id: deterministicObjectId('techpulse-real-demo-audit', `${source.sourceKey}:${suffix}`),
    ...createSourceAuditEvent({
      ...input,
      targetId,
      request: auditRequest(source, suffix, manifestId),
      createdAt,
    }),
  }))
}

function articleIdentity(article, source) {
  return `${source.sourceKey}\u0000${article.externalId ?? article.canonicalUrlHash ?? article.originalUrl}`
}

export function buildSourceManifest({ source, articles, runAt } = {}) {
  const observedAt = asDate(runAt, 'manifest runAt')
  if (!source?._id || typeof source.sourceKey !== 'string' || !Array.isArray(articles))
    throw new Error('demo source manifest input is invalid')
  const sourceObjectId = sourceId(source)
  const entries = articles
    .filter(({ sourceId: value }) => sameValue(value, sourceObjectId))
    .map((article) => ({
      id: article._id.toHexString(),
      externalId: article.externalId ?? null,
      canonicalUrlHash: article.canonicalUrlHash,
    }))
    .sort((left, right) => left.id.localeCompare(right.id))
  const payload = {
    sourceKey: source.sourceKey,
    runAt: observedAt.toISOString(),
    articles: entries,
  }
  return {
    sourceId: sourceObjectId,
    sourceKey: source.sourceKey,
    runAt: observedAt,
    articleCount: entries.length,
    manifestId: createHash('sha256').update(JSON.stringify(payload)).digest('hex'),
  }
}

function connectorEvidence(result, fallback) {
  const evidence = result?.sourceEvidence ?? {}
  return {
    status: 'passed',
    checkedAt: fallback,
    contentType: evidence.contentType ?? 'application/json',
    resolvedHost: evidence.resolvedHost ?? null,
    sampleCount: Math.max(1, Number(evidence.sampleCount ?? result?.candidates?.length ?? 1)),
    error: null,
  }
}

function safeErrorCode(error) {
  return typeof error?.code === 'string' && /^[a-z0-9_:-]{1,128}$/.test(error.code)
    ? error.code
    : 'source_fetch_failed'
}

function sourceBudget(source, maxArticles, sourceCount) {
  const fairShare = Math.max(1, Math.ceil(maxArticles / sourceCount))
  if (source.connectorType === 'arxiv') return Math.min(fairShare, 30)
  if (source.connectorType === 'hacker-news') return Math.min(fairShare, 20)
  return Math.min(maxArticles, fairShare)
}

function normalizeCandidates(source, candidates, retrievedAt, maxArticles, seen) {
  const articles = []
  let skipped = 0
  for (const candidate of candidates ?? []) {
    if (articles.length >= maxArticles) break
    try {
      const normalized = normalizeCandidateToArticle(candidate, {
        source: sourceView(source),
        now: retrievedAt,
      })
      const key = articleIdentity(normalized, source)
      if (seen.has(key)) continue
      seen.add(key)
      articles.push(
        articleDocument(normalized, deterministicObjectId('techpulse-real-demo-article', key)),
      )
    } catch {
      skipped += 1
    }
  }
  return { articles, skipped }
}

export function createLiveConnectorRegistry({
  safeFetch = createSafeFetch(),
  now = () => new Date(),
} = {}) {
  const observations = new Map()
  const rss = createRssConnector({ now })
  const arxiv = createArxivConnector({
    now,
    request: async ({ url }) => {
      const response = await safeFetch(url, { allowedContentTypes: ARXIV_CONTENT_TYPES })
      observations.set('arxiv', {
        contentType: response.contentType,
        resolvedHost: response.resolvedHost,
      })
      return response
    },
  })
  const hackerNews = createHackerNewsConnector({
    now,
    request: async ({ url }) => {
      const response = await safeFetch(url, { allowedContentTypes: ['application/json'] })
      if (!observations.has('hacker-news'))
        observations.set('hacker-news', {
          contentType: response.contentType,
          resolvedHost: response.resolvedHost,
        })
      return response
    },
  })
  return {
    resolve(source) {
      const connector =
        source.connectorType === 'rss' ? rss : source.connectorType === 'arxiv' ? arxiv : hackerNews
      if (!connector) throw new Error('connector is unavailable')
      return {
        ...connector,
        async run(input) {
          let requestInput = input
          if (source.connectorType === 'rss' && input?.payload === undefined) {
            const response = await safeFetch(source.connectorConfig.feedUrl, {
              allowedContentTypes: RSS_CONTENT_TYPES,
            })
            observations.set('rss', {
              contentType: response.contentType,
              resolvedHost: response.resolvedHost,
            })
            requestInput = { ...input, payload: response }
          }
          const result = await connector.run(requestInput)
          return {
            ...result,
            sourceEvidence: {
              ...(observations.get(source.connectorType) ?? {}),
              sampleCount: result.candidates.length,
            },
          }
        },
      }
    },
  }
}

export function buildLiveSourceDocuments({
  now = new Date(),
  reviewerId = DEFAULT_REVIEWER_ID,
} = {}) {
  return LIVE_SOURCE_DEFINITIONS.map((definition) =>
    sourceDocument(definition, { now, reviewerId }),
  )
}

export async function buildDemoDataset({
  sources,
  connectorRegistry,
  retrievedAt = new Date(),
  maxArticles = MAX_DEMO_ARTICLES,
  allowSourceFailures = false,
} = {}) {
  if (!Array.isArray(sources) || sources.length === 0)
    throw new Error('at least one real source is required')
  if (!connectorRegistry?.resolve) throw new Error('connector registry is required')
  if (!Number.isInteger(maxArticles) || maxArticles < 1 || maxArticles > MAX_DEMO_ARTICLES)
    throw new Error('demo article limit is invalid')
  const observedAt = asDate(retrievedAt, 'retrievedAt')
  const selectedSources = [],
    articles = [],
    diagnostics = [],
    seen = new Set()
  for (const rawSource of sources) {
    const source = sourceView(rawSource)
    const perSourceBudget = sourceBudget(source, maxArticles, sources.length)
    try {
      const connector = connectorRegistry.resolve(source)
      const result = await connector.run({
        source,
        retrievedAt: observedAt,
        ...(source.connectorType === 'arxiv'
          ? { maxResults: Math.min(perSourceBudget, 30), maxPages: 1 }
          : {}),
      })
      const enrichedSource = sourceDocument(source, {
        now: observedAt,
        reviewerId: source.reviewedBy ?? DEFAULT_REVIEWER_ID,
        technicalCheck: connectorEvidence(result, observedAt),
      })
      const normalized = normalizeCandidates(
        enrichedSource,
        result.candidates,
        observedAt,
        perSourceBudget,
        seen,
      )
      selectedSources.push(enrichedSource)
      articles.push(...normalized.articles)
      diagnostics.push({
        sourceKey: enrichedSource.sourceKey,
        connector: enrichedSource.connectorType,
        fetched: result.candidates.length,
        accepted: normalized.articles.length,
        skipped: normalized.skipped,
      })
    } catch (error) {
      diagnostics.push({
        sourceKey: source.sourceKey,
        connector: source.connectorType,
        fetched: 0,
        accepted: 0,
        skipped: 0,
        error: safeErrorCode(error),
      })
      if (!allowSourceFailures) throw error
    }
    if (articles.length >= maxArticles) break
  }
  const selectedArticles = articles.slice(0, maxArticles)
  const manifests = selectedSources.map((source) =>
    buildSourceManifest({ source, articles: selectedArticles, runAt: observedAt }),
  )
  const audits = selectedSources.flatMap((source) => {
    const manifest = manifests.find(({ sourceId: value }) => sameValue(value, source._id))
    return sourceAudits(source, {
      now: observedAt,
      reviewerId: source.reviewedBy,
      manifestId: manifest?.manifestId,
    })
  })
  return assertDataset({
    sources: selectedSources,
    articles: selectedArticles,
    audits,
    diagnostics,
    manifests,
    expectedSourceKeys: sources.map(({ sourceKey }) => sourceKey),
  })
}

function assertDataset(dataset) {
  if (!Array.isArray(dataset.sources) || dataset.sources.length === 0)
    throw new Error('real demo sources are empty')
  for (const source of dataset.sources) {
    const validation = validateSourceDocument(source)
    if (!validation.valid)
      throw new Error(`real demo source is invalid: ${validation.errors.join(', ')}`)
  }
  for (const article of dataset.articles) {
    const validation = validateArticleDocument(article)
    if (!validation.valid)
      throw new Error(`real demo article is invalid: ${validation.errors.join(', ')}`)
  }
  if (dataset.articles.some((article) => article.originalUrl.includes('.example')))
    throw new Error('real demo article URL is not a real source URL')
  for (const manifest of dataset.manifests ?? []) {
    const source = dataset.sources.find(({ _id }) => sameValue(_id, manifest.sourceId))
    const expected = buildSourceManifest({
      source,
      articles: dataset.articles,
      runAt: manifest.runAt,
    })
    if (
      manifest.manifestId !== expected.manifestId ||
      manifest.articleCount !== expected.articleCount
    )
      throw new Error('real demo manifest is invalid')
  }
  return dataset
}

function assertApplyDataset(dataset) {
  const expectedKeys = dataset.expectedSourceKeys ?? []
  const diagnostics = dataset.diagnostics ?? []
  if (
    expectedKeys.length === 0 ||
    diagnostics.length !== expectedKeys.length ||
    dataset.manifests?.length !== expectedKeys.length
  )
    throw new Error('demo apply requires diagnostics for every live source')
  for (const sourceKey of expectedKeys) {
    const diagnostic = diagnostics.find((entry) => entry.sourceKey === sourceKey)
    const source = dataset.sources.find((entry) => entry.sourceKey === sourceKey)
    const articleCount = source
      ? dataset.articles.filter(({ sourceId: value }) => sameValue(value, source._id)).length
      : 0
    if (
      !diagnostic ||
      diagnostic.error ||
      !source ||
      articleCount < MIN_LIVE_DEMO_ARTICLES_PER_SOURCE
    )
      throw new Error('demo apply requires every live source and its minimum article count')
  }
  if (dataset.articles.length < MIN_LIVE_DEMO_ARTICLES)
    throw new Error('demo apply requires the total article minimum')
}

export function parseSeedMode(args = []) {
  if (args.length === 0) return { apply: false }
  if (args.length === 1 && args[0] === '--apply') return { apply: true }
  throw new Error('unsupported demo seed arguments')
}

function sameValue(left, right) {
  return left?.equals instanceof Function ? left.equals(right) : left === right
}
const SOURCE_OBSERVATION_PATHS = new Set([
  'createdAt',
  'updatedAt',
  'reviewedAt',
  'reconciliation.requestedAt',
  'technicalCheck.checkedAt',
  'technicalCheck.sampleCount',
  'health',
])
const ARTICLE_OBSERVATION_PATHS = new Set([
  'retrievedAt',
  'createdAt',
  'updatedAt',
  'rightsSnapshot.capturedAt',
  'provenance.*.observedAt',
])
const AUDIT_OBSERVATION_PATHS = new Set(['createdAt'])

function normalizedPayload(value, omittedPaths = new Set(), path = '') {
  if (value instanceof ObjectId) return { $oid: value.toHexString() }
  if (value instanceof Date) return { $date: value.toISOString() }
  if (Array.isArray(value))
    return value.map((item) => normalizedPayload(item, omittedPaths, path ? `${path}.*` : '*'))
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.keys(value)
        .filter(
          (key) => value[key] !== undefined && !omittedPaths.has(path ? `${path}.${key}` : key),
        )
        .sort()
        .map((key) => [
          key,
          normalizedPayload(value[key], omittedPaths, path ? `${path}.${key}` : key),
        ]),
    )
  return value
}
function samePayload(left, right, omittedPaths) {
  return (
    JSON.stringify(normalizedPayload(left, omittedPaths)) ===
    JSON.stringify(normalizedPayload(right, omittedPaths))
  )
}
function countResult(result) {
  return {
    seeded: result.upsertedCount === 1 ? 1 : 0,
    existing: result.upsertedCount === 1 ? 0 : 1,
  }
}
function addCounts(left, right) {
  return { seeded: left.seeded + right.seeded, existing: left.existing + right.existing }
}

async function insertOnly(
  collection,
  filter,
  document,
  session,
  identityFields = [],
  omittedPaths = new Set(),
) {
  const existing = await collection.findOne(filter, { session })
  if (existing) {
    if (identityFields.some((field) => !sameValue(existing[field], document[field])))
      throw new Error('demo source/article identity conflicts with existing data')
    if (!samePayload(existing, document, omittedPaths))
      throw new Error('demo insert-only payload conflicts with existing data')
    return { seeded: 0, existing: 1 }
  }
  const write = await collection.updateOne(
    filter,
    { $setOnInsert: document },
    { upsert: true, session },
  )
  if (write.upsertedCount === 1) return countResult(write)
  const raced = await collection.findOne(filter, { session })
  if (!raced || !samePayload(raced, document, omittedPaths))
    throw new Error('demo insert-only payload conflicts with concurrent data')
  return { seeded: 0, existing: 1 }
}

async function insertArticleOnly(collection, document, session) {
  const existingById = await collection.findOne({ _id: document._id }, { session })
  const existingByUrl = existingById
    ? null
    : await collection.findOne({ canonicalUrlHash: document.canonicalUrlHash }, { session })
  const existing = existingById ?? existingByUrl
  if (existing) {
    if (
      !sameValue(existing.sourceId, document.sourceId) ||
      existing.externalId !== document.externalId ||
      existing.canonicalUrlHash !== document.canonicalUrlHash
    )
      throw new Error('demo article identity conflicts with existing data')
    if (!samePayload(existing, document, ARTICLE_OBSERVATION_PATHS))
      throw new Error('demo insert-only payload conflicts with existing data')
    return { seeded: 0, existing: 1 }
  }
  const filter = { _id: document._id }
  const write = await collection.updateOne(
    filter,
    { $setOnInsert: document },
    { upsert: true, session },
  )
  if (write.upsertedCount === 1) return countResult(write)
  const raced = await collection.findOne(filter, { session })
  if (!raced || !samePayload(raced, document, ARTICLE_OBSERVATION_PATHS))
    throw new Error('demo insert-only payload conflicts with concurrent data')
  return { seeded: 0, existing: 1 }
}

async function insertAuditOnly(collection, document, session) {
  const existingById = await collection.findOne({ _id: document._id }, { session })
  if (existingById && existingById.eventId !== document.eventId)
    throw new Error('demo audit manifest identity conflicts with existing data')
  return insertOnly(
    collection,
    { eventId: document.eventId },
    document,
    session,
    ['action', 'targetType', 'targetId', 'requestId', 'result'],
    AUDIT_OBSERVATION_PATHS,
  )
}

export async function applyDemoDataset({ context, dataset } = {}) {
  if (!context?.db || !context?.client?.startSession) throw new Error('Mongo context is required')
  assertDataset(dataset)
  assertApplyDataset(dataset)
  const session = context.client.startSession()
  try {
    let result
    await session.withTransaction(
      async () => {
        const sources = context.db.collection('sources'),
          articles = context.db.collection('articles'),
          audits = context.db.collection('adminAuditLogs')
        let sourceCounts = { seeded: 0, existing: 0 },
          articleCounts = { seeded: 0, existing: 0 },
          auditCounts = { seeded: 0, existing: 0 }
        for (const source of dataset.sources) {
          const sourceByKey = await sources.findOne(
            { sourceKey: source.sourceKey },
            { session, projection: { _id: 1 } },
          )
          const sourceById = await sources.findOne(
            { _id: source._id },
            { session, projection: { sourceKey: 1 } },
          )
          if (
            (sourceByKey && !sameValue(sourceByKey._id, source._id)) ||
            (sourceById && sourceById.sourceKey !== source.sourceKey)
          )
            throw new Error('demo source identity conflicts with existing data')
          sourceCounts = addCounts(
            sourceCounts,
            await insertOnly(
              sources,
              { _id: source._id },
              source,
              session,
              ['sourceKey', 'connectorType', 'domain'],
              SOURCE_OBSERVATION_PATHS,
            ),
          )
        }
        for (const audit of dataset.audits ?? [])
          auditCounts = addCounts(auditCounts, await insertAuditOnly(audits, audit, session))
        for (const article of dataset.articles)
          articleCounts = addCounts(
            articleCounts,
            await insertArticleOnly(articles, article, session),
          )
        result = { sources: sourceCounts, articles: articleCounts, audits: auditCounts }
      },
      { readConcern: { level: 'snapshot' }, writeConcern: { w: 'majority' } },
    )
    return result
  } finally {
    await session.endSession()
  }
}

export async function seedDemo({ context, dataset, apply = false } = {}) {
  if (!dataset) throw new Error('real demo dataset is required')
  if (!apply)
    return {
      dryRun: true,
      sources: dataset.sources.length,
      articles: dataset.articles.length,
      audits: dataset.audits?.length ?? 0,
      diagnostics: dataset.diagnostics ?? [],
      manifests: dataset.manifests ?? [],
    }
  return { dryRun: false, ...(await applyDemoDataset({ context, dataset })) }
}

export async function resolveDemoReviewerId({ context, environment = process.env } = {}) {
  if (environment.DEMO_SOURCE_POLICY_ATTESTED !== 'true')
    throw new Error('demo source policy attestation is required')
  const reviewerValue = environment.DEMO_SOURCE_REVIEWER_ID
  if (
    typeof reviewerValue !== 'string' ||
    !ObjectId.isValid(reviewerValue) ||
    new ObjectId(reviewerValue).toHexString() !== reviewerValue.toLowerCase()
  )
    throw new Error('demo source reviewer identity is invalid')
  const reviewerId = new ObjectId(reviewerValue)
  const reviewer = await context.db
    .collection('users')
    .findOne({ _id: reviewerId, role: 'admin', status: 'active' }, { projection: { _id: 1 } })
  if (!reviewer?._id) throw new Error('an active admin reviewer is required for demo source audit')
  return reviewer._id
}

async function main() {
  const mode = parseSeedMode(process.argv.slice(2))
  configureDns()
  let context
  try {
    if (mode.apply) {
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
      context = await getMongoContext(runtime, process.env)
      await assertSourcesReady(context)
      await assertArticlesReady(context)
    }
    const reviewerId = mode.apply
      ? await resolveDemoReviewerId({ context, environment: process.env })
      : DEFAULT_REVIEWER_ID
    const dataset = await buildDemoDataset({
      sources: buildLiveSourceDocuments({ now: new Date(), reviewerId }),
      connectorRegistry: createLiveConnectorRegistry(),
      retrievedAt: new Date(),
      maxArticles: MAX_DEMO_ARTICLES,
      allowSourceFailures: !mode.apply,
    })
    if (dataset.articles.length < MIN_LIVE_DEMO_ARTICLES)
      throw new Error('real connector demo returned too few articles')
    const outcome = await seedDemo({ context, dataset, apply: mode.apply })
    console.log(JSON.stringify({ ...outcome, diagnostics: dataset.diagnostics }))
  } catch {
    console.error('Demo seed failed: real_connector_or_database_error')
    process.exitCode = 1
  } finally {
    await closeMongoConnection()
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main()
