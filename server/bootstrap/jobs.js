import { randomUUID } from 'node:crypto'
import { createJobService } from '../application/jobs/service.js'
import { MongoJobRepository } from '../repositories/mongo/job-repository.js'
import { MongoLeaseRepository } from '../repositories/mongo/lease-repository.js'
import { MongoSourceRepository } from '../repositories/mongo/source-repository.js'
import { DURABLE_JOB_AUDIT_VALIDATOR, DURABLE_JOB_COLLECTIONS, DURABLE_JOB_INDEXES } from '../../scripts/migrations/durable-jobs.js'
import { CRON_OBSERVABILITY_COLLECTIONS, CRON_OBSERVABILITY_INDEXES } from '../../scripts/migrations/cron-observability.js'
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
import { PASSWORD_CHANGE_AUDIT_VALIDATOR } from '../../scripts/migrations/password-change.js'
import { MongoTakedownRepository } from '../repositories/mongo/takedown-repository.js'
import { MongoAccountDeletionRepository } from '../repositories/mongo/account-deletion-repository.js'
import { MongoAdminRepository } from '../repositories/mongo/admin-repository.js'
import { MongoCronEventRepository } from '../repositories/mongo/cron-event-repository.js'
import { assertGovernanceReady } from './governance-readiness.js'
import { runtimeFailure, settleBeforeDeadline, settleWithinGrace } from '../jobs/runtime-bounds.js'
import { flushRuntimeTrace, MATERIALIZER_PHASE_STAGES, safeEvent, startRuntimePhase } from '../jobs/runtime-trace.js'

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
  if (!audit || audit.options?.validationLevel !== 'strict' || audit.options?.validationAction !== 'error' || ![DURABLE_JOB_AUDIT_VALIDATOR, INDEXING_JOB_AUDIT_VALIDATOR, GOVERNANCE_AUDIT_VALIDATOR, GOOGLE_OAUTH_AUDIT_VALIDATOR, SOURCE_POLICY_RECONCILIATION_AUDIT_VALIDATOR, PASSWORD_CHANGE_AUDIT_VALIDATOR].some((validator) => stableJson(audit.options?.validator) === stableJson(validator))) throw new Error('durable-jobs audit validator is not ready')
}

export async function assertCronObservabilityReady(context) {
  if (!context?.db) throw new Error('Mongo context is required')
  const collections = await context.db.listCollections({}, { nameOnly: false }).toArray()
  const collectionMap = new Map(collections.map((collection) => [collection.name, collection]))
  for (const [name, definition] of Object.entries(CRON_OBSERVABILITY_COLLECTIONS)) {
    const collection = collectionMap.get(name)
    if (!collection || collection.options?.validationLevel !== 'strict' || collection.options?.validationAction !== 'error' || stableJson(collection.options?.validator) !== stableJson(definition.validator)) throw new Error('cron-observability validator is not ready')
    const actualByName = new Map((await context.db.collection(name).indexes()).map((index) => [index.name, index]))
    if (CRON_OBSERVABILITY_INDEXES[name].some((expected) => !exactMongoIndex(actualByName.get(expected.name), expected))) throw new Error('cron-observability indexes are not ready')
  }
}

