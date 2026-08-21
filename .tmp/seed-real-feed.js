import { ObjectId } from 'mongodb'
import { pathToFileURL } from 'node:url'
import {
  applyDemoDataset,
  buildDemoDataset,
  buildLiveSourceDocuments,
  createLiveConnectorRegistry,
  resolveDemoReviewerId,
} from '../scripts/seed-demo.js'
import { createConfiguredAuthService } from '../server/bootstrap/auth.js'
import { assertArticlesReady } from '../server/bootstrap/content.js'
import { createConfiguredIndexingRuntime } from '../server/bootstrap/indexing.js'
import { createConfiguredJobRuntime } from '../server/bootstrap/jobs.js'
import { createProductionJobRuntime } from '../server/maintenance/job-runtime.js'
import { createRateLimitAdmission } from '../server/security/rate-limit-admission.js'
import { closeMongoConnection } from '../server/repositories/mongo/connection.js'
import { buildIngestionArtifactJobs } from '../server/repositories/mongo/indexing-job-repository.js'
import { assertSourcesReady } from '../server/bootstrap/sources.js'
import { createConfiguredProviderAdapters, DEFAULT_CHAT_TIMEOUT_MS } from '../server/ai/provider-adapters.js'
import { createSourceAuditEvent } from '../server/audit/source-writer.js'

export const DEFAULT_MAX_ARTICLES = 30
export const MAX_ARTICLES = 50

function safeFailureReason(error) {
  return String(error?.message ?? '')
    .replace(/(?:mongodb(?:\+srv)?:\/\/|https?:\/\/)[^\s]+/gi, '[redacted-url]')
    .replace(/Bearer\s+[^\s]+/gi, 'Bearer [redacted]')
    .slice(0, 240)
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
    evidenceNote: `${source.evidenceNote} AI metadata scope was explicitly approved for this real-feed run.`,
  }
}

export function buildIndexingJobs({ source, article, now = new Date(), embeddingTarget } = {}) {
  return buildIngestionArtifactJobs({ source, article, now, embeddingTarget })
}

export function refreshAuditIdentities(audits, runId = new ObjectId().toHexString()) {
  if (!Array.isArray(audits) || typeof runId !== 'string' || runId.length < 8) throw new Error('audit refresh input is invalid')
  return audits.map((audit, index) => {
    const actor = { id: audit.actorId, role: audit.actorType === 'admin' ? 'admin' : 'system-worker' }
    const request = { serverRequestId: `seed:real-demo:${runId}:${index}` }
    const event = createSourceAuditEvent({
      actor,
      action: audit.action,
      targetId: audit.targetId,
      changedFields: audit.changedFields,
      reasonCode: audit.reasonCode,
      request,
      result: audit.result,
      stateTransition: audit.stateTransition,
      createdAt: audit.createdAt,
    })
    return { ...event, _id: new ObjectId() }
  })
}

function operatorEnvironment(environment) {
  const operatorEnv = environment.MONGODB_OPERATOR_URI_ENV
  if (typeof operatorEnv !== 'string' || operatorEnv === environment.MONGODB_URI_ENV || typeof environment[operatorEnv] !== 'string' || environment[operatorEnv].length === 0) throw new Error('a separate operator credential is required')
  return { ...environment, MONGODB_URI_ENV: operatorEnv }
}

function embeddingTarget(registry) {
  const policy = registry.workloadPolicies.find(({ workloadId }) => workloadId === 'embedding')
  const route = registry.routes.find(({ routeId }) => routeId === policy?.primaryRouteId)
  if (!route || !Number.isInteger(route.embeddingDimensions) || !Number.isInteger(route.embeddingVersion) || typeof route.artifactCompatibilityId !== 'string' || !route.artifactCompatibilityId) throw new Error('embedding route target is invalid')
  return { model: route.model, dimensions: route.embeddingDimensions, version: route.embeddingVersion, artifactCompatibilityId: route.artifactCompatibilityId }
}

async function countTask(context, task, statuses = ['queued']) {
  return context.db.collection('indexingJobs').countDocuments({ task, status: { $in: statuses } })
}

export async function runIndexingTask({ context, queue, task, maxRuns = 200, allowFailures = false } = {}) {
  if (!context?.db || !queue) throw new Error('indexing queue is required')
  const outcomes = []
  for (let run = 0; run < maxRuns; run += 1) {
    if ((await countTask(context, task, ['queued', 'running'])) === 0) break
    const now = new Date()
    const candidate = await queue.selectDue({ now })
    if (!candidate) throw new Error(`${task} job is not due`)
    outcomes.push(await queue.claimAndExecute({ candidate, now }))
  }
  if (await countTask(context, task, ['queued', 'running']) > 0) throw new Error(`${task} jobs did not settle within the run limit`)
  const failed = await context.db.collection('indexingJobs').countDocuments({ task, status: { $in: ['failed', 'partial', 'cancelled'] } })
  if (failed > 0 && !allowFailures) throw new Error(`${task} jobs failed`)
  return outcomes
}

async function createJobs({ repository, sources, articles, task, now, target }) {
  let created = 0
  for (const article of articles) {
    const source = sources.find(({ _id }) => String(_id) === String(article.sourceId))
    const job = buildIndexingJobs({ source, article, now, embeddingTarget: target }).find((candidate) => candidate.task === task)
    if (!job) continue
    await repository.createSystemIndexingJob({ job })
    created += 1
  }
  return created
}

