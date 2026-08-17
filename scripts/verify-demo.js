import { pathToFileURL } from 'node:url'
import {
  buildSourceManifest,
  LIVE_SOURCE_DEFINITIONS,
  MIN_LIVE_DEMO_ARTICLES,
  MIN_LIVE_DEMO_ARTICLES_PER_SOURCE,
} from './seed-demo.js'
import { assertArticlesReady } from '../server/bootstrap/content.js'
import { assertSourcesReady } from '../server/bootstrap/sources.js'
import { validateRuntimeConfiguration } from '../server/config/runtime.js'
import { closeMongoConnection, getMongoContext } from '../server/repositories/mongo/connection.js'
import { configureDns } from './configure-dns.js'

export const LIVE_DEMO_SOURCE_KEYS = Object.freeze(
  LIVE_SOURCE_DEFINITIONS.map(({ sourceKey }) => sourceKey),
)

function missingItem(name, details = {}) {
  return { name, present: false, ...details }
}

const REQUIRED_SOURCE_AUDITS = Object.freeze([
  'source_created',
  'source_policy_reviewed',
  'source_technical_check_recorded',
  'source_status_updated:draft:testing',
  'source_status_updated:testing:active',
])

function sameObjectId(left, right) {
  return left?.equals instanceof Function && left.equals(right)
}

function auditSignature({ action, stateTransition } = {}) {
  return stateTransition ? `${action}:${stateTransition.from}:${stateTransition.to}` : action
}

function manifestIdFromRequest(requestId) {
  const match = typeof requestId === 'string' ? requestId.match(/:([a-f0-9]{64})$/) : null
  return match?.[1] ?? null
}

function currentManifestAudit(rows) {
  return rows
    .filter((row) => auditSignature(row) === 'source_status_updated:testing:active')
    .sort((left, right) => right.createdAt.getTime() - left.createdAt.getTime())[0]
}

export async function verifyDemoDataset({
  context,
  sourceKeys = LIVE_DEMO_SOURCE_KEYS,
  minimumArticles = MIN_LIVE_DEMO_ARTICLES,
  minimumArticlesPerSource = MIN_LIVE_DEMO_ARTICLES_PER_SOURCE,
} = {}) {
  if (!context?.db) throw new Error('Mongo context is required')
  if (!Array.isArray(sourceKeys) || sourceKeys.length === 0)
    throw new Error('source keys are required')
  const sourceRows = await context.db
    .collection('sources')
    .find(
      { sourceKey: { $in: sourceKeys } },
      { projection: { _id: 1, sourceKey: 1, operationalStatus: 1, licenseStatus: 1 } },
    )
    .toArray()
  const sourceIds = sourceRows.map(({ _id }) => _id)
  const articleRows =
    sourceIds.length === 0
      ? []
      : await context.db
          .collection('articles')
          .find(
            { sourceId: { $in: sourceIds }, status: 'published' },
            {
              projection: {
                _id: 1,
                sourceId: 1,
                externalId: 1,
                canonicalUrlHash: 1,
                retrievedAt: 1,
              },
            },
          )
          .toArray()
  const auditRows =
    sourceIds.length === 0
      ? []
      : await context.db
          .collection('adminAuditLogs')
          .find(
            { targetType: 'source', targetId: { $in: sourceIds }, result: 'succeeded' },
            {
              projection: {
                _id: 0,
                targetId: 1,
                action: 1,
                stateTransition: 1,
                requestId: 1,
                createdAt: 1,
              },
            },
          )
          .toArray()
  let auditCount = 0
  let incompleteAuditSources = 0
  let manifestCount = 0
  let articleCount = 0
  const perSourceArticleCounts = new Map()
  for (const source of sourceRows) {
    const sourceAudits = auditRows.filter(({ targetId }) => sameObjectId(targetId, source._id))
    const activeAudit = currentManifestAudit(sourceAudits)
    const manifestId = manifestIdFromRequest(activeAudit?.requestId)
    const currentAudits = manifestId
      ? sourceAudits.filter(({ requestId }) => manifestIdFromRequest(requestId) === manifestId)
      : []
    const signatures = new Set(currentAudits.map(auditSignature))
    const found = REQUIRED_SOURCE_AUDITS.filter((signature) => signatures.has(signature)).length
    auditCount += found
    if (found !== REQUIRED_SOURCE_AUDITS.length) incompleteAuditSources += 1
    const runAt = activeAudit?.createdAt
    const boundArticles =
      runAt instanceof Date && !Number.isNaN(runAt.getTime())
        ? articleRows.filter(
            ({ sourceId, retrievedAt }) =>
              sameObjectId(sourceId, source._id) &&
              retrievedAt instanceof Date &&
              retrievedAt.getTime() === runAt.getTime(),
          )
        : []
    perSourceArticleCounts.set(source.sourceKey, boundArticles.length)
    articleCount += boundArticles.length
    if (manifestId && runAt instanceof Date) {
      const expected = buildSourceManifest({ source, articles: boundArticles, runAt })
      if (expected.manifestId === manifestId) manifestCount += 1
    }
  }
  const foundKeys = new Set(sourceRows.map(({ sourceKey }) => sourceKey))
  const missing = sourceKeys
    .filter((sourceKey) => !foundKeys.has(sourceKey))
    .map((sourceKey) => missingItem(`source:${sourceKey}`))
  const inactive = sourceRows.filter(
    ({ operationalStatus, licenseStatus }) =>
      operationalStatus !== 'active' || !['permitted', 'metadata-only'].includes(licenseStatus),
  ).length
  if (inactive > 0)
    missing.push(
      missingItem('active-sources', {
        found: sourceRows.length - inactive,
        expected: sourceRows.length,
      }),
    )
  if (articleCount < minimumArticles)
    missing.push(missingItem('articles', { found: articleCount, expectedMinimum: minimumArticles }))
  for (const source of sourceRows) {
    const found = perSourceArticleCounts.get(source.sourceKey) ?? 0
    if (found < minimumArticlesPerSource)
      missing.push(
        missingItem(`articles:${source.sourceKey}`, {
          found,
          expectedMinimum: minimumArticlesPerSource,
        }),
      )
  }
  const expectedAuditCount = sourceRows.length * REQUIRED_SOURCE_AUDITS.length
  if (incompleteAuditSources > 0)
    missing.push(
      missingItem('source-audits', {
        found: auditCount,
        expected: expectedAuditCount,
        incompleteSources: incompleteAuditSources,
      }),
    )
  if (manifestCount !== sourceRows.length)
    missing.push(
      missingItem('source-manifests', { found: manifestCount, expected: sourceRows.length }),
    )
  return {
    verified: missing.length === 0,
    sources: { expected: sourceKeys.length, found: sourceRows.length },
    articles: {
      expectedMinimum: minimumArticles,
      expectedMinimumPerSource: minimumArticlesPerSource,
      found: articleCount,
    },
    audits: { expected: expectedAuditCount, found: auditCount },
    manifests: { expected: sourceRows.length, found: manifestCount },
    missing,
  }
}

async function main() {
  if (process.argv.length > 2) throw new Error('verify-demo does not accept arguments')
  configureDns()
  try {
    const runtime = validateRuntimeConfiguration(process.env)
    const context = await getMongoContext(runtime, process.env)
    await assertSourcesReady(context)
    await assertArticlesReady(context)
    const result = await verifyDemoDataset({ context })
    console.log(JSON.stringify(result))
    if (!result.verified) process.exitCode = 1
  } catch {
    console.error('Demo verify failed: runtime_or_database_error')
    process.exitCode = 1
  } finally {
    await closeMongoConnection()
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main()