export async function createConfiguredJobService({ context, now, rateLimitAdmission, runDueWork, runAdminDueWork, trace, verifySchema = assertDurableJobsReady } = {}) {
  if (typeof rateLimitAdmission?.reserve !== 'function') throw new Error('Rate-limit admission is required')
  await verifySchema(context)
  const jobRepository = new MongoJobRepository(context)
  const leaseRepository = new MongoLeaseRepository(context)
  const sourceRepository = new MongoSourceRepository(context)
  return {
    jobService: createJobService({ jobRepository, sourceRepository, now, rateLimitAdmission, runDueWork, runAdminDueWork, trace }),
    jobRepository,
    leaseRepository,
  }
}
export function createCoordinatorRunner({ queueRegistry, now = () => new Date(), maxJobs = 3, maxRecoveries = 3, budgetMs = 8000, runIdFactory = randomUUID, trace } = {}) {
  if (!queueRegistry) throw new Error('Queue registry is required')
  return async (options = {}) => {
    const targetTrace = options.trace ?? trace
    return runDueWork({
      registry: queueRegistry,
      maxJobs: options.maxJobs ?? maxJobs,
      maxRecoveries: options.maxRecoveries ?? maxRecoveries,
      budgetMs: options.budgetMs ?? budgetMs,
      now,
      runId: options.runId ?? runIdFactory(),
      deadline: options.deadline,
      signal: options.signal,
      trace: targetTrace,
    })
  }
}
export function createFlushedCoordinatorRunner({ coordinatorRunner, trace, maxWaitMs = 1_000 } = {}) {
  if (typeof coordinatorRunner !== 'function') throw new Error('Coordinator runner is required')
  return async (options = {}) => {
    try {
      return await coordinatorRunner(options)
    } finally {
      await flushRuntimeTrace(trace, { ...(options.deadline ? { deadline: options.deadline } : {}), maxWaitMs })
    }
  }
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
// Minimum budget the coordinator reserves for the indexing drain inside a cron run,
// so a run whose budget is consumed by ingestion cannot starve summary/embedding.
export const CRON_INDEXING_DRAIN_RESERVE_MS = 70_000
// Recovery allowance for a once-daily cron invocation. The previous default of 3
// left kill-after-claim leases healing at most three jobs/day across all queues,
// which is far below a daily backlog; the coordinator drains the recoverable set
// inside its reserved slice regardless of this cap.
export const CRON_RECOVERY_LIMIT = 200
// Floor on the coordinator's work budget when the reserve is deducted. The
// coordinator never receives less than 1,000 ms, so a tight remaining budget
// still reserves the rest for the indexing drain instead of starving it.
const COORDINATOR_MIN_BUDGET_MS = 1_000
export const INGESTION_EXECUTION_TIMEOUT_MS = 60_000
export const INGESTION_FINALIZATION_GRACE_MS = 5_000
// Upper bound on how long a cron phase waits for a timed-out operation to settle
// after its abort signal has fired, so a non-cooperative operation cannot stall
// the run past its absolute deadline.
const CRON_LATE_SETTLEMENT_GRACE_MS = 1_000

function queueAttempts(queues = {}) {
  return Object.values(queues).reduce((total, counters = {}) => total
    + ['succeeded', 'partial', 'failed', 'deferred'].reduce((sum, key) => sum + Math.max(0, Number(counters[key] ?? 0)), 0), 0)
}

function mergeCounters(left = {}, right = {}) {
  return Object.fromEntries(['claimed', 'succeeded', 'partial', 'failed', 'deferred']
    .map((key) => [key, Math.max(0, Number(left[key] ?? 0)) + Math.max(0, Number(right[key] ?? 0))]))
}
function indexingDrainStatus(counters = {}) {
  const failed = Math.max(0, Number(counters.failed ?? 0))
  const partial = Math.max(0, Number(counters.partial ?? 0))
  const deferred = Math.max(0, Number(counters.deferred ?? 0))
  const succeeded = Math.max(0, Number(counters.succeeded ?? 0))
  if (failed > 0 && partial === 0 && deferred === 0 && succeeded === 0) return 'failed'
  if (deferred > 0 && failed === 0 && partial === 0 && succeeded === 0) return 'deferred'
  if (failed > 0 || partial > 0 || deferred > 0) return 'partial'
  return 'succeeded'
}
const CONTROL_PHASE_RESULT = Symbol('cron-control-phase')

async function runTracedPhase({ trace, stage, now, context, execute, signal, successDetails = () => ({}) }) {
  const phase = startRuntimePhase({ trace, stage, now, context })
  try {
    const result = await execute()
    phase.succeed(successDetails(result))
    return result
  } catch (error) {
    if (isCronControlError(error, signal)) {
      phase.timeout(error, { counters: { deferred: 1 } })
      return { [CONTROL_PHASE_RESULT]: true, error }
    }
    phase.fail(error)
    throw error
  }
}
async function runCronOperation({ operation, deadline, settlementDeadline, now, signal }) {
  const current = now()
  if (!(current instanceof Date) || Number.isNaN(current.getTime())) throw new Error('Cron clock is invalid')
  const remainingMs = Math.max(0, deadline.getTime() - current.getTime())
  if (remainingMs <= 0) throw runtimeFailure('runtime_error', 'Cron operation deadline was exceeded')
  const timeoutController = new globalThis.AbortController()
  let operationSignal = timeoutController.signal
  let removeParentAbort
  if (signal) {
    if (typeof globalThis.AbortSignal?.any === 'function') {
      operationSignal = globalThis.AbortSignal.any([signal, timeoutController.signal])
    } else {
      const forwardAbort = () => timeoutController.abort(signal.reason)
      if (signal.aborted) forwardAbort()
      else {
        signal.addEventListener('abort', forwardAbort, { once: true })
        removeParentAbort = () => signal.removeEventListener('abort', forwardAbort)
      }
    }
  }
  const operationPromise = Promise.resolve().then(() => {
    operationSignal.throwIfAborted?.()
    return operation({ signal: operationSignal, deadline, ...(settlementDeadline !== undefined ? { settlementDeadline } : {}) })
  })
  const settled = await settleBeforeDeadline(
    operationPromise,
    remainingMs,
    {
      timeoutError: () => runtimeFailure('runtime_error', 'Cron operation deadline was exceeded'),
      onTimeout: (error) => timeoutController.abort(error),
    },
  )
  try {
    if (settled.kind === 'deadline') {
      // Bound the late-settlement wait: a non-cooperative operation that ignores
      // the abort signal must not stall the cron run past its deadline. The
      // parent stays fail-closed regardless of how the operation settles.
      await settleWithinGrace(operationPromise, CRON_LATE_SETTLEMENT_GRACE_MS)
      throw settled.error
    }
    if (!settled.settled) throw settled.error
    return settled.value
  } finally {
    removeParentAbort?.()
  }
}
function isCronControlError(error, signal) {
  const code = typeof error?.code === 'string' ? error.code : ''
  return Boolean(signal?.aborted || error && (
    error.name === 'AbortError'
    || code === 'aborted'
    || code === 'runtime_deadline_exceeded'
    || code === 'runtime_cleanup_unresolved'
    || code.endsWith('_deadline_exceeded')
    || code.endsWith('_finalization_unresolved')
    || isMaterializationDeadlineError(error)
  ))
}

function isMaterializationDeadlineError(error) {
  return Boolean(
    error
    && typeof error === 'object'
    && error.code === 'runtime_error'
    && (error.message === 'Cron operation deadline was exceeded' || /deadline.*exceeded/i.test(String(error.message ?? ''))),
  )
}

const MATERIALIZER_STAGE_BY_NAME = Object.freeze({
  'source-policy-reconciliation': MATERIALIZER_PHASE_STAGES[2],
  'takedown-cleanup': MATERIALIZER_PHASE_STAGES[1],
  'cron-lifecycle-retention': MATERIALIZER_PHASE_STAGES[3],
})

function materializerStage(name) {
  if (Object.hasOwn(MATERIALIZER_STAGE_BY_NAME, name)) return MATERIALIZER_STAGE_BY_NAME[name]
  const suffix = String(name ?? 'unknown').toLowerCase().replace(/[^a-z0-9._:-]+/g, '-').slice(0, 96) || 'unknown'
  return `${MATERIALIZER_PHASE_STAGES[0]}:${suffix}`
}

function materializationTraceCounters(result = {}, additional = {}) {
  const counters = { ...additional }
  for (const key of ['inspected', 'created', 'updated', 'failed', 'deferred']) {
    if (Number.isSafeInteger(result[key]) && result[key] >= 0) counters[key] = result[key]
  }
  if (Number.isSafeInteger(result.affected) && result.affected >= 0) counters.updated = result.affected
  if (result.hasMore === true) counters.deferred = Math.max(1, Number(counters.deferred ?? 0))
  return counters
}
const MATERIALIZATION_REASONS = new Set(['materialized', 'already_materialized', 'no_eligible_sources', 'deferred', 'failed'])
const MATERIALIZATION_OUTCOMES = new Set(['completed', 'deferred', 'failed'])

function materializationPeriod(value) {
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? null : date.toISOString().slice(0, 10)
}

function materializationSummary(input = {}, fallback = {}) {
  const value = input && typeof input === 'object' ? input : {}
  const period = typeof value.period === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value.period)
    ? value.period
    : (typeof fallback.period === 'string' ? fallback.period : null)
  const reason = MATERIALIZATION_REASONS.has(value.materializationReason) ? value.materializationReason : (fallback.materializationReason ?? 'materialized')
  const outcome = MATERIALIZATION_OUTCOMES.has(value.outcome) ? value.outcome : (fallback.outcome ?? 'completed')
  const alreadyMaterialized = typeof value.alreadyMaterialized === 'boolean' ? value.alreadyMaterialized : Boolean(fallback.alreadyMaterialized)
  const completedAt = value.completedAt instanceof Date
    ? value.completedAt.toISOString()
    : (typeof value.completedAt === 'string' ? value.completedAt : (value.completedAt === null ? null : (fallback.completedAt ?? null)))
  const eligibleSourceCount = Number.isSafeInteger(value.eligibleSourceCount) && value.eligibleSourceCount >= 0
    ? value.eligibleSourceCount
    : (Number.isSafeInteger(fallback.eligibleSourceCount) && fallback.eligibleSourceCount >= 0 ? fallback.eligibleSourceCount : null)
  const counter = (key) => Number.isSafeInteger(value[key]) && value[key] >= 0 ? value[key] : (Number.isSafeInteger(fallback[key]) && fallback[key] >= 0 ? fallback[key] : 0)
  return Object.freeze({
    period,
    periodTimezone: 'UTC',
    materializationReason: alreadyMaterialized ? 'already_materialized' : reason,
    outcome,
    alreadyMaterialized,
    completedAt,
    eligibleSourceCount,
    inspected: counter('inspected'),
    created: counter('created'),
    updated: counter('updated'),
  })
}

