import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { randomUUID } from 'node:crypto'
import { pathToFileURL } from 'node:url'

import { createApp } from '../server/app.js'
import { createConfiguredIngestionExecutor } from '../server/bootstrap/ingestion.js'
import { createCoordinatorRunner, createCronDueWorkRunner } from '../server/bootstrap/jobs.js'
import { validateRuntimeConfiguration } from '../server/config/runtime.js'
import { createIngestionQueueAdapter } from '../server/jobs/ingestion-queue.js'
import { createQueueRegistry } from '../server/jobs/queue-registry.js'
import { createRuntimeTracer } from '../server/jobs/runtime-trace.js'
import { MongoJobRepository, serializeIngestionJob } from '../server/repositories/mongo/job-repository.js'
import { MongoLeaseRepository } from '../server/repositories/mongo/lease-repository.js'
import { closeMongoConnection, getMongoContext } from '../server/repositories/mongo/connection.js'
import { createSafeFetch } from '../server/infrastructure/http/safe-fetch.js'
import { configureDns } from './configure-dns.js'

export const CRON_PATH = '/api/internal/cron/due-work'
export const DEFAULT_PERIOD = '2026-08-31'
export const DEFAULT_EXPECTED_QUEUED = 9
export const DEFAULT_EXPECTED_RUNNING = 1
export const DEFAULT_TIMEOUT_MS = 300_000

const MAX_EXPECTED_JOBS = 100
const MIN_TIMEOUT_MS = 1_000
const MAX_TIMEOUT_MS = 300_000
const DATABASE_NAME = /^[A-Za-z0-9][A-Za-z0-9_]{0,62}$/
const PERIOD = /^\d{4}-\d{2}-\d{2}$/
const NON_TERMINAL = Object.freeze(['queued', 'running'])
const TERMINAL = new Set(['succeeded', 'partial', 'failed', 'cancelled'])
const JOB_PROJECTION = Object.freeze({
  _id: 1,
  idempotencyKey: 1,
  actorScope: 1,
  trigger: 1,
  sourceId: 1,
  status: 1,
  attempt: 1,
  availableAt: 1,
  startedAt: 1,
  finishedAt: 1,
  leaseGeneration: 1,
  error: 1,
  counters: 1,
  parentJobId: 1,
})

export const SIMULATION_USAGE = `Usage: node --env-file-if-exists=../../.env scripts/simulate-vercel-cron.js [--confirm --confirm-database=techpulse_app] [--period=2026-08-31] [--expected-queued=9] [--expected-running=1] [--timeout-ms=300000]`

export class CronSimulationError extends Error {
  constructor(code, message) {
    super(message)
    this.name = 'CronSimulationError'
    this.code = code
  }
}

function parseInteger(value, name, minimum, maximum) {
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) throw new CronSimulationError('cron_simulation_arguments_invalid', `${name} is outside the safe bound`)
  return parsed
}

function optionValue(argument, argv, index, option) {
  const prefix = `${option}=`
  if (argument.startsWith(prefix)) return { value: argument.slice(prefix.length), nextIndex: index }
  if (argument === option && argv[index + 1] !== undefined) return { value: argv[index + 1], nextIndex: index + 1 }
  throw new CronSimulationError('cron_simulation_arguments_invalid', `${option} requires a value`)
}


function databaseName(value) {
  if (typeof value !== 'string' || !DATABASE_NAME.test(value)) throw new CronSimulationError('cron_simulation_arguments_invalid', 'confirm-database is invalid')
  return value
}

