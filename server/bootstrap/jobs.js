import { createJobService } from '../application/jobs/service.js'
import { MongoJobRepository } from '../repositories/mongo/job-repository.js'
import { MongoLeaseRepository } from '../repositories/mongo/lease-repository.js'
import { MongoSourceRepository } from '../repositories/mongo/source-repository.js'
import { DURABLE_JOB_AUDIT_VALIDATOR, DURABLE_JOB_COLLECTIONS, DURABLE_JOB_INDEXES } from '../../scripts/migrations/durable-jobs.js'
import { createQueueRegistry, QUEUE_ORDER } from '../jobs/queue-registry.js'
import { createIngestionQueueAdapter } from '../jobs/ingestion-queue.js'
import { createAccountDeletionQueueAdapter } from '../jobs/account-deletion-queue.js'
import { runDueWork } from '../jobs/due-work-coordinator.js'
import { createIndexingDrainRunner } from '../jobs/indexing-drain.js'
import { createMaintenanceRegistry } from '../maintenance/task-registry.js'
import { createMaintenanceRunner } from '../maintenance/runner.js'
import { exactMongoIndex } from '../repositories/mongo/index-contract.js'
import { INDEXING_JOB_AUDIT_VALIDATOR } from '../../scripts/migrations/indexing-jobs.js'
import { GOVERNANCE_AUDIT_VALIDATOR } from '../../scripts/migrations/governance-audit.js'
import { GOOGLE_OAUTH_AUDIT_VALIDATOR } from '../../scripts/migrations/google-oauth.js'
import { SOURCE_POLICY_RECONCILIATION_AUDIT_VALIDATOR } from '../../scripts/migrations/source-policy-reconciliation.js'
import { MongoTakedownRepository } from '../repositories/mongo/takedown-repository.js'
import { MongoAccountDeletionRepository } from '../repositories/mongo/account-deletion-repository.js'
import { MongoAdminRepository } from '../repositories/mongo/admin-repository.js'
import { assertGovernanceReady } from './governance-readiness.js'