function deferredMaterializationSummary(period, counters = {}) {
  return materializationSummary({ period, materializationReason: 'deferred', outcome: 'deferred', alreadyMaterialized: false, completedAt: null, eligibleSourceCount: null, ...counters })
}

function failedMaterializationSummary(period, counters = {}) {
  return materializationSummary({ period, materializationReason: 'failed', outcome: 'failed', alreadyMaterialized: false, completedAt: null, eligibleSourceCount: null, ...counters })
}

function materializationTraceDetails(summary) {
  return summary ? {
    period: summary.period,
    periodTimezone: summary.periodTimezone,
    materializationReason: summary.materializationReason,
    outcome: summary.outcome,
    alreadyMaterialized: summary.alreadyMaterialized,
    completedAt: summary.completedAt,
    eligibleSourceCount: summary.eligibleSourceCount,
  } : {}
}

function addMaterializationTraceCounters(target, result = {}) {
  for (const key of ['inspected', 'created']) {
    if (Number.isSafeInteger(result[key]) && result[key] >= 0) target[key] = Number(target[key] ?? 0) + result[key]
  }
  return target
}

async function runTracedMaterializerOperation({ trace, stage, now, context, execute, signal, requiresCompleteMaterialization = false } = {}) {
  const phase = startRuntimePhase({ trace, stage, now, context })
  try {
    const result = await execute()
    signal?.throwIfAborted?.()
    if (requiresCompleteMaterialization && result?.hasMore === true) throw runtimeFailure('runtime_deadline_exceeded', 'Cron materializer deferred before completion')
    phase.succeed({ counters: materializationTraceCounters(result) })
    return result
  } catch (error) {
    const control = isCronControlError(error, signal)
    const counters = materializationTraceCounters(undefined, { [control ? 'deferred' : 'failed']: 1 })
    if (control) phase.timeout(error, { counters })
    else phase.fail(error, { counters })
    throw error
  }
}

