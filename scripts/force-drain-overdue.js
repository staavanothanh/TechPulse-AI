import { pathToFileURL } from 'node:url'
import { closeMongoConnection, getMongoContext } from '../server/repositories/mongo/connection.js'
import { closeMaintenanceMongoContext } from '../server/maintenance/mongo-context.js'
import { createConfiguredRuntimeFactories } from '../server/bootstrap/lazy-runtime.js'
import { validateRuntimeConfiguration } from '../server/config/runtime.js'
import { configuredEmbeddingTarget, assertIndexingJobsReady } from '../server/bootstrap/indexing.js'
import { assertProviderRoutingReady } from '../server/bootstrap/provider-routing.js'
import { MongoIndexingJobRepository } from '../server/repositories/mongo/indexing-job-repository.js'
import {
  createIndexingDrainRunner,
  TASK_CONCURRENCY,
  TASK_ORDER,
  TASK_START_GUARD_MS,
} from '../server/jobs/indexing-drain.js'

// Run with: node --env-file-if-exists=.env scripts/force-drain-overdue.js
// The normal mode is read-only. Add --confirm to allow repository claims.
// Use the cron drain ceiling for this one-off local recovery. This keeps the
// script below Vercel's five-minute function limit while allowing the current
// backlog to be handled in one invocation.
export const MAX_CLAIMS = 200
export const MAX_BUDGET_MS = 240_000
export const DEFAULT_MAX_CLAIMS = MAX_CLAIMS
export const DEFAULT_BUDGET_MS = MAX_BUDGET_MS
export const ALLOWED_TASKS = Object.freeze(['summary', 'embedding'])
export const EMPTY_COUNTERS = Object.freeze({ claimed: 0, succeeded: 0, partial: 0, failed: 0, deferred: 0 })
export const FORCE_DRAIN_USAGE = 'node --env-file-if-exists=.env scripts/force-drain-overdue.js [--confirm --confirm-database=NAME] [--max-claims=N] [--budget-ms=N]'

const MIN_BUDGET_MS = 1_000
const TASK_SET = new Set(ALLOWED_TASKS)
const DATABASE_NAME = /^[A-Za-z0-9][A-Za-z0-9_]{0,62}$/

function invalidArguments(message) {
  return Object.assign(new Error(message), { code: 'force_drain_arguments_invalid' })
}

function integerOption(value, name, minimum, maximum) {
  const number = Number(value)
  if (!Number.isSafeInteger(number) || number < minimum || number > maximum) throw invalidArguments(`${name} is outside the safe bound`)
  return number
}

function parseValue(argument, argv, index, option) {
  const prefix = `${option}=`
  if (argument.startsWith(prefix)) return { value: argument.slice(prefix.length), nextIndex: index }
  if (argument === option && argv[index + 1] !== undefined) return { value: argv[index + 1], nextIndex: index + 1 }
  throw invalidArguments(`${option} requires a value`)
}

export function parseArgs(argv = []) {
  if (!Array.isArray(argv)) throw invalidArguments('arguments must be an array')
  let confirm = false
  let dryRun = false
  let explicitDryRun = false
  let maxClaims = DEFAULT_MAX_CLAIMS
  let budgetMs = DEFAULT_BUDGET_MS
  let confirmDatabase = null
  let help = false

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]
    if (argument === '--confirm') {
      if (confirm) throw invalidArguments('confirm flag is duplicated')
      confirm = true
    } else if (argument === '--dry-run') {
      if (explicitDryRun) throw invalidArguments('dry-run flag is duplicated')
      explicitDryRun = true
      dryRun = true
    } else if (typeof argument === 'string' && (argument.startsWith('--confirm-database=') || argument === '--confirm-database')) {
      const parsed = parseValue(argument, argv, index, '--confirm-database')
      if (typeof parsed.value !== 'string' || !DATABASE_NAME.test(parsed.value)) throw invalidArguments('confirm-database is invalid')
      if (confirmDatabase !== null) throw invalidArguments('confirm-database is duplicated')
      confirmDatabase = parsed.value
      index = parsed.nextIndex
    } else if (argument === '--help' || argument === '-h') {
      help = true
    } else if (typeof argument === 'string' && (argument.startsWith('--max-claims=') || argument === '--max-claims')) {
      const parsed = parseValue(argument, argv, index, '--max-claims')
      maxClaims = integerOption(parsed.value, 'max-claims', 1, MAX_CLAIMS)
      index = parsed.nextIndex
    } else if (typeof argument === 'string' && (argument.startsWith('--max-jobs=') || argument === '--max-jobs')) {
      const parsed = parseValue(argument, argv, index, '--max-jobs')
      maxClaims = integerOption(parsed.value, 'max-jobs', 1, MAX_CLAIMS)
      index = parsed.nextIndex
    } else if (typeof argument === 'string' && (argument.startsWith('--budget-ms=') || argument === '--budget-ms')) {
      const parsed = parseValue(argument, argv, index, '--budget-ms')
      budgetMs = integerOption(parsed.value, 'budget-ms', MIN_BUDGET_MS, MAX_BUDGET_MS)
      index = parsed.nextIndex
    } else {
      throw invalidArguments('unknown argument')
    }
  }

  if (confirm && explicitDryRun) throw invalidArguments('confirm and dry-run are mutually exclusive')
  if (confirm && confirmDatabase === null) throw invalidArguments('confirm-database is required with confirm')
  if (!confirm && confirmDatabase !== null) throw invalidArguments('confirm-database requires confirm')
  if (help && (confirm || explicitDryRun || confirmDatabase !== null)) throw invalidArguments('help cannot be combined with execution flags')
  if (!confirm) dryRun = true
  return Object.freeze({ confirm, dryRun, maxClaims, budgetMs, confirmDatabase, help })
}

