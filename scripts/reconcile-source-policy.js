import { pathToFileURL } from 'node:url'
import { createSourcePolicyReconciliationWorker, SOURCE_POLICY_RECONCILIATION_LIMIT, SOURCE_POLICY_RECONCILIATION_MAX_PAGES } from '../server/application/indexing/source-policy-reconciliation.js'
import { assertIndexingJobsReady, assertSourcePolicyReconciliationReady, configuredEmbeddingTarget } from '../server/bootstrap/indexing.js'
import { assertProviderRoutingReady } from '../server/bootstrap/provider-routing.js'
import { assertSourcesReady } from '../server/bootstrap/sources.js'
import { validateRuntimeConfiguration } from '../server/config/runtime.js'
import { getMongoContext, closeMongoConnection } from '../server/repositories/mongo/connection.js'
import { MongoIndexingJobRepository } from '../server/repositories/mongo/indexing-job-repository.js'
import { MongoLeaseRepository } from '../server/repositories/mongo/lease-repository.js'
import { MongoSourceRepository } from '../server/repositories/mongo/source-repository.js'

const DATABASE_NAME = /^[A-Za-z0-9][A-Za-z0-9_]{0,62}$/
const SOURCE_ID = /^[a-f0-9]{24}$/i
export const RECONCILE_SOURCE_POLICY_USAGE = 'Usage: node scripts/reconcile-source-policy.js --source-id=<24-hex ObjectId> [--limit=1..100] [--max-pages=1..10] [--confirm --confirm-database=<database>]'

function boundedInteger(value, label, maximum) {
  const result = Number(value)
  if (!Number.isInteger(result) || result < 1 || result > maximum) throw new Error(`${label} is invalid`)
  return result
}

export function parseReconcileSourcePolicyArgs(args = []) {
  let sourceId
  let limit = SOURCE_POLICY_RECONCILIATION_LIMIT
  let maxPages = SOURCE_POLICY_RECONCILIATION_MAX_PAGES
  let confirm = false
  let confirmDatabase = null
  for (const argument of args) {
    if (argument === '--help') return { help: true }
    if (argument === '--confirm') confirm = true
    else if (argument.startsWith('--source-id=')) sourceId = argument.slice('--source-id='.length)
    else if (argument.startsWith('--limit=')) limit = boundedInteger(argument.slice('--limit='.length), 'limit', SOURCE_POLICY_RECONCILIATION_LIMIT)
    else if (argument.startsWith('--max-pages=')) maxPages = boundedInteger(argument.slice('--max-pages='.length), 'max-pages', SOURCE_POLICY_RECONCILIATION_MAX_PAGES)
    else if (argument.startsWith('--confirm-database=')) confirmDatabase = argument.slice('--confirm-database='.length)
    else throw new Error('arguments are invalid')
  }
  if (typeof sourceId !== 'string' || !SOURCE_ID.test(sourceId)) throw new Error('source-id is required and must be a 24-hex ObjectId')
  if (confirm && (!confirmDatabase || !DATABASE_NAME.test(confirmDatabase))) throw new Error('confirm-database is required with confirm')
  if (!confirm && confirmDatabase !== null) throw new Error('confirm-database requires confirm')
  return Object.freeze({ sourceId: sourceId.toLowerCase(), limit, maxPages, confirm, dryRun: !confirm, confirmDatabase })
}

function embeddingTargetFor(registry) {
  const hasEmbeddingWorkload = Array.isArray(registry?.workloadPolicies) && registry.workloadPolicies.some((policy) => policy.workloadId === 'embedding')
  return hasEmbeddingWorkload ? configuredEmbeddingTarget(registry) : undefined
}