async function runDailyMaterializationOperation({ trace, now, context, execute, signal, deadline, settlementDeadline, pageLimit, maxPages } = {}) {
  const period = materializationPeriod(now())
  const phase = startRuntimePhase({ trace, stage: MATERIALIZER_PHASE_STAGES[0], now, context: { ...context, ...(period ? { period, periodTimezone: 'UTC' } : {}) } })
  const totals = {}
  let summary = null
  let pages = 0
  let hasMore = true
  try {
    while (hasMore && pages < maxPages) {
      signal?.throwIfAborted?.()
      const pageNow = now()
      if (!(pageNow instanceof Date) || Number.isNaN(pageNow.getTime())) throw new Error('Cron clock is invalid')
      const result = await execute({ pageNow, pageLimit, deadline, settlementDeadline, signal })
      signal?.throwIfAborted?.()
      addMaterializationTraceCounters(totals, result)
      totals.updated = Number(totals.updated ?? 0) + (Number.isSafeInteger(result?.updated) && result.updated >= 0 ? result.updated : 1)
      pages += 1
      const pageSummary = result && typeof result === 'object' && !Array.isArray(result) ? result : {}
      summary = materializationSummary({ ...pageSummary, inspected: totals.inspected, created: totals.created, updated: totals.updated }, { period: materializationPeriod(result?.period) ?? period, ...totals })
      hasMore = result?.hasMore === true
    }
    const completedSummary = materializationSummary(summary, { period, ...totals })
    phase.succeed({ counters: materializationTraceCounters(completedSummary, { updated: completedSummary.updated }), ...materializationTraceDetails(completedSummary) })
    return { pages, completed: true, materialization: completedSummary }
  } catch (error) {
    const control = isCronControlError(error, signal)
    const terminalSummary = control
      ? deferredMaterializationSummary(period, totals)
      : failedMaterializationSummary(period, totals)
    phase[control ? 'timeout' : 'fail'](error, { counters: materializationTraceCounters(totals, { [control ? 'deferred' : 'failed']: 1, updated: Number(totals.updated ?? 0) }), ...materializationTraceDetails(terminalSummary) })
    throw error
  }
}