export function parseSimulationArgs(argv = []) {
  const options = {
    confirm: false,
    confirmDatabase: null,
    expectedQueued: DEFAULT_EXPECTED_QUEUED,
    expectedRunning: DEFAULT_EXPECTED_RUNNING,
    period: DEFAULT_PERIOD,
    timeoutMs: DEFAULT_TIMEOUT_MS,
  }
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]
    if (argument === '--help' || argument === '-h') return { help: true }
    if (argument === '--confirm') { options.confirm = true; continue }
    if (argument.startsWith('--period') || argument === '--period') {
      const selected = optionValue(argument, argv, index, '--period'); index = selected.nextIndex
      if (!PERIOD.test(selected.value)) throw new CronSimulationError('cron_simulation_arguments_invalid', 'period is invalid')
      options.period = selected.value
      continue
    }
    if (argument.startsWith('--expected-queued') || argument === '--expected-queued') {
      const selected = optionValue(argument, argv, index, '--expected-queued'); index = selected.nextIndex
      options.expectedQueued = parseInteger(selected.value, 'expected-queued', 0, MAX_EXPECTED_JOBS)
      continue
    }
    if (argument.startsWith('--expected-running') || argument === '--expected-running') {
      const selected = optionValue(argument, argv, index, '--expected-running'); index = selected.nextIndex
      options.expectedRunning = parseInteger(selected.value, 'expected-running', 0, MAX_EXPECTED_JOBS)
      continue
    }
    if (argument.startsWith('--timeout-ms') || argument === '--timeout-ms') {
      const selected = optionValue(argument, argv, index, '--timeout-ms'); index = selected.nextIndex
      options.timeoutMs = parseInteger(selected.value, 'timeout-ms', MIN_TIMEOUT_MS, MAX_TIMEOUT_MS)
      continue
    }
    if (argument.startsWith('--confirm-database') || argument === '--confirm-database') {
      const selected = optionValue(argument, argv, index, '--confirm-database'); index = selected.nextIndex
      options.confirmDatabase = databaseName(selected.value)
      continue
    }
    throw new CronSimulationError('cron_simulation_arguments_invalid', `unknown option: ${argument}`)
  }
  if (options.confirm && options.confirmDatabase === null) throw new CronSimulationError('cron_simulation_arguments_invalid', 'confirm-database is required with --confirm')
  return Object.freeze(options)
}

export function buildVercelCronHeaders(secret) {
  if (typeof secret !== 'string' || secret.length === 0) throw new CronSimulationError('cron_secret_missing', 'cron bearer secret is missing')
  return Object.freeze({ Accept: 'application/json', Authorization: `Bearer ${secret}`, 'User-Agent': 'vercel-cron/1.0' })
}

export function summarizeJobs(rows = []) {
  const counts = rows.reduce((result, row) => {
    const status = row?.status
    if (status === 'queued') result.queued += 1
    else if (status === 'running') result.running += 1
    else if (TERMINAL.has(status)) result.terminal += 1
    return result
  }, { total: 0, queued: 0, running: 0, terminal: 0 })
  return { ...counts, total: rows.length }
}

export function assertInitialBatch(rows, { expectedQueued, expectedRunning } = {}) {
  const summary = summarizeJobs(rows)
  if (summary.queued !== expectedQueued || summary.running !== expectedRunning || summary.total !== expectedQueued + expectedRunning) {
    throw new CronSimulationError('cron_simulation_initial_state_mismatch', `initial starting state must contain ${expectedQueued} queued and ${expectedRunning} running jobs`)
  }
  const ids = rows.map((row) => String(row.id ?? row._id ?? ''))
  if (ids.some((id) => id.length === 0) || new Set(ids).size !== ids.length) throw new CronSimulationError('cron_simulation_initial_state_mismatch', 'initial job identifiers are invalid')
  return { ids, total: summary.total, queued: summary.queued, running: summary.running }
}

function idString(value) {
  if (value === undefined || value === null) return null
  return typeof value.toHexString === 'function' ? value.toHexString() : String(value)
}

function iso(value) {
  return value instanceof Date ? value.toISOString() : value ?? null
}

function serializeJobState(document) {
  const serialized = serializeIngestionJob(document)
  return {
    id: serialized.id,
    idempotencyKey: serialized.idempotencyKey,
    sourceId: serialized.sourceId,
    status: serialized.status,
    attempt: serialized.attempt,
    availableAt: iso(serialized.availableAt),
    startedAt: iso(serialized.startedAt),
    finishedAt: iso(serialized.finishedAt),
    leaseGeneration: serialized.leaseGeneration,
    errorCode: serialized.error?.code ?? null,
    counters: serialized.counters ?? null,
    parentJobId: serialized.parentJobId ?? null,
  }
}

function periodFilter(period, status) {
  const prefix = `^daily:${period.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}:`
  return {
    actorScope: 'system-cron',
    trigger: 'cron',
    idempotencyKey: { $regex: prefix },
    ...(status ? { status } : {}),
  }
}

async function readInitialBatch(db, period) {
  return db.collection('ingestionJobs')
    .find(periodFilter(period, { $in: NON_TERMINAL }), { projection: JOB_PROJECTION, maxTimeMS: 5_000 })
    .sort({ createdAt: 1, _id: 1 })
    .toArray()
}

async function readJobsByIds(db, ids) {
  if (ids.length === 0) return []
  return db.collection('ingestionJobs')
    .find({ _id: { $in: ids } }, { projection: JOB_PROJECTION, maxTimeMS: 5_000 })
    .sort({ createdAt: 1, _id: 1 })
    .toArray()
}