export async function createConfiguredSourcePolicyReconciliationRuntime({ environment = process.env } = {}) {
  const runtimeConfig = validateRuntimeConfiguration(environment)
  const context = await getMongoContext(runtimeConfig, environment)
  await assertIndexingJobsReady(context)
  await assertProviderRoutingReady(context)
  await assertSourcesReady(context)
  await assertSourcePolicyReconciliationReady(context)
  const embeddingTarget = embeddingTargetFor(runtimeConfig.providerRegistry)
  const indexingJobRepository = new MongoIndexingJobRepository(context, embeddingTarget ? { embeddingTarget } : {})
  const sourceRepository = new MongoSourceRepository(context)
  const worker = createSourcePolicyReconciliationWorker({
    sourceRepository,
    indexingJobRepository,
    leaseRepository: new MongoLeaseRepository(context),
  })
  return Object.freeze({ database: context.database, worker })
}

function safeJob(job) {
  if (!job || typeof job !== 'object') return null
  return Object.fromEntries([
    'id', 'idempotencyKey', 'actorScope', 'requestHash', 'articleId', 'sourceId', 'expectedSourcePolicyVersion',
    'task', 'trigger', 'status', 'attempt', 'priority', 'targetEmbeddingVersion', 'targetEmbeddingArtifactCompatibilityId',
  ].flatMap((field) => job[field] === undefined ? [] : [[field, job[field]]]))
}

function safeReport(result = {}) {
  return {
    outcome: result.outcome ?? 'failed',
    sourceId: result.sourceId ?? null,
    sourceKey: result.sourceKey ?? null,
    policyVersion: result.policyVersion ?? null,
    requiredPolicyVersion: result.requiredPolicyVersion ?? null,
    operationalStatus: result.operationalStatus ?? null,
    reconciliation: result.reconciliation ?? null,
    inspected: Number(result.inspected ?? 0),
    staleArticleCount: Number(result.staleArticleCount ?? 0),
    wouldCreate: Number(result.wouldCreate ?? 0),
    created: Number(result.created ?? 0),
    pages: Number(result.pages ?? 0),
    hasMore: Boolean(result.hasMore),
    jobs: Array.isArray(result.jobs) ? result.jobs.map(safeJob).filter(Boolean) : [],
    skippedReasons: Array.isArray(result.skippedReasons) ? [...result.skippedReasons] : [],
    failedReasons: Array.isArray(result.failedReasons) ? [...result.failedReasons] : [],
  }
}

export async function runReconcileSourcePolicy({ options, environment = process.env, runtime, loadRuntime = createConfiguredSourcePolicyReconciliationRuntime } = {}) {
  if (!options || options.help) return { ok: true, help: true }
  if (!options.dryRun && environment?.MONGODB_DATABASE !== options.confirmDatabase) throw new Error('confirm-database does not match the configured runtime database')
  try {
    const configured = runtime ?? await loadRuntime({ environment })
    if (!configured?.worker || typeof configured.worker.run !== 'function' || typeof configured.database !== 'string') throw new Error('source policy reconciliation runtime is invalid')
    if (!options.dryRun && configured.database !== options.confirmDatabase) throw new Error('confirm-database does not match the configured runtime database')
    const result = await configured.worker.run({ sourceId: options.sourceId, dryRun: options.dryRun, limit: options.limit, maxPages: options.maxPages })
    return { ok: result?.outcome !== 'failed', mode: options.dryRun ? 'dry-run' : 'execute', dryRun: options.dryRun, ...safeReport(result) }
  } finally {
    if (!runtime) await closeMongoConnection()
  }
}

function safeError(error) {
  const code = typeof error?.code === 'string' && /^[a-z0-9_:-]{1,128}$/i.test(error.code) ? error.code : null
  return { ok: false, error: 'source_policy_reconciliation_failed', code, type: error?.name ?? 'Error' }
}

export async function main(argv = process.argv.slice(2), { environment = process.env, log = console.log, errorLog = console.error } = {}) {
  try {
    const options = parseReconcileSourcePolicyArgs(argv)
    if (options.help) {
      log(RECONCILE_SOURCE_POLICY_USAGE)
      return { ok: true, help: true }
    }
    const result = await runReconcileSourcePolicy({ options, environment })
    log(JSON.stringify(result))
    if (!result.ok) process.exitCode = 1
    return result
  } catch (error) {
    errorLog(JSON.stringify(safeError(error)))
    process.exitCode = 1
    return null
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main()