async function runCronMaterializationPhase({
  trace,
  now,
  context,
  overallDeadline,
  deadline,
  settlementDeadline,
  signal,
  materializers = [],
  jobRepository,
  pageLimit,
  maxPages,
}) {
  const phase = startRuntimePhase({ trace, stage: 'cron.materialization', now, context })
  let pages = 0
  let materialization
  try {
    const daily = await runDailyMaterializationOperation({
      trace,
      now,
      context,
      deadline,
      settlementDeadline,
      signal,
      pageLimit,
      maxPages,
      execute: ({ pageNow, pageLimit: limit, deadline: operationDeadline, settlementDeadline: operationSettlementDeadline, signal: operationSignal }) => runCronOperation({
        operation: (options) => jobRepository.materializeDailyIngestion({ now: pageNow, limit, ...options }),
        deadline: operationDeadline,
        settlementDeadline: operationSettlementDeadline,
        now,
        signal: operationSignal,
      }),
    })
    pages = daily.pages
    materialization = daily.materialization
    for (const materializer of materializers) {
      signal?.throwIfAborted?.()
      if (now().getTime() >= overallDeadline.getTime()) break
      await runTracedMaterializerOperation({
        trace,
        stage: materializerStage(materializer.name),
        now,
        context,
        signal,
        requiresCompleteMaterialization: materializer.requiresCompleteMaterialization === true,
        execute: () => runCronOperation({
          operation: (options) => materializer.run({ ...options, deadline }),
          deadline,
          settlementDeadline,
          now,
          signal,
        }),
      })
    }
    phase.succeed({ counters: { updated: pages }, ...materializationTraceDetails(materialization) })
    return { pages, completed: true, materialization }
  } catch (error) {
    const terminalSummary = materialization ?? (isCronControlError(error, signal)
      ? deferredMaterializationSummary(materializationPeriod(now()))
      : failedMaterializationSummary(materializationPeriod(now())))
    if (isCronControlError(error, signal)) {
      phase.timeout(error, { counters: { deferred: 1 }, ...materializationTraceDetails(terminalSummary) })
      return { pages, completed: false, materialization: terminalSummary }
    }
    phase.fail(error, materializationTraceDetails(terminalSummary))
    throw error
  }
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
async function nextAvailableAt(queueRegistry, now, { signal, deadline } = {}) {
  signal?.throwIfAborted?.()
  const values = await Promise.all(queueRegistry.registered().map((adapter) => adapter.nextAvailableAt({ now, ...(signal ? { signal } : {}), ...(deadline ? { deadline } : {}) })))
  const dates = values.filter(Boolean).map((value) => value instanceof Date ? value : new Date(value)).filter((value) => !Number.isNaN(value.getTime()))
  return dates.length > 0 ? new Date(Math.min(...dates.map((value) => value.getTime()))) : null
}

export function createProfiledIndexingDrainRunner({ queueRegistry, profile, now = () => new Date(), trace } = {}) {
  if (!queueRegistry || !profile || !Number.isInteger(profile.maxJobs) || profile.maxJobs < 3 || !Number.isFinite(profile.budgetMs) || profile.budgetMs <= 0 || !validTaskProfiles(profile)) throw new Error('Indexing drain profile is invalid')
  const emitTrace = typeof trace === 'function' ? (event) => {
    try { trace(safeEvent(event, now)) } catch { /* telemetry cannot change job outcomes */ }
  } : () => {}
  return async (baseResult, options = {}) => {
    if (!baseResult?.startedAt || !baseResult?.queues) throw new Error('Due-work base result is required')
    const queue = queueRegistry.get('indexing')
    const remainingClaims = Math.max(0, profile.maxJobs - queueAttempts(baseResult.queues))
    const taskCounters = emptyTaskCounters()
    const effectiveRunId = options.runId ?? baseResult.runId
    const drainStartedAt = now()
    if (!(drainStartedAt instanceof Date) || Number.isNaN(drainStartedAt.getTime())) throw new Error('Due-work drain clock is invalid')
    const traceContext = { runId: effectiveRunId, profileMaxJobs: profile.maxJobs, remainingClaims }
    emitTrace({
      ...traceContext,
      stage: 'indexing.drain',
      status: 'started',
      counters: { claimed: remainingClaims },
    })
    const finishTrace = (status, details = {}) => {
      try {
        const finishedAt = now()
        const elapsedMs = finishedAt instanceof Date && !Number.isNaN(finishedAt.getTime())
          ? Math.max(0, Math.floor(finishedAt.getTime() - drainStartedAt.getTime()))
          : undefined
        emitTrace({ ...traceContext, stage: 'indexing.drain', status, ...(elapsedMs === undefined ? {} : { elapsedMs }), ...details })
      } catch { /* telemetry cannot change job outcomes */ }
    }
    try {
      if (!queue || remainingClaims === 0) {
        const result = { ...baseResult, taskCounters, finishedAt: now(), nextAvailableAt: await nextAvailableAt(queueRegistry, now, options) }
        finishTrace('deferred', { counters: mergeCounters() })
        return result
      }
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
        runId: options.runId ?? baseResult.runId,
        ...(options.signal ? { signal: options.signal } : {}),
      })()))
      const firstFailure = settled.find(({ status }) => status === 'rejected')
      if (firstFailure) throw firstFailure.reason
      const drains = settled.map(({ value }) => value)
      for (const drain of drains) {
        for (const [task, counters] of Object.entries(drain.taskCounters)) taskCounters[task] = mergeCounters(taskCounters[task], counters)
      }
      const drainCounters = drains.reduce((counters, drain) => mergeCounters(counters, drain.counters), mergeCounters())
      const result = {
        ...baseResult,
        finishedAt: now(),
        taskCounters,
        queues: {
          ...baseResult.queues,
          indexing: mergeCounters(baseResult.queues.indexing, drainCounters),
        },
        nextAvailableAt: await nextAvailableAt(queueRegistry, now, options),
      }
      finishTrace(indexingDrainStatus(drainCounters), { counters: drainCounters })
      return result
    } catch (error) {
      if (isCronControlError(error, options.signal)) {
        finishTrace('deferred', { error })
        throw error
      }
      finishTrace('failed', { error })
      throw error
    }
  }
}


export const DAILY_MATERIALIZATION_PAGE_LIMIT = 100
export const MAX_DAILY_MATERIALIZATION_PAGES = 10
export const DAILY_MATERIALIZATION_BUDGET_MS = 10_000