export const parseForceDrainArgs = parseArgs

function asDate(value, label) {
  const result = value instanceof Date ? new Date(value.getTime()) : new Date(value)
  if (Number.isNaN(result.getTime())) throw new Error(`${label} is invalid`)
  return result
}

function validateClock(now) {
  if (typeof now !== 'function') throw new Error('force drain clock is invalid')
  return () => asDate(now(), 'force drain clock')
}

function validateQueue(queue) {
  if (!queue || typeof queue.selectDue !== 'function' || typeof queue.claimAndExecute !== 'function' || typeof queue.nextAvailableAt !== 'function') {
    throw new Error('indexing queue is unavailable')
  }
  return queue
}

function candidateIsDue(candidate, now) {
  if (candidate?.status !== 'queued') return false
  if (candidate?.availableAt === undefined || candidate?.availableAt === null) return false
  const availableAt = asDate(candidate.availableAt, 'indexing candidate availability')
  return availableAt.getTime() <= now.getTime()
}

function candidateIdentity(candidate) {
  if (candidate?.id === undefined || candidate?.id === null || String(candidate.id).length === 0) throw new Error('indexing candidate id is invalid')
  if (candidate?.articleId === undefined || candidate?.articleId === null || String(candidate.articleId).length === 0) throw new Error('indexing candidate article id is invalid')
  return { id: String(candidate.id), articleId: String(candidate.articleId) }
}

function indexingTaskQueue(queue) {
  const source = validateQueue(queue)
  return Object.freeze({
    queueName: source.queueName ?? 'indexing',
    selectDue: async (input = {}) => {
      const task = input.task ?? (Array.isArray(input.tasks) && input.tasks.length === 1 ? input.tasks[0] : undefined)
      if (!TASK_SET.has(task)) return null
      const now = asDate(input.now, 'indexing selection clock')
      const candidate = await source.selectDue({ ...input, task, tasks: undefined })
      if (!candidate) return null
      if (candidate.task !== task) throw new Error('indexing candidate task is invalid')
      return candidateIsDue(candidate, now) ? candidate : null
    },
    claimAndExecute: async (input = {}) => {
      const candidate = input.candidate
      if (!TASK_SET.has(candidate?.task)) throw new Error('indexing candidate task is invalid')
      const identity = candidateIdentity(candidate)
      if (!candidateIsDue(candidate, asDate(input.now, 'indexing claim clock'))) throw new Error('indexing candidate is not due')
      return source.claimAndExecute({ ...input, candidate: { ...candidate, id: identity.id, articleId: identity.articleId } })
    },
    nextAvailableAt: (input = {}) => source.nextAvailableAt(input),
  })
}