async function readLinkedRetries(db, ids) {
  if (ids.length === 0) return []
  return db.collection('ingestionJobs')
    .find({ parentJobId: { $in: ids } }, { projection: JOB_PROJECTION, maxTimeMS: 5_000 })
    .sort({ createdAt: 1, _id: 1 })
    .toArray()
}

async function nonTerminalCount(db) {
  return db.collection('ingestionJobs').countDocuments({ status: { $in: NON_TERMINAL } }, { maxTimeMS: 5_000 })
}

function statusCounts(rows) {
  return rows.reduce((result, row) => {
    const status = row.status
    result[status] = (result[status] ?? 0) + 1
    return result
  }, {})
}

function resolveMachineSecret(environment, runtimeConfig) {
  const name = runtimeConfig.internalMachineSecretEnv
  const secret = typeof name === 'string' ? environment[name] : undefined
  if (typeof secret !== 'string' || secret.length === 0) throw new CronSimulationError('cron_secret_missing', 'configured cron bearer secret is missing')
  return secret
}

function listen(server) {
  return new Promise((resolve, reject) => {
    const onError = (error) => { server.removeListener('listening', onListening); reject(error) }
    const onListening = () => {
      server.removeListener('error', onError)
      const address = server.address()
      if (!address || typeof address === 'string') return reject(new Error('embedded cron server address is unavailable'))
      resolve(`http://127.0.0.1:${address.port}`)
    }
    server.once('error', onError)
    server.once('listening', onListening)
    server.listen(0, '127.0.0.1')
  })
}

function closeServer(server) {
  if (!server) return Promise.resolve()
  return new Promise((resolve) => server.close(() => resolve()))
}

async function requestCron({ fetchImpl, baseUrl, secret, timeoutMs }) {
  const controller = new AbortController()
  const timer = globalThis.setTimeout(() => controller.abort(), timeoutMs)
  const startedAt = Date.now()
  try {
    const response = await fetchImpl(`${baseUrl}${CRON_PATH}`, { method: 'GET', headers: buildVercelCronHeaders(secret), signal: controller.signal })
    const body = await response.text()
    let payload
    try { payload = body ? JSON.parse(body) : null } catch { throw new CronSimulationError('cron_response_invalid', 'cron response is not valid JSON') }
    if (response.status !== 202) throw new CronSimulationError('cron_http_status', `cron endpoint returned HTTP ${response.status}`)
    return { status: response.status, durationMs: Math.max(0, Date.now() - startedAt), data: payload?.data ?? null }
  } catch (error) {
    if (error instanceof CronSimulationError) throw error
    if (error?.name === 'AbortError') throw new CronSimulationError('cron_request_timeout', 'cron request exceeded the simulation timeout')
    throw new CronSimulationError('cron_request_failed', 'cron request failed')
  } finally {
    globalThis.clearTimeout(timer)
  }
}

function scopedIngestionQueue(baseQueue, allowedIds) {
  const isAllowed = (candidate) => allowedIds.has(String(candidate?.id)) || allowedIds.has(String(candidate?.parentJobId))
  return Object.freeze({
    ...baseQueue,
    selectDue: async (input = {}) => {
      const candidate = await baseQueue.selectDue(input)
      if (candidate && !isAllowed(candidate)) throw new CronSimulationError('cron_simulation_scope_escape', 'due-work selected a job outside the target batch')
      return candidate
    },
    claimAndExecute: async (input = {}) => {
      if (!isAllowed(input.candidate)) throw new CronSimulationError('cron_simulation_scope_escape', 'due-work attempted a job outside the target batch')
      return baseQueue.claimAndExecute(input)
    },
  })
}

async function createEmbeddedCronRunner({ context, runtimeConfig, period, allowedIds }) {
  const jobRepository = new MongoJobRepository(context)
  const leaseRepository = new MongoLeaseRepository(context)
  const executor = createConfiguredIngestionExecutor({
    context,
    providerRegistry: runtimeConfig.providerRegistry,
    safeFetch: createSafeFetch(),
  })
  const queue = scopedIngestionQueue(createIngestionQueueAdapter({
    jobRepository,
    leaseRepository,
    executor,
    trace: createRuntimeTracer({ enabled: false }),
  }), allowedIds)
  const queueRegistry = createQueueRegistry()
  queueRegistry.register(queue)
  const coordinatorRunner = createCoordinatorRunner({
    queueRegistry,
    maxJobs: 200,
    maxRecoveries: 3,
    budgetMs: 240_000,
  })
  const materializationRepository = {
    materializeDailyIngestion: async ({ signal } = {}) => {
      signal?.throwIfAborted?.()
      return { inspected: 0, created: 0, hasMore: false, period }
    },
  }
  return createCronDueWorkRunner({
    jobRepository: materializationRepository,
    coordinatorRunner,
    now: () => new Date(),
    trace: createRuntimeTracer({ enabled: false }),
    runIdFactory: () => `cron-sim-${randomUUID()}`,
  })
}