function normalizeMaterializerDescriptor(materializer, index) {
  if (typeof materializer === 'function') return { name: materializer.name || `materializer-${index + 1}`, run: materializer }
  if (materializer && typeof materializer.name === 'string' && materializer.name.trim() && typeof materializer.run === 'function') {
    return { name: materializer.name.trim(), run: materializer.run, ...(materializer.requiresCompleteMaterialization === true ? { requiresCompleteMaterialization: true } : {}) }
  }
  throw new Error('Cron materializer descriptor is invalid')
}
export function createCronDueWorkRunner({
  jobRepository,
  coordinatorRunner,
  indexingDrainRunner,
  now = () => new Date(),
  materializationPageLimit = DAILY_MATERIALIZATION_PAGE_LIMIT,
  maxMaterializationPages = MAX_DAILY_MATERIALIZATION_PAGES,
  materializationBudgetMs = DAILY_MATERIALIZATION_BUDGET_MS,
  materializers = [],
  trace = () => {},
  runIdFactory = randomUUID,
} = {}) {
  if (!jobRepository || typeof coordinatorRunner !== 'function' || indexingDrainRunner !== undefined && typeof indexingDrainRunner !== 'function') throw new Error('Cron job dependencies are required')
  if (!Number.isInteger(materializationPageLimit) || materializationPageLimit < 1 || materializationPageLimit > DAILY_MATERIALIZATION_PAGE_LIMIT) throw new Error('Daily materialization page limit is invalid')
  if (!Number.isInteger(maxMaterializationPages) || maxMaterializationPages < 1) throw new Error('Daily materialization page cap is invalid')
  if (!Number.isFinite(materializationBudgetMs) || materializationBudgetMs <= 0) throw new Error('Daily materialization budget is invalid')
  if (!Array.isArray(materializers)) throw new Error('Cron materializers are invalid')
  materializers.forEach(normalizeMaterializerDescriptor)
  if (typeof trace !== 'function' || typeof runIdFactory !== 'function') throw new Error('Cron trace dependencies are invalid')
  return async ({ signal, deadline: requestedDeadline, settlementDeadline: requestedSettlementDeadline, invocationOrigin: requestedInvocationOrigin } = {}) => {
    const startedAt = now()
    const normalizedMaterializers = materializers.map(normalizeMaterializerDescriptor)
    if (!(startedAt instanceof Date) || Number.isNaN(startedAt.getTime())) throw new Error('Cron clock is invalid')
    const profileDeadline = new Date(startedAt.getTime() + CRON_DUE_WORK_PROFILE.budgetMs)
    const requestedDeadlineAt = requestedDeadline === undefined ? profileDeadline.getTime() : new Date(requestedDeadline).getTime()
    if (!Number.isFinite(requestedDeadlineAt)) throw new Error('Cron deadline is invalid')
    const globalDeadline = new Date(Math.min(profileDeadline.getTime(), requestedDeadlineAt))
    const settlementDeadline = requestedSettlementDeadline === undefined ? globalDeadline : new Date(requestedSettlementDeadline)
    if (Number.isNaN(settlementDeadline.getTime())) throw new Error('Cron settlement deadline is invalid')
    const materializationDeadline = new Date(Math.min(startedAt.getTime() + materializationBudgetMs, globalDeadline.getTime()))
    const runId = runIdFactory()
    const invocationOrigin = typeof requestedInvocationOrigin === 'string' ? requestedInvocationOrigin : null
    const period = materializationPeriod(startedAt)
    let materializationSummaryValue = deferredMaterializationSummary(period)
    const emitTrace = (event) => {
      try {
        trace(safeEvent({ ...event, ...(invocationOrigin ? { invocationOrigin } : {}) }, now))
      } catch { /* telemetry cannot change cron outcomes */ }
    }
    const traceContext = { runId, deadlineAt: globalDeadline, ...(invocationOrigin ? { invocationOrigin } : {}) }
    const cronPhase = startRuntimePhase({ trace: emitTrace, stage: 'cron', now, context: traceContext })
    const deferredResult = (materialization = materializationSummaryValue) => ({
      runId,
      startedAt,
      finishedAt: now(),
      recovery: { inspected: 0, recovered: 0, retriesCreated: 0, failed: 0 },
      queues: Object.fromEntries(QUEUE_ORDER.map((name) => [QUEUE_RESPONSE_KEY[name], { ...EMPTY_QUEUE_COUNTERS }])),
      nextAvailableAt: null,
      invocationOrigin,
      materialization,
    })
    try {
      const materialization = await runCronMaterializationPhase({
        trace: emitTrace,
        now,
        context: traceContext,
        overallDeadline: globalDeadline,
        deadline: materializationDeadline,
        settlementDeadline,
        signal,
        materializers: normalizedMaterializers,
        jobRepository,
        pageLimit: materializationPageLimit,
        maxPages: maxMaterializationPages,
      })
      materializationSummaryValue = materialization.materialization ?? materializationSummaryValue
      if (!materialization.completed) {
        const result = deferredResult(materializationSummaryValue)
        cronPhase.timeout(undefined, { counters: { deferred: 1 }, ...materializationTraceDetails(materializationSummaryValue) })
        return result
      }
      const remainingBudgetMs = globalDeadline.getTime() - now().getTime()
      if (remainingBudgetMs < 1000) {
        const result = deferredResult(materializationSummaryValue)
        cronPhase.timeout(undefined, { counters: { deferred: 1 }, ...materializationTraceDetails(materializationSummaryValue) })
        return result
      }
      const hasIndexingDrain = typeof indexingDrainRunner === 'function'
      // Cap the coordinator's work budget so ingestion cannot consume the whole
      // run and starve the indexing drain. The coordinator self-limits its
      // workDeadline to min(startedAt + budgetMs, deadline); the outer deadline
      // stays globalDeadline so the drain keeps the full remaining wall-clock.
      const coordinatorBudgetMs = hasIndexingDrain
        ? Math.max(COORDINATOR_MIN_BUDGET_MS, remainingBudgetMs - CRON_INDEXING_DRAIN_RESERVE_MS)
        : remainingBudgetMs
      const coordinated = await runTracedPhase({
        signal,
        trace: emitTrace,
        stage: 'cron.coordinator',
        now,
        context: traceContext,
        execute: () => runCronOperation({
          operation: ({ signal: operationSignal, deadline, settlementDeadline: operationSettlementDeadline }) => coordinatorRunner({
            maxJobs: CRON_DUE_WORK_PROFILE.maxJobs,
            maxRecoveries: CRON_RECOVERY_LIMIT,
            budgetMs: coordinatorBudgetMs,
            runId,
            ...(invocationOrigin ? { invocationOrigin } : {}),
            signal: operationSignal,
            deadline,
            settlementDeadline: operationSettlementDeadline,
          }),
          deadline: globalDeadline,
          settlementDeadline,
          now,
          signal,
        }),
        successDetails: (result) => ({ counters: { claimed: queueAttempts(result?.queues) } }),
      })
      if (coordinated?.[CONTROL_PHASE_RESULT]) {
        const result = deferredResult(materializationSummaryValue)
        cronPhase.timeout(coordinated.error, { counters: { deferred: 1 }, ...materializationTraceDetails(materializationSummaryValue) })
        return result
      }
      if (!hasIndexingDrain || now().getTime() >= globalDeadline.getTime()) {
        const result = { ...coordinated, invocationOrigin, materialization: materializationSummaryValue }
        cronPhase.succeed({ counters: coordinated?.queues?.indexing, ...materializationTraceDetails(materializationSummaryValue) })
        return result
      }
      const result = await runTracedPhase({
        signal,
        trace: emitTrace,
        stage: 'cron.indexing',
        now,
        context: traceContext,
        execute: () => runCronOperation({
          operation: ({ signal: operationSignal, deadline, settlementDeadline: operationSettlementDeadline }) => indexingDrainRunner(coordinated, { deadline, startedAt, runId, ...(invocationOrigin ? { invocationOrigin } : {}), signal: operationSignal, settlementDeadline: operationSettlementDeadline }),
          deadline: globalDeadline,
          settlementDeadline,
          now,
          signal,
        }),
        successDetails: (value) => ({ counters: value?.queues?.indexing }),
      })
      if (result?.[CONTROL_PHASE_RESULT]) {
        const deferred = deferredResult(materializationSummaryValue)
        cronPhase.timeout(result.error, { counters: { deferred: 1 }, ...materializationTraceDetails(materializationSummaryValue) })
        return deferred
      }
      const completed = { ...result, invocationOrigin, materialization: materializationSummaryValue }
      cronPhase.succeed({ counters: result?.queues?.indexing, ...materializationTraceDetails(materializationSummaryValue) })
      return completed
    } catch (error) {
      if (isCronControlError(error, signal)) {
        const deferred = deferredResult(materializationSummaryValue)
        cronPhase.timeout(error, { counters: { deferred: 1 }, ...materializationTraceDetails(materializationSummaryValue) })
        return deferred
      }
      cronPhase.fail(error, materializationTraceDetails(failedMaterializationSummary(period)))
      throw error
    } finally {
      await flushRuntimeTrace(trace, { deadline: globalDeadline, maxWaitMs: 1_000 })
    }
  }
}