function normalizedOptions(input) {
  const value = input ?? {}
  const confirm = value.confirm === true
  const dryRun = value.dryRun === undefined ? !confirm : value.dryRun === true
  if (confirm && dryRun) throw invalidArguments('confirm and dry-run are mutually exclusive')
  if (!confirm && value.dryRun === false) throw invalidArguments('confirm is required for execution')
  const confirmDatabase = value.confirmDatabase ?? null
  if (confirm && (typeof confirmDatabase !== 'string' || !DATABASE_NAME.test(confirmDatabase))) throw invalidArguments('confirm-database is required with confirm')
  if (!confirm && confirmDatabase !== null) throw invalidArguments('confirm-database requires confirm')
  const maxClaims = integerOption(value.maxClaims ?? DEFAULT_MAX_CLAIMS, 'max-claims', 1, MAX_CLAIMS)
  const budgetMs = integerOption(value.budgetMs ?? DEFAULT_BUDGET_MS, 'budget-ms', MIN_BUDGET_MS, MAX_BUDGET_MS)
  return Object.freeze({ confirm, dryRun: !confirm && dryRun, maxClaims, budgetMs, confirmDatabase })
}

function queueFromRuntime(runtime) {
  if (runtime?.queue) return validateQueue(runtime.queue)
  if (runtime?.indexingQueue) return validateQueue(runtime.indexingQueue)
  const queue = runtime?.jobs?.queueRegistry?.get?.('indexing')
  return validateQueue(queue)
}

export async function createConfiguredRuntime({ environment = process.env, factories } = {}) {
  const configuredFactories = factories ?? createConfiguredRuntimeFactories({ environment })
  if (typeof configuredFactories.common !== 'function' || typeof configuredFactories.jobs !== 'function' || typeof configuredFactories.indexing !== 'function') throw new Error('configured runtime factories are incomplete')
  let jobs
  try {
    const common = await configuredFactories.common()
    jobs = await configuredFactories.jobs({ common })
    const indexing = await configuredFactories.indexing({ common, jobs })
    return Object.freeze({ common, jobs, indexing, database: common?.context?.database ?? null, maintenanceContext: jobs?.maintenanceContext ?? null, queue: queueFromRuntime({ jobs, indexing }) })
  } catch (error) {
    await closeConfiguredRuntime({ maintenanceContext: jobs?.maintenanceContext })
    throw error
  }
}

export const loadConfiguredRuntime = createConfiguredRuntime

function readOnlyIndexingQueue(repository) {
  return Object.freeze({
    queueName: 'indexing',
    selectDue: (input = {}) => repository.selectDueIndexing(input),
    claimAndExecute: async () => { throw Object.assign(new Error('force drain dry-run is read-only'), { code: 'force_drain_read_only' }) },
    nextAvailableAt: () => repository.nextAvailableAt(),
  })
}

export async function createConfiguredReadOnlyRuntime({ environment = process.env } = {}) {
  const runtime = validateRuntimeConfiguration(environment)
  const context = await getMongoContext(runtime, environment)
  try {
    await assertIndexingJobsReady(context)
    await assertProviderRoutingReady(context)
    const repository = new MongoIndexingJobRepository(context, { embeddingTarget: configuredEmbeddingTarget(runtime.providerRegistry) })
    return Object.freeze({ common: { context, runtime }, jobs: null, indexing: null, database: context.database, maintenanceContext: null, queue: readOnlyIndexingQueue(repository) })
  } catch (error) {
    await closeMongoConnection()
    throw error
  }
}

export async function closeConfiguredRuntime(runtime) {
  try { await closeMaintenanceMongoContext(runtime?.maintenanceContext) } catch { /* cleanup is best effort */ }
  try { await closeMongoConnection() } catch { /* cleanup is best effort */ }
}

async function previewDue({ queue, maxClaims, budgetMs, now }) {
  const clock = validateClock(now)
  const startedAt = clock()
  const deadline = new Date(startedAt.getTime() + budgetMs)
  const taskQueue = indexingTaskQueue(queue)
  const byTask = Object.fromEntries(ALLOWED_TASKS.map((task) => [task, 0]))
  const seenByTask = new Map(ALLOWED_TASKS.map((task) => [task, new Set()]))
  let due = 0

  while (due < maxClaims) {
    let progressed = false
    for (const task of ALLOWED_TASKS) {
      if (due >= maxClaims) break
      const tick = clock()
      if (deadline.getTime() - tick.getTime() < (TASK_START_GUARD_MS[task] ?? 5_000)) continue
      const candidate = await taskQueue.selectDue({ task, now: tick, excludeArticleIds: [...seenByTask.get(task)] })
      if (!candidate) continue
      const identity = candidateIdentity(candidate)
      const seen = seenByTask.get(task)
      if (seen.has(identity.articleId)) continue
      seen.add(identity.articleId)
      byTask[task] += 1
      due += 1
      progressed = true
    }
    if (!progressed) break
  }

  const finishedAt = clock()
  const nextAvailableAt = await taskQueue.nextAvailableAt({ now: finishedAt })
  return {
    startedAt,
    finishedAt,
    candidates: { due, ...byTask },
    counters: { ...EMPTY_COUNTERS },
    nextAvailableAt: nextAvailableAt ? asDate(nextAvailableAt, 'next indexing availability') : null,
  }
}