async function main() {
  const mode = parseSeedArgs(process.argv.slice(2))
  let context
  let maintenanceContext
  let stage = 'startup'
  try {
    if (mode.apply && !mode.confirmAiPolicy) throw new Error('real feed apply requires --confirm-ai-policy')
    const environment = mode.apply ? operatorEnvironment(process.env) : process.env
    let reviewerId
    let runtime
    let auth
    if (mode.apply) {
      stage = 'authenticate_runtime'
      auth = await createConfiguredAuthService({ environment })
      context = auth.context
      runtime = auth.runtime
      stage = 'resolve_reviewer'
      reviewerId = await resolveDemoReviewerId({ context, environment })
      stage = 'check_migrations'
      await assertSourcesReady(context)
      await assertArticlesReady(context)
    }
    stage = 'fetch_connectors'
    const sources = buildLiveSourceDocuments({ reviewerId })
    const dataset = await buildDemoDataset({
      sources,
      connectorRegistry: createLiveConnectorRegistry(),
      retrievedAt: new Date(),
      maxArticles: mode.maxArticles,
      allowSourceFailures: false,
    })
    const aiDataset = {
      ...dataset,
      sources: dataset.sources.map(aiReadySource),
      audits: refreshAuditIdentities(dataset.audits),
    }
    if (!mode.apply) {
      console.log(JSON.stringify({ apply: false, sources: aiDataset.sources.length, articles: aiDataset.articles.length, diagnostics: aiDataset.diagnostics }))
      return
    }
    stage = 'write_dataset'
    const seeded = await applyDemoDataset({ context, dataset: aiDataset })
    stage = 'create_job_runtime'
    const rateLimitAdmission = createRateLimitAdmission({ repository: auth.authRepository, keyring: auth.quotaKeyring })
    const production = await createProductionJobRuntime({
      runtimeConfig: runtime,
      jobOptions: { context, rateLimitAdmission, quotaKeyring: auth.quotaKeyring, governanceKeyring: auth.governanceKeyring },
      createJobRuntime: createConfiguredJobRuntime,
      logError: () => {},
    })
    const jobs = production.jobs
    maintenanceContext = production.maintenanceContext
    if (!jobs.queueRegistry || typeof jobs.coordinatorRunner !== 'function') throw new Error('durable job runtime is unavailable')
    stage = 'create_provider_adapters'
    const adapters = createConfiguredProviderAdapters({ registry: runtime.providerRegistry, summaryTimeoutMs: DEFAULT_CHAT_TIMEOUT_MS })
    stage = 'create_indexing_runtime'
    const indexing = await createConfiguredIndexingRuntime({ context, jobRuntime: jobs, rateLimitAdmission, providerRegistry: runtime.providerRegistry, ...adapters })
    const queue = jobs.queueRegistry.get('indexing')
    const target = embeddingTarget(runtime.providerRegistry)
    const now = new Date()
    stage = 'create_summary_jobs'
    const summaryJobs = await createJobs({ repository: indexing.indexingJobRepository, sources: aiDataset.sources, articles: aiDataset.articles, task: 'summary', now, target })
    stage = 'run_summary_jobs'
    const summaryOutcomes = await runIndexingTask({ context, queue, task: 'summary', allowFailures: true })
    stage = 'verify_summary'
    const summaryReady = await context.db.collection('articles').countDocuments({ summaryStatus: 'ready' })
    const summaryFailed = await context.db.collection('articles').countDocuments({ summaryStatus: 'failed' })
    if (summaryReady + summaryFailed !== aiDataset.articles.length) throw new Error('summary jobs did not settle for every real article')
    const persistedArticles = await context.db.collection('articles').find({}).toArray()
    stage = 'create_embedding_jobs'
    const embeddingJobs = await createJobs({ repository: indexing.indexingJobRepository, sources: aiDataset.sources, articles: persistedArticles, task: 'embedding', now: new Date(), target })
    stage = 'run_embedding_jobs'
    const embeddingOutcomes = await runIndexingTask({ context, queue, task: 'embedding' })
    stage = 'verify_embedding'
    const embeddingReady = await context.db.collection('articles').countDocuments({ embeddingStatus: 'ready' })
    const embeddingFailed = await context.db.collection('articles').countDocuments({ embeddingStatus: 'failed' })
    const pending = await context.db.collection('indexingJobs').countDocuments({ status: { $in: ['queued', 'running'] } })
    const failed = await context.db.collection('indexingJobs').countDocuments({ status: { $in: ['failed', 'partial'] } })
    if (embeddingReady + embeddingFailed !== aiDataset.articles.length || pending > 0 || embeddingFailed > 0) throw new Error('embedding jobs did not settle successfully')
    console.log(JSON.stringify({ apply: true, seeded, sources: aiDataset.sources.length, articles: aiDataset.articles.length, diagnostics: aiDataset.diagnostics, summaryJobs, summaryProcessed: summaryOutcomes.length, summaryReady, summaryFailed, embeddingJobs, embeddingProcessed: embeddingOutcomes.length, embeddingReady, embeddingFailed, pendingJobs: pending, failedJobs: failed }))
  } catch (error) {
    const code = typeof error?.code === 'string' && /^[a-z0-9_:-]{1,128}$/i.test(error.code) ? error.code : 'connector_provider_or_database_error'
    console.error(JSON.stringify({ error: 'real_feed_seed_failed', stage, code, reason: safeFailureReason(error) }))
    process.exitCode = 1
  } finally {
    await maintenanceContext?.client?.close?.()
    await closeMongoConnection()
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main()