export async function createConfiguredJobRuntime({ context, cronEventRepository, maintenanceCronEventRepository, now = () => new Date(), executor, rateLimitAdmission, quotaKeyring, governanceKeyring, governanceDb, maintenanceContext, verifyJobsSchema = assertDurableJobsReady, verifyGovernanceSchema = assertGovernanceReady, trace = () => {}, runIdFactory = randomUUID, ingestionExecutionTimeoutMs = INGESTION_EXECUTION_TIMEOUT_MS, ingestionFinalizationGraceMs = INGESTION_FINALIZATION_GRACE_MS } = {}) {
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
  if (maintenanceContext?.client && maintenanceContext.client === context.client) throw new Error('MongoDB maintenance client must be separate from runtime client')
  const retentionRepository = maintenanceContext?.client && maintenanceContext?.db?.collection
    ? (maintenanceCronEventRepository ?? new MongoCronEventRepository(maintenanceContext))
    : null
  const queueRegistry = createQueueRegistry()
  queueRegistry.register(createIngestionQueueAdapter({ jobRepository, leaseRepository, executor, trace, executionTimeoutMs: ingestionExecutionTimeoutMs, finalizationGraceMs: ingestionFinalizationGraceMs }))
  const maintenanceRegistry = createMaintenanceRegistry()
  const cronMaterializers = []
  maintenanceRegistry.register('purge-ingestion-jobs', ({ cutoff, limit }) => jobRepository.purgeDueIngestionJobs({ cutoff, limit }))
  if (retentionRepository && typeof retentionRepository.purgeExpiredEvents === 'function') {
    maintenanceRegistry.register('purge-cron-lifecycle-events', ({ cutoff, limit }) => retentionRepository.purgeExpiredEvents({ cutoff, limit }))
  }
  if (retentionRepository && typeof retentionRepository.purgeExpiredEvents === 'function') {
    cronMaterializers.push({
      name: 'cron-lifecycle-retention',
      run: async ({ deadline, signal, settlementDeadline } = {}) => {
        let hasMore = true
        let inspected = 0
        let affected = 0
        let pages = 0
        while (hasMore && pages < MAX_DAILY_MATERIALIZATION_PAGES) {
          const current = now()
          if (!(current instanceof Date) || Number.isNaN(current.getTime())) throw new Error('Cron retention clock is invalid')
          if (deadline instanceof Date && current.getTime() >= deadline.getTime()) break
          signal?.throwIfAborted?.()
          const result = await retentionRepository.purgeExpiredEvents({ cutoff: current, limit: DAILY_MATERIALIZATION_PAGE_LIMIT, ...(signal ? { signal } : {}), ...(deadline ? { deadline } : {}), ...(settlementDeadline ? { settlementDeadline } : {}) })
          inspected += Math.max(0, Number(result?.inspected ?? 0))
          affected += Math.max(0, Number(result?.affected ?? 0))
          hasMore = result?.hasMore === true
          pages += 1
        }
        return { inspected, affected, hasMore }
      },
    })
  }
  const takedownRepository = context.db?.collection ? new MongoTakedownRepository({ ...context, governanceDb: deletionGovernanceDb, governanceKeyring }) : null
  const accountDeletionRepository = context.db?.collection ? new MongoAccountDeletionRepository({ ...context, quotaKeyring, governanceKeyring, governanceDb: deletionGovernanceDb }) : null
  if (accountDeletionRepository && typeof accountDeletionRepository.selectDue === 'function') queueRegistry.register(createAccountDeletionQueueAdapter({ repository: accountDeletionRepository }))
  const adminAuditRepository = maintenanceContext?.db?.collection && maintenanceContext?.client ? new MongoAdminRepository(maintenanceContext) : null
  if (takedownRepository) {
    maintenanceRegistry.register('purge-takedown-pii', ({ cutoff, limit }) => takedownRepository.purgePii({ cutoff, limit }))
    maintenanceRegistry.register('purge-takedown-workflows', ({ cutoff, limit }) => takedownRepository.purgeWorkflows({ cutoff, limit }))
    cronMaterializers.push({
      name: 'takedown-cleanup',
      run: ({ signal, deadline, settlementDeadline } = {}) => takedownRepository.materializeCleanupBatch({ now: now(), limit: DAILY_MATERIALIZATION_PAGE_LIMIT, ...(signal ? { signal } : {}), ...(deadline ? { deadline } : {}), ...(settlementDeadline ? { settlementDeadline } : {}) }),
    })
  }
  if (accountDeletionRepository) maintenanceRegistry.register('purge-account-deletion-workflows', ({ cutoff, limit }) => accountDeletionRepository.purge({ cutoff, limit }))
  if (adminAuditRepository) maintenanceRegistry.register('purge-audit-ip-hmac', ({ cutoff, limit }) => adminAuditRepository.purgeAuditIpHmac({ cutoff, limit }))
  const maintenanceRunner = createMaintenanceRunner({ registry: maintenanceRegistry, now })
  const adminIndexingDrainRunner = createProfiledIndexingDrainRunner({ queueRegistry, profile: ADMIN_DUE_WORK_PROFILE, now, trace })
  const cronIndexingDrainRunner = createProfiledIndexingDrainRunner({ queueRegistry, profile: CRON_DUE_WORK_PROFILE, now, trace })
  const coordinatorRunner = createCoordinatorRunner({ queueRegistry, now, runIdFactory, trace })
  const coordinatorRunnerWithFlush = createFlushedCoordinatorRunner({ coordinatorRunner, trace })
  const adminDueWorkRunner = async () => {
    let deadline
    try {
      const startedAt = now()
      if (startedAt instanceof Date && !Number.isNaN(startedAt.getTime())) deadline = new Date(startedAt.getTime() + ADMIN_DUE_WORK_PROFILE.budgetMs)
      const baseResult = await coordinatorRunner({ maxJobs: ADMIN_DUE_WORK_PROFILE.maxJobs, budgetMs: ADMIN_DUE_WORK_PROFILE.budgetMs, ...(deadline ? { deadline } : {}) })
      return await adminIndexingDrainRunner(baseResult, { ...(deadline ? { deadline } : {}) })
    } finally {
      await flushRuntimeTrace(trace, { ...(deadline ? { deadline } : {}), maxWaitMs: 1_000 })
    }
  }
  const dueWorkRunner = createCronDueWorkRunner({
    jobRepository,
    coordinatorRunner: async (options = {}) => coordinatorRunner({ maxJobs: CRON_DUE_WORK_PROFILE.maxJobs, budgetMs: CRON_DUE_WORK_PROFILE.budgetMs, ...options }),
    indexingDrainRunner: cronIndexingDrainRunner,
    now,
    materializers: cronMaterializers,
    trace,
    runIdFactory,
  })
  const configured = await createConfiguredJobService({ context, now, rateLimitAdmission, runDueWork: coordinatorRunnerWithFlush, runAdminDueWork: adminDueWorkRunner, trace, verifySchema: verifyJobsSchema })
  return {
    ...configured,
    queueRegistry,
    maintenanceRegistry,
    maintenanceRunner,
    coordinatorRunner: coordinatorRunnerWithFlush,
    adminDueWorkRunner,
    dueWorkRunner,
    cronMaterializers,
    trace,
    maintenanceContext: adminAuditRepository ? maintenanceContext : null,
  }
}