export const previewDueIndexing = previewDue

async function executeDrain({ queue, maxClaims, budgetMs, now }) {
  const clock = validateClock(now)
  const startedAt = clock()
  const deadline = new Date(startedAt.getTime() + budgetMs)
  return createIndexingDrainRunner({ queue: indexingTaskQueue(queue), tasks: ALLOWED_TASKS, maxClaims, deadline, now: clock })()
}

export const executeForceDrain = executeDrain

function runtimeDatabase(runtime) {
  return runtime?.database ?? runtime?.common?.context?.database ?? runtime?.context?.database ?? null
}

function reportBase(options, runtime) {
  return {
    database: runtimeDatabase(runtime),
    maxClaims: options.maxClaims,
    budgetMs: options.budgetMs,
    taskConcurrency: Object.fromEntries(ALLOWED_TASKS.map((task) => [task, TASK_CONCURRENCY[task]])),
  }
}

export async function runForceDrain({ options, environment = process.env, factories, runtime, loadRuntime = createConfiguredRuntime, loadReadOnlyRuntime = createConfiguredReadOnlyRuntime, now = () => new Date() } = {}) {
  const normalized = normalizedOptions(options)
  const ownsRuntime = runtime === undefined
  if (!normalized.dryRun) {
    const configuredDatabase = environment?.MONGODB_DATABASE
    if (configuredDatabase !== normalized.confirmDatabase) throw invalidArguments('confirm-database does not match the configured runtime database')
  }
  let configured = runtime
  try {
    if (!configured) configured = normalized.dryRun ? await loadReadOnlyRuntime({ environment }) : await loadRuntime({ environment, factories })
    if (!normalized.dryRun && runtimeDatabase(configured) !== normalized.confirmDatabase) throw invalidArguments('confirm-database does not match the configured runtime database')
    const queue = queueFromRuntime(configured)
    if (normalized.dryRun) {
      const preview = await previewDue({ queue, maxClaims: normalized.maxClaims, budgetMs: normalized.budgetMs, now })
      return {
        ok: true,
        mode: 'dry-run',
        dryRun: true,
        ...reportBase(normalized, configured),
        startedAt: preview.startedAt,
        finishedAt: preview.finishedAt,
        candidates: preview.candidates,
        counters: preview.counters,
        nextAvailableAt: preview.nextAvailableAt,
      }
    }
    const drain = await executeDrain({ queue, maxClaims: normalized.maxClaims, budgetMs: normalized.budgetMs, now })
    return {
      ok: true,
      mode: 'execute',
      dryRun: false,
      ...reportBase(normalized, configured),
      startedAt: drain.startedAt,
      finishedAt: drain.finishedAt,
      counters: drain.counters,
      nextAvailableAt: drain.nextAvailableAt ?? null,
    }
  } finally {
    if (ownsRuntime) await closeConfiguredRuntime(configured)
  }
}

export const forceDrainOverdue = runForceDrain

function safeError(error) {
  const code = typeof error?.code === 'string' && /^[a-z0-9_:-]{1,128}$/i.test(error.code) ? error.code : null
  return { ok: false, error: 'force_drain_failed', code, type: error?.name ?? 'Error' }
}

export async function main(argv = process.argv.slice(2), { environment = process.env, log = console.log, errorLog = console.error } = {}) {
  try {
    const options = parseArgs(argv)
    if (options.help) {
      log(FORCE_DRAIN_USAGE)
      return { ok: true, help: true }
    }
    const result = await runForceDrain({ options, environment })
    log(JSON.stringify(result))
    return result
  } catch (error) {
    errorLog(JSON.stringify(safeError(error)))
    process.exitCode = 1
    return null
  } finally {
    try { await closeMongoConnection() } catch { /* close is best effort */ }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main()

export { TASK_ORDER }