export async function runSimulation({ options = parseSimulationArgs([]), environment = process.env, fetchImpl = globalThis.fetch } = {}) {
  configureDns()
  if (!options || options.help) return { ok: true, help: true }
  const runtimeConfig = validateRuntimeConfiguration(environment)
  if (options.confirm && options.confirmDatabase !== runtimeConfig.mongo.database) throw new CronSimulationError('cron_simulation_database_mismatch', 'confirm-database does not match the configured runtime database')
  const context = await getMongoContext(runtimeConfig, environment)
  let server
  try {
    const initialDocuments = await readInitialBatch(context.db, options.period)
    const initial = assertInitialBatch(initialDocuments.map(serializeJobState), options)
    const initialBacklog = await nonTerminalCount(context.db)
    if (initialBacklog !== initial.total) throw new CronSimulationError('cron_simulation_backlog_changed', 'non-terminal ingestion backlog is not exactly the requested target batch')
    const before = initialDocuments.map(serializeJobState)
    if (!options.confirm) return { ok: true, mode: 'preflight', period: options.period, initial: { ...initial, statusCounts: statusCounts(initialDocuments) }, before }

    const secret = resolveMachineSecret(environment, runtimeConfig)
    const cronRunner = await createEmbeddedCronRunner({ context, runtimeConfig, period: options.period, allowedIds: new Set(initial.ids) })
    server = createServer(createApp({ dueWorkRunner: cronRunner, machineSecret: secret }))
    const baseUrl = await listen(server)
    const request = await requestCron({ fetchImpl, baseUrl, secret, timeoutMs: options.timeoutMs })
    const targetIds = initialDocuments.map((document) => document._id)
    const finalDocuments = await readJobsByIds(context.db, targetIds)
    const linkedRetries = await readLinkedRetries(context.db, targetIds)
    const finalSummary = summarizeJobs(finalDocuments.map(serializeJobState))
    const retrySummary = summarizeJobs(linkedRetries.map(serializeJobState))
    const pendingTarget = finalDocuments.filter((document) => NON_TERMINAL.includes(document.status)).map(serializeJobState)
    const pendingRetries = linkedRetries.filter((document) => NON_TERMINAL.includes(document.status)).map(serializeJobState)
    return {
      ok: pendingTarget.length === 0 && pendingRetries.length === 0,
      mode: 'embedded-http',
      period: options.period,
      request: { url: `${baseUrl}${CRON_PATH}`, status: request.status, durationMs: request.durationMs, userAgent: 'vercel-cron/1.0' },
      cronResponse: request.data,
      before: { ...initial, statusCounts: statusCounts(initialDocuments), jobs: before },
      after: { ...finalSummary, statusCounts: statusCounts(finalDocuments), jobs: finalDocuments.map(serializeJobState) },
      linkedRetries: { ...retrySummary, statusCounts: statusCounts(linkedRetries), jobs: linkedRetries.map(serializeJobState) },
      pendingTarget,
      pendingRetries,
      nonTerminalBacklogAfter: await nonTerminalCount(context.db),
    }
  } finally {
    await closeServer(server)
    await closeMongoConnection()
  }
}

function safeError(error) {
  const code = typeof error?.code === 'string' && /^[a-z0-9_:-]{1,128}$/i.test(error.code) ? error.code : 'cron_simulation_failed'
  return { ok: false, code, type: error?.name ?? 'Error' }
}

export async function main(argv = process.argv.slice(2), { environment = process.env, log = console.log, errorLog = console.error } = {}) {
  try {
    const options = parseSimulationArgs(argv)
    if (options.help) { log(SIMULATION_USAGE); return { ok: true, help: true } }
    const result = await runSimulation({ options, environment })
    log(JSON.stringify(result))
    if (!result.ok) process.exitCode = 1
    return result
  } catch (error) {
    errorLog(JSON.stringify(safeError(error)))
    process.exitCode = 1
    return null
  } finally {
    try { await closeMongoConnection() } catch { /* best effort */ }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main()