const EMPTY_QUEUE_COUNTERS = Object.freeze({ claimed: 0, succeeded: 0, partial: 0, failed: 0, deferred: 0 })
const QUEUE_RESPONSE_KEY = Object.freeze({ ingestion: 'ingestion', indexing: 'indexing', 'account-deletion': 'accountDeletion' })

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`
  return JSON.stringify(value)
}

export async function assertDurableJobsReady(context) {
  if (!context?.db) throw new Error('Mongo context is required')
  const collections = await context.db.listCollections({}, { nameOnly: false }).toArray()
  const collectionMap = new Map(collections.map((collection) => [collection.name, collection]))
  for (const [name, definition] of Object.entries(DURABLE_JOB_COLLECTIONS)) {
    const collection = collectionMap.get(name)
    if (!collection || collection.options?.validationLevel !== 'strict' || collection.options?.validationAction !== 'error' || stableJson(collection.options?.validator) !== stableJson(definition.validator)) throw new Error('durable-jobs validator is not ready')
    const actualByName = new Map((await context.db.collection(name).indexes()).map((index) => [index.name, index]))
    if (DURABLE_JOB_INDEXES[name].some((expected) => !exactMongoIndex(actualByName.get(expected.name), expected))) throw new Error('durable-jobs indexes are not ready')
    if (name === 'jobLeases' && [...actualByName.values()].some((index) => index.expireAfterSeconds !== undefined)) throw new Error('durable-jobs indexes are not ready')
  }
  const audit = collectionMap.get('adminAuditLogs')
  if (!audit || audit.options?.validationLevel !== 'strict' || audit.options?.validationAction !== 'error' || ![DURABLE_JOB_AUDIT_VALIDATOR, INDEXING_JOB_AUDIT_VALIDATOR, GOVERNANCE_AUDIT_VALIDATOR, GOOGLE_OAUTH_AUDIT_VALIDATOR, SOURCE_POLICY_RECONCILIATION_AUDIT_VALIDATOR].some((validator) => stableJson(audit.options?.validator) === stableJson(validator))) throw new Error('durable-jobs audit validator is not ready')
}

export async function createConfiguredJobService({ context, now, rateLimitAdmission, runDueWork, runAdminDueWork, verifySchema = assertDurableJobsReady } = {}) {
  if (typeof rateLimitAdmission?.reserve !== 'function') throw new Error('Rate-limit admission is required')
  await verifySchema(context)
  const jobRepository = new MongoJobRepository(context)
  const leaseRepository = new MongoLeaseRepository(context)
  const sourceRepository = new MongoSourceRepository(context)
  return {
    jobService: createJobService({ jobRepository, sourceRepository, now, rateLimitAdmission, runDueWork, runAdminDueWork }),
    jobRepository,
    leaseRepository,
  }
}

export function createCoordinatorRunner({ queueRegistry, now = () => new Date(), maxJobs = 3, maxRecoveries = 3, budgetMs = 8000 } = {}) {
  if (!queueRegistry) throw new Error('Queue registry is required')
  return async (options = {}) => runDueWork({
    registry: queueRegistry,
    maxJobs: options.maxJobs ?? maxJobs,
    maxRecoveries: options.maxRecoveries ?? maxRecoveries,
    budgetMs: options.budgetMs ?? budgetMs,
    now,
  })
}

const ADMIN_TASK_PROFILES = Object.freeze([
  Object.freeze({ task: 'summary', maxClaims: 12, budgetMs: 150_000 }),
  Object.freeze({ task: 'embedding', maxClaims: 8, budgetMs: 150_000 }),
  Object.freeze({ task: 'visibility-reconcile', maxClaims: 4, budgetMs: 30_000 }),
])
const CRON_TASK_PROFILES = Object.freeze([
  Object.freeze({ task: 'summary', maxClaims: 100, budgetMs: 240_000 }),
  Object.freeze({ task: 'embedding', maxClaims: 80, budgetMs: 240_000 }),
  Object.freeze({ task: 'visibility-reconcile', maxClaims: 20, budgetMs: 60_000 }),
])
export const ADMIN_DUE_WORK_PROFILE = Object.freeze({ maxJobs: 24, budgetMs: 150_000, taskProfiles: ADMIN_TASK_PROFILES })
export const CRON_DUE_WORK_PROFILE = Object.freeze({ maxJobs: 200, budgetMs: 240_000, taskProfiles: CRON_TASK_PROFILES })

function queueAttempts(queues = {}) {
  return Object.values(queues).reduce((total, counters = {}) => total
    + ['succeeded', 'partial', 'failed', 'deferred'].reduce((sum, key) => sum + Math.max(0, Number(counters[key] ?? 0)), 0), 0)
}

function mergeCounters(left = {}, right = {}) {
  return Object.fromEntries(['claimed', 'succeeded', 'partial', 'failed', 'deferred']
    .map((key) => [key, Math.max(0, Number(left[key] ?? 0)) + Math.max(0, Number(right[key] ?? 0))]))
}

function emptyTaskCounters() {
  return Object.fromEntries(['summary', 'embedding', 'visibility-reconcile'].map((task) => [task, mergeCounters()]))
}

function validTaskProfiles(profile) {
  const taskProfiles = profile?.taskProfiles
  if (taskProfiles === undefined) return true
  if (!Array.isArray(taskProfiles) || taskProfiles.length === 0 || new Set(taskProfiles.map(({ task }) => task)).size !== taskProfiles.length) return false
  return taskProfiles.every(({ task, maxClaims, budgetMs }) => ['summary', 'embedding', 'visibility-reconcile'].includes(task)
    && Number.isInteger(maxClaims) && maxClaims >= 0
    && Number.isFinite(budgetMs) && budgetMs > 0 && budgetMs <= profile.budgetMs)
}

function allocateTaskClaims(taskProfiles, remainingClaims) {
  let available = remainingClaims
  return taskProfiles.map((taskProfile) => {
    const maxClaims = Math.min(taskProfile.maxClaims, available)
    available -= maxClaims
    return { ...taskProfile, maxClaims }
  })
}

async function nextAvailableAt(queueRegistry, now) {
  const values = await Promise.all(queueRegistry.registered().map((adapter) => adapter.nextAvailableAt({ now })))
  const dates = values.filter(Boolean).map((value) => value instanceof Date ? value : new Date(value)).filter((value) => !Number.isNaN(value.getTime()))
  return dates.length > 0 ? new Date(Math.min(...dates.map((value) => value.getTime()))) : null
}

export function createProfiledIndexingDrainRunner({ queueRegistry, profile, now = () => new Date() } = {}) {
  if (!queueRegistry || !profile || !Number.isInteger(profile.maxJobs) || profile.maxJobs < 3 || !Number.isFinite(profile.budgetMs) || profile.budgetMs <= 0 || !validTaskProfiles(profile)) throw new Error('Indexing drain profile is invalid')
  return async (baseResult, options = {}) => {
    if (!baseResult?.startedAt || !baseResult?.queues) throw new Error('Due-work base result is required')
    const queue = queueRegistry.get('indexing')
    const remainingClaims = Math.max(0, profile.maxJobs - queueAttempts(baseResult.queues))
    const taskCounters = emptyTaskCounters()
    if (!queue || remainingClaims === 0) return { ...baseResult, taskCounters, finishedAt: now(), nextAvailableAt: await nextAvailableAt(queueRegistry, now()) }
    const drainStartedAt = now()
    if (!(drainStartedAt instanceof Date) || Number.isNaN(drainStartedAt.getTime())) throw new Error('Due-work drain clock is invalid')
    const allocations = profile.taskProfiles
      ? allocateTaskClaims(profile.taskProfiles, remainingClaims).filter(({ maxClaims }) => maxClaims > 0)
      : [{ maxClaims: remainingClaims, budgetMs: profile.budgetMs }]
    const baseStartedAt = baseResult.startedAt instanceof Date ? baseResult.startedAt : new Date(baseResult.startedAt)
    const effectiveDeadline = options.deadline instanceof Date
      ? options.deadline
      : new Date(baseStartedAt.getTime() + profile.budgetMs)
    const settled = await Promise.allSettled(allocations.map(({ task, maxClaims, budgetMs }) => createIndexingDrainRunner({
      queue,
      ...(task ? { tasks: [task] } : {}),
      maxClaims,
      deadline: new Date(Math.min(drainStartedAt.getTime() + budgetMs, effectiveDeadline.getTime())),
      now,
    })()))
    const firstFailure = settled.find(({ status }) => status === 'rejected')
    if (firstFailure) throw firstFailure.reason
    const drains = settled.map(({ value }) => value)
    for (const drain of drains) {
      for (const [task, counters] of Object.entries(drain.taskCounters)) taskCounters[task] = mergeCounters(taskCounters[task], counters)
    }
    const drainCounters = drains.reduce((counters, drain) => mergeCounters(counters, drain.counters), mergeCounters())
    return {
      ...baseResult,
      finishedAt: now(),
      taskCounters,
      queues: {
        ...baseResult.queues,
        indexing: mergeCounters(baseResult.queues.indexing, drainCounters),
      },
      nextAvailableAt: await nextAvailableAt(queueRegistry, now()),
    }
  }
}

export const DAILY_MATERIALIZATION_PAGE_LIMIT = 100
export const MAX_DAILY_MATERIALIZATION_PAGES = 10
export const DAILY_MATERIALIZATION_BUDGET_MS = 4_000

export function createCronDueWorkRunner({
  jobRepository,
  coordinatorRunner,
  indexingDrainRunner,
  now = () => new Date(),
  materializationPageLimit = DAILY_MATERIALIZATION_PAGE_LIMIT,
  maxMaterializationPages = MAX_DAILY_MATERIALIZATION_PAGES,
  materializationBudgetMs = DAILY_MATERIALIZATION_BUDGET_MS,
  materializers = [],
} = {}) {
  if (!jobRepository || typeof coordinatorRunner !== 'function' || indexingDrainRunner !== undefined && typeof indexingDrainRunner !== 'function') throw new Error('Cron job dependencies are required')
  if (!Number.isInteger(materializationPageLimit) || materializationPageLimit < 1 || materializationPageLimit > DAILY_MATERIALIZATION_PAGE_LIMIT) throw new Error('Daily materialization page limit is invalid')
  if (!Number.isInteger(maxMaterializationPages) || maxMaterializationPages < 1) throw new Error('Daily materialization page cap is invalid')
  if (!Number.isFinite(materializationBudgetMs) || materializationBudgetMs <= 0) throw new Error('Daily materialization budget is invalid')
  if (!Array.isArray(materializers) || materializers.some((materializer) => typeof materializer !== 'function')) throw new Error('Cron materializers are invalid')
  return async () => {
    const startedAt = now()
    if (!(startedAt instanceof Date) || Number.isNaN(startedAt.getTime())) throw new Error('Cron clock is invalid')
    const globalDeadline = new Date(startedAt.getTime() + CRON_DUE_WORK_PROFILE.budgetMs)
    const materializationDeadline = startedAt.getTime() + materializationBudgetMs
    for (const materializer of materializers) {
      if (now().getTime() >= globalDeadline.getTime()) break
      await materializer()
    }
    let hasMore = true
    let pages = 0
    while (hasMore && pages < maxMaterializationPages) {
      const pageNow = now()
      if (!(pageNow instanceof Date) || Number.isNaN(pageNow.getTime())) throw new Error('Cron clock is invalid')
      if (pageNow.getTime() >= globalDeadline.getTime()) break
      if (pages > 0 && pageNow.getTime() >= materializationDeadline) break
      const result = await jobRepository.materializeDailyIngestion({ now: pageNow, limit: materializationPageLimit })
      pages += 1
      hasMore = result?.hasMore === true
      if (now().getTime() >= globalDeadline.getTime()) break
      if (hasMore && now().getTime() >= materializationDeadline) break
    }
    const remainingBudgetMs = globalDeadline.getTime() - now().getTime()
    if (remainingBudgetMs < 1000) {
      return {
        runId: 'cron-overdue-skip',
        startedAt,
        finishedAt: now(),
        recovery: { inspected: 0, recovered: 0, retriesCreated: 0, failed: 0 },
        queues: Object.fromEntries(QUEUE_ORDER.map((name) => [QUEUE_RESPONSE_KEY[name], { ...EMPTY_QUEUE_COUNTERS }])),
        nextAvailableAt: null,
      }
    }
    const coordinated = await coordinatorRunner({
      maxJobs: CRON_DUE_WORK_PROFILE.maxJobs,
      budgetMs: remainingBudgetMs,
    })
    if (now().getTime() >= globalDeadline.getTime() || typeof indexingDrainRunner !== 'function') {
      return coordinated
    }
    return indexingDrainRunner(coordinated, { deadline: globalDeadline, startedAt })
  }
}

export async function createConfiguredJobRuntime({ context, now = () => new Date(), executor, rateLimitAdmission, quotaKeyring, governanceKeyring, governanceDb, maintenanceContext, verifyJobsSchema = assertDurableJobsReady, verifyGovernanceSchema = assertGovernanceReady } = {}) {
  if (typeof rateLimitAdmission?.reserve !== 'function') throw new Error('Rate-limit admission is required')
  if (!quotaKeyring?.versions?.length || typeof quotaKeyring.digest !== 'function' || !governanceKeyring?.versions?.length || typeof governanceKeyring.digest !== 'function') throw new Error('Quota and governance keyrings are required')
  const jobRepository = new MongoJobRepository(context)
  const leaseRepository = new MongoLeaseRepository(context)
  await verifyJobsSchema(context)
  const deletionGovernanceDb = governanceDb ?? context.client?.db?.('techpulse_governance')
  if (!deletionGovernanceDb) throw new Error('Account deletion quota and governance capabilities are required')
  // Validate every governance collection/index before registering any queue or
  // maintenance handler. A partial migration must not expose a half-started
  // runtime to callers.
  await verifyGovernanceSchema(context, { governanceDb: deletionGovernanceDb })
  const queueRegistry = createQueueRegistry()
  queueRegistry.register(createIngestionQueueAdapter({ jobRepository, leaseRepository, executor }))
  const maintenanceRegistry = createMaintenanceRegistry()
  const cronMaterializers = []
  maintenanceRegistry.register('purge-ingestion-jobs', ({ cutoff, limit }) => jobRepository.purgeDueIngestionJobs({ cutoff, limit }))
  const takedownRepository = context.db?.collection ? new MongoTakedownRepository({ ...context, governanceDb: deletionGovernanceDb, governanceKeyring }) : null
  const accountDeletionRepository = context.db?.collection ? new MongoAccountDeletionRepository({ ...context, quotaKeyring, governanceKeyring, governanceDb: deletionGovernanceDb }) : null
  if (accountDeletionRepository && typeof accountDeletionRepository.selectDue === 'function') queueRegistry.register(createAccountDeletionQueueAdapter({ repository: accountDeletionRepository }))
  if (maintenanceContext?.client && maintenanceContext.client === context.client) throw new Error('MongoDB maintenance client must be separate from runtime client')
  const adminAuditRepository = maintenanceContext?.db?.collection && maintenanceContext?.client ? new MongoAdminRepository(maintenanceContext) : null
  if (takedownRepository) {
    maintenanceRegistry.register('purge-takedown-pii', ({ cutoff, limit }) => takedownRepository.purgePii({ cutoff, limit }))
    maintenanceRegistry.register('purge-takedown-workflows', ({ cutoff, limit }) => takedownRepository.purgeWorkflows({ cutoff, limit }))
    cronMaterializers.push(() => takedownRepository.materializeCleanupBatch({ now: now(), limit: DAILY_MATERIALIZATION_PAGE_LIMIT }))
  }
  if (accountDeletionRepository) maintenanceRegistry.register('purge-account-deletion-workflows', ({ cutoff, limit }) => accountDeletionRepository.purge({ cutoff, limit }))
  if (adminAuditRepository) maintenanceRegistry.register('purge-audit-ip-hmac', ({ cutoff, limit }) => adminAuditRepository.purgeAuditIpHmac({ cutoff, limit }))
  const maintenanceRunner = createMaintenanceRunner({ registry: maintenanceRegistry, now })
  const coordinatorRunner = createCoordinatorRunner({ queueRegistry, now })
  const adminIndexingDrainRunner = createProfiledIndexingDrainRunner({ queueRegistry, profile: ADMIN_DUE_WORK_PROFILE, now })
  const cronIndexingDrainRunner = createProfiledIndexingDrainRunner({ queueRegistry, profile: CRON_DUE_WORK_PROFILE, now })
  const adminDueWorkRunner = async () => adminIndexingDrainRunner(await coordinatorRunner({ maxJobs: ADMIN_DUE_WORK_PROFILE.maxJobs, budgetMs: ADMIN_DUE_WORK_PROFILE.budgetMs }))
  const dueWorkRunner = createCronDueWorkRunner({
    jobRepository,
    coordinatorRunner: async (options = {}) => coordinatorRunner({ maxJobs: CRON_DUE_WORK_PROFILE.maxJobs, budgetMs: CRON_DUE_WORK_PROFILE.budgetMs, ...options }),
    indexingDrainRunner: cronIndexingDrainRunner,
    now,
    materializers: cronMaterializers,
  })
  const configured = await createConfiguredJobService({ context, now, rateLimitAdmission, runDueWork: coordinatorRunner, runAdminDueWork: adminDueWorkRunner, verifySchema: verifyJobsSchema })
  return {
    ...configured,
    queueRegistry,
    maintenanceRegistry,
    maintenanceRunner,
    coordinatorRunner,
    adminDueWorkRunner,
    dueWorkRunner,
    cronMaterializers,
    maintenanceContext: adminAuditRepository ? maintenanceContext : null,
  }
}
