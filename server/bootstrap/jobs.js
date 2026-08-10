import { createJobService } from '../application/jobs/service.js'
import { MongoJobRepository } from '../repositories/mongo/job-repository.js'
import { MongoLeaseRepository } from '../repositories/mongo/lease-repository.js'
import { MongoSourceRepository } from '../repositories/mongo/source-repository.js'
import { DURABLE_JOB_AUDIT_VALIDATOR, DURABLE_JOB_COLLECTIONS, DURABLE_JOB_INDEXES } from '../../scripts/migrations/durable-jobs.js'
import { createQueueRegistry } from '../jobs/queue-registry.js'
import { createIngestionQueueAdapter } from '../jobs/ingestion-queue.js'
import { runDueWork } from '../jobs/due-work-coordinator.js'
import { createMaintenanceRegistry } from '../maintenance/task-registry.js'
import { createMaintenanceRunner } from '../maintenance/runner.js'
import { exactMongoIndex } from '../repositories/mongo/index-contract.js'

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
  if (!audit || audit.options?.validationLevel !== 'strict' || audit.options?.validationAction !== 'error' || stableJson(audit.options?.validator) !== stableJson(DURABLE_JOB_AUDIT_VALIDATOR)) throw new Error('durable-jobs audit validator is not ready')
}

export async function createConfiguredJobService({ context, now, rateLimitAdmission, runDueWork } = {}) {
  if (typeof rateLimitAdmission?.reserve !== 'function') throw new Error('Rate-limit admission is required')
  await assertDurableJobsReady(context)
  const jobRepository = new MongoJobRepository(context)
  const leaseRepository = new MongoLeaseRepository(context)
  const sourceRepository = new MongoSourceRepository(context)
  return {
    jobService: createJobService({ jobRepository, sourceRepository, now, rateLimitAdmission, runDueWork }),
    jobRepository,
    leaseRepository,
  }
}

export function createCoordinatorRunner({ queueRegistry, now = () => new Date() } = {}) {
  if (!queueRegistry) throw new Error('Queue registry is required')
  return async () => runDueWork({ registry: queueRegistry, maxJobs: 3, maxRecoveries: 3, budgetMs: 8000, now })
}

export const DAILY_MATERIALIZATION_PAGE_LIMIT = 100
export const MAX_DAILY_MATERIALIZATION_PAGES = 10
export const DAILY_MATERIALIZATION_BUDGET_MS = 4_000

export function createCronDueWorkRunner({
  jobRepository,
  coordinatorRunner,
  now = () => new Date(),
  materializationPageLimit = DAILY_MATERIALIZATION_PAGE_LIMIT,
  maxMaterializationPages = MAX_DAILY_MATERIALIZATION_PAGES,
  materializationBudgetMs = DAILY_MATERIALIZATION_BUDGET_MS,
} = {}) {
  if (!jobRepository || typeof coordinatorRunner !== 'function') throw new Error('Cron job dependencies are required')
  if (!Number.isInteger(materializationPageLimit) || materializationPageLimit < 1 || materializationPageLimit > DAILY_MATERIALIZATION_PAGE_LIMIT) throw new Error('Daily materialization page limit is invalid')
  if (!Number.isInteger(maxMaterializationPages) || maxMaterializationPages < 1) throw new Error('Daily materialization page cap is invalid')
  if (!Number.isFinite(materializationBudgetMs) || materializationBudgetMs <= 0) throw new Error('Daily materialization budget is invalid')
  return async () => {
    const startedAt = now()
    if (!(startedAt instanceof Date) || Number.isNaN(startedAt.getTime())) throw new Error('Cron clock is invalid')
    const deadline = startedAt.getTime() + materializationBudgetMs
    let hasMore = true
    let pages = 0
    while (hasMore && pages < maxMaterializationPages) {
      const pageNow = now()
      if (!(pageNow instanceof Date) || Number.isNaN(pageNow.getTime())) throw new Error('Cron clock is invalid')
      if (pages > 0 && pageNow.getTime() >= deadline) break
      const result = await jobRepository.materializeDailyIngestion({ now: pageNow, limit: materializationPageLimit })
      pages += 1
      hasMore = result?.hasMore === true
      if (hasMore && now().getTime() >= deadline) break
    }
    return coordinatorRunner()
  }
}

export async function createConfiguredJobRuntime({ context, now = () => new Date(), executor, rateLimitAdmission } = {}) {
  if (typeof rateLimitAdmission?.reserve !== 'function') throw new Error('Rate-limit admission is required')
  const jobRepository = new MongoJobRepository(context)
  const leaseRepository = new MongoLeaseRepository(context)
  await assertDurableJobsReady(context)
  const queueRegistry = createQueueRegistry()
  queueRegistry.register(createIngestionQueueAdapter({ jobRepository, leaseRepository, executor }))
  const maintenanceRegistry = createMaintenanceRegistry()
  maintenanceRegistry.register('purge-ingestion-jobs', ({ cutoff, limit }) => jobRepository.purgeDueIngestionJobs({ cutoff, limit }))
  const maintenanceRunner = createMaintenanceRunner({ registry: maintenanceRegistry, now })
  const coordinatorRunner = createCoordinatorRunner({ queueRegistry, now })
  const dueWorkRunner = createCronDueWorkRunner({ jobRepository, coordinatorRunner, now })
  const configured = await createConfiguredJobService({ context, now, rateLimitAdmission, runDueWork: coordinatorRunner })
  return {
    ...configured,
    queueRegistry,
    maintenanceRegistry,
    maintenanceRunner,
    coordinatorRunner,
    dueWorkRunner,
  }
}
