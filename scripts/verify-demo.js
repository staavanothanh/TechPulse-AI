import { pathToFileURL } from 'node:url'
import { LIVE_SOURCE_DEFINITIONS, MIN_LIVE_DEMO_ARTICLES } from './seed-demo.js'
import { assertArticlesReady } from '../server/bootstrap/content.js'
import { assertSourcesReady } from '../server/bootstrap/sources.js'
import { validateRuntimeConfiguration } from '../server/config/runtime.js'
import { closeMongoConnection, getMongoContext } from '../server/repositories/mongo/connection.js'
import { configureDns } from './configure-dns.js'

export const LIVE_DEMO_SOURCE_KEYS = Object.freeze(LIVE_SOURCE_DEFINITIONS.map(({ sourceKey }) => sourceKey))

function missingItem(name, details = {}) { return { name, present: false, ...details } }

export async function verifyDemoDataset({ context, sourceKeys = LIVE_DEMO_SOURCE_KEYS, minimumArticles = MIN_LIVE_DEMO_ARTICLES } = {}) {
  if (!context?.db) throw new Error('Mongo context is required')
  if (!Array.isArray(sourceKeys) || sourceKeys.length === 0) throw new Error('source keys are required')
  const sourceRows = await context.db.collection('sources').find({ sourceKey: { $in: sourceKeys } }, { projection: { _id: 1, sourceKey: 1, operationalStatus: 1, licenseStatus: 1 } }).toArray()
  const sourceIds = sourceRows.map(({ _id }) => _id)
  const articleCount = sourceIds.length === 0 ? 0 : await context.db.collection('articles').countDocuments({ sourceId: { $in: sourceIds }, status: 'published' })
  const auditCount = sourceIds.length === 0 ? 0 : await context.db.collection('adminAuditLogs').countDocuments({ action: 'source_created', targetType: 'source', targetId: { $in: sourceIds }, result: 'succeeded' })
  const foundKeys = new Set(sourceRows.map(({ sourceKey }) => sourceKey))
  const missing = sourceKeys.filter((sourceKey) => !foundKeys.has(sourceKey)).map((sourceKey) => missingItem(`source:${sourceKey}`))
  const inactive = sourceRows.filter(({ operationalStatus, licenseStatus }) => operationalStatus !== 'active' || !['permitted', 'metadata-only'].includes(licenseStatus)).length
  if (inactive > 0) missing.push(missingItem('active-sources', { found: sourceRows.length - inactive, expected: sourceRows.length }))
  if (articleCount < minimumArticles) missing.push(missingItem('articles', { found: articleCount, expectedMinimum: minimumArticles }))
  if (auditCount < sourceRows.length) missing.push(missingItem('source-audits', { found: auditCount, expected: sourceRows.length }))
  return {
    verified: missing.length === 0,
    sources: { expected: sourceKeys.length, found: sourceRows.length },
    articles: { expectedMinimum: minimumArticles, found: articleCount },
    audits: { expected: sourceRows.length, found: auditCount },
    missing,
  }
}

async function main() {
  if (process.argv.length > 2) throw new Error('verify-demo does not accept arguments')
  configureDns()
  try {
    const operatorUriEnv = process.env.MONGODB_OPERATOR_URI_ENV
    if (typeof operatorUriEnv !== 'string' || !/^[A-Z][A-Z0-9_]{2,127}$/.test(operatorUriEnv) || typeof process.env[operatorUriEnv] !== 'string' || process.env[operatorUriEnv].length === 0) throw new Error('operator credential is required')
    const runtime = validateRuntimeConfiguration({ ...process.env, MONGODB_URI_ENV: operatorUriEnv })
    const context = await getMongoContext(runtime, process.env)
    await assertSourcesReady(context)
    await assertArticlesReady(context)
    const result = await verifyDemoDataset({ context })
    console.log(JSON.stringify(result))
    if (!result.verified) process.exitCode = 1
  } catch {
    console.error('Demo verify failed: runtime_or_database_error')
    process.exitCode = 1
  } finally { await closeMongoConnection() }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main()
