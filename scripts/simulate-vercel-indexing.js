import { createServer } from 'node:http'
import { randomUUID } from 'node:crypto'
import { pathToFileURL } from 'node:url'

import { createApp } from '../server/app.js'
import { validateRuntimeConfiguration } from '../server/config/runtime.js'
import { configureDns } from './configure-dns.js'
import {
  closeConfiguredRuntime,
  createConfiguredRuntime,
  runForceDrain,
} from './force-drain-overdue.js'
import {
  INDEXING_JOB_LIST_PROJECTION,
  serializeIndexingJob,
} from '../server/repositories/mongo/indexing-job-repository.js'
import { closeMongoConnection, getMongoContext } from '../server/repositories/mongo/connection.js'

export const INDEXING_CRON_PATH = '/api/internal/cron/due-work'
export const DEFAULT_EXPECTED_QUEUED = 345
export const DEFAULT_EXPECTED_RUNNING = 0
export const DEFAULT_MAX_CLAIMS = 200
export const DEFAULT_MAX_INVOCATIONS = 2
export const DEFAULT_TIMEOUT_MS = 300_000
export const DEFAULT_DRAIN_BUDGET_MS = 240_000
export const MAX_TARGET_JOBS = 5_000
export const SIMULATION_USAGE = 'Usage: node --env-file-if-exists=../../.env scripts/simulate-vercel-indexing.js [--confirm --confirm-database=techpulse_app] [--expected-queued=345] [--expected-running=0] [--max-claims=200] [--max-invocations=2] [--timeout-ms=300000]'

const MIN_TIMEOUT_MS = DEFAULT_DRAIN_BUDGET_MS + 30_000
const MAX_TIMEOUT_MS = 300_000
const MAX_INVOCATIONS = 25
const DATABASE_NAME = /^[A-Za-z0-9][A-Za-z0-9_]{0,62}$/
const NON_TERMINAL = new Set(['queued', 'running'])
const TERMINAL = new Set(['succeeded', 'partial', 'failed', 'cancelled'])
const EMPTY_COUNTERS = Object.freeze({ claimed: 0, succeeded: 0, partial: 0, failed: 0, deferred: 0 })

export class IndexingSimulationError extends Error {
  constructor(code, message) {
    super(message)
    this.name = 'IndexingSimulationError'
    this.code = code
  }
}

function parseInteger(value, name, minimum, maximum) {
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new IndexingSimulationError('indexing_simulation_arguments_invalid', `${name} is outside the safe bound`)
  }
  return parsed
}

function optionValue(argument, argv, index, option) {
  const prefix = `${option}=`
  if (argument.startsWith(prefix)) return { value: argument.slice(prefix.length), nextIndex: index }
  if (argument === option && argv[index + 1] !== undefined) return { value: argv[index + 1], nextIndex: index + 1 }
  throw new IndexingSimulationError('indexing_simulation_arguments_invalid', `${option} requires a value`)
}

function databaseName(value) {
  if (typeof value !== 'string' || !DATABASE_NAME.test(value)) {
    throw new IndexingSimulationError('indexing_simulation_arguments_invalid', 'confirm-database is invalid')
  }
  return value
}

export function parseIndexingSimulationArgs(argv = []) {
  const options = {
    confirm: false,
    confirmDatabase: null,
    expectedQueued: DEFAULT_EXPECTED_QUEUED,
    expectedRunning: DEFAULT_EXPECTED_RUNNING,
    maxClaims: DEFAULT_MAX_CLAIMS,
    maxInvocations: DEFAULT_MAX_INVOCATIONS,
    timeoutMs: DEFAULT_TIMEOUT_MS,
  }
  if (!Array.isArray(argv)) throw new IndexingSimulationError('indexing_simulation_arguments_invalid', 'arguments must be an array')
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]
    if (argument === '--help' || argument === '-h') return { help: true }
    if (argument === '--confirm') {
      if (options.confirm) throw new IndexingSimulationError('indexing_simulation_arguments_invalid', 'confirm flag is duplicated')
      options.confirm = true
      continue
    }
    const numericOptions = [
      ['--expected-queued', 'expectedQueued', 0, MAX_TARGET_JOBS],
      ['--expected-running', 'expectedRunning', 0, MAX_TARGET_JOBS],
      ['--max-claims', 'maxClaims', 1, DEFAULT_MAX_CLAIMS],
      ['--max-invocations', 'maxInvocations', 1, MAX_INVOCATIONS],
      ['--timeout-ms', 'timeoutMs', MIN_TIMEOUT_MS, MAX_TIMEOUT_MS],
    ]
    const numeric = typeof argument === 'string' ? numericOptions.find(([option]) => argument.startsWith(option) || argument === option) : undefined
    if (numeric) {
      const [option, field, minimum, maximum] = numeric
      const selected = optionValue(argument, argv, index, option)
      index = selected.nextIndex
      options[field] = parseInteger(selected.value, field.replace(/[A-Z]/g, (match) => `-${match.toLowerCase()}`), minimum, maximum)
      continue
    }
    if (typeof argument === 'string' && (argument.startsWith('--confirm-database') || argument === '--confirm-database')) {
      const selected = optionValue(argument, argv, index, '--confirm-database')
      index = selected.nextIndex
      if (options.confirmDatabase !== null) throw new IndexingSimulationError('indexing_simulation_arguments_invalid', 'confirm-database is duplicated')
      options.confirmDatabase = databaseName(selected.value)
      continue
    }
    throw new IndexingSimulationError('indexing_simulation_arguments_invalid', `unknown option: ${argument}`)
  }
  if (options.expectedQueued + options.expectedRunning > MAX_TARGET_JOBS) {
    throw new IndexingSimulationError('indexing_simulation_arguments_invalid', 'expected indexing job count is outside the safe bound')
  }
  return Object.freeze(options)
}

export function buildVercelCronHeaders(secret) {
  if (typeof secret !== 'string' || secret.length === 0) {
    throw new IndexingSimulationError('cron_secret_missing', 'cron bearer secret is missing')
  }
  return Object.freeze({
    Accept: 'application/json',
    Authorization: `Bearer ${secret}`,
    'User-Agent': 'vercel-cron/1.0',
  })
}

export function summarizeIndexingJobs(rows = []) {
  const counts = rows.reduce((result, row) => {
    const status = row?.status
    if (status === 'queued') result.queued += 1
    else if (status === 'running') result.running += 1
    else if (TERMINAL.has(status)) result.terminal += 1
    return result
  }, { total: 0, queued: 0, running: 0, terminal: 0 })
  return { ...counts, total: rows.length }
}

export function assertInitialIndexingBatch(rows, { expectedQueued, expectedRunning } = {}) {
  const summary = summarizeIndexingJobs(rows)
  if (summary.queued !== expectedQueued || summary.running !== expectedRunning || summary.total !== expectedQueued + expectedRunning) {
    throw new IndexingSimulationError('indexing_simulation_initial_state_mismatch', `initial starting state must contain ${expectedQueued} queued and ${expectedRunning} running indexing jobs`)
  }
  const ids = rows.map((row) => String(row.id ?? row._id ?? ''))
  if (ids.some((id) => id.length === 0) || new Set(ids).size !== ids.length) {
    throw new IndexingSimulationError('indexing_simulation_initial_state_mismatch', 'initial indexing job identifiers are invalid')
  }
  return { ids, total: summary.total, queued: summary.queued, running: summary.running }
}

function iso(value) {
  return value instanceof Date ? value.toISOString() : value ?? null
}

function serializeError(error) {
  if (!error) return null
  return {
    code: error.code ?? null,
    message: error.message ?? null,
    retryable: Boolean(error.retryable),
    occurredAt: iso(error.occurredAt),
    ...(error.upstreamStatus === undefined ? {} : { upstreamStatus: error.upstreamStatus }),
  }
}

function serializeIndexingJobState(document) {
  const serialized = serializeIndexingJob(document)
  return {
    id: serialized.id,
    articleId: serialized.articleId,
    sourceId: serialized.sourceId,
    expectedSourcePolicyVersion: serialized.expectedSourcePolicyVersion,
    task: serialized.task,
    status: serialized.status,
    attempt: serialized.attempt,
    availableAt: iso(serialized.availableAt),
    startedAt: iso(serialized.startedAt),
    finishedAt: iso(serialized.finishedAt),
    heartbeatAt: iso(serialized.heartbeatAt),
    leaseGeneration: serialized.leaseGeneration,
    error: serializeError(serialized.error),
  }
}

function statusCounts(rows) {
  return rows.reduce((result, row) => ({ ...result, [row.status]: (result[row.status] ?? 0) + 1 }), {})
}

function errorCounts(rows) {
  return rows.reduce((result, row) => {
    const code = row.error?.code
    if (code) result[code] = (result[code] ?? 0) + 1
    return result
  }, {})
}

export function summarizeIndexingOutcome({ requestError = null, pendingTarget = [], finalSummary = {}, nonTerminalBacklogAfter = 0 } = {}) {
  const terminalUnsuccessful = Number(finalSummary.failed ?? 0) + Number(finalSummary.partial ?? 0) + Number(finalSummary.cancelled ?? 0)
  const drained = requestError === null && pendingTarget.length === 0 && nonTerminalBacklogAfter === 0
  return { drained, terminalUnsuccessful, ok: drained && terminalUnsuccessful === 0 }
}

async function readInitialBatch(db) {
  return db.collection('indexingJobs')
    .find({ status: { $in: [...NON_TERMINAL] } }, { projection: INDEXING_JOB_LIST_PROJECTION, maxTimeMS: 5_000 })
    .sort({ createdAt: 1, _id: 1 })
    .limit(MAX_TARGET_JOBS + 1)
    .toArray()
}

async function readJobsByIds(db, ids) {
  if (ids.length === 0) return []
  return db.collection('indexingJobs')
    .find({ _id: { $in: ids } }, { projection: INDEXING_JOB_LIST_PROJECTION, maxTimeMS: 5_000 })
    .sort({ createdAt: 1, _id: 1 })
    .toArray()
}

async function nonTerminalCount(db) {
  return db.collection('indexingJobs').countDocuments({ status: { $in: [...NON_TERMINAL] } }, { maxTimeMS: 5_000 })
}

function resolveMachineSecret(environment, runtimeConfig) {
  const name = runtimeConfig.internalMachineSecretEnv
  const secret = typeof name === 'string' ? environment[name] : undefined
  if (typeof secret !== 'string' || secret.length === 0) {
    throw new IndexingSimulationError('cron_secret_missing', 'configured cron bearer secret is missing')
  }
  return secret
}

function listen(server) {
  return new Promise((resolve, reject) => {
    const onError = (error) => {
      server.removeListener('listening', onListening)
      reject(error)
    }
    const onListening = () => {
      server.removeListener('error', onError)
      const address = server.address()
      if (!address || typeof address === 'string') return reject(new Error('embedded indexing server address is unavailable'))
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
    const response = await fetchImpl(`${baseUrl}${INDEXING_CRON_PATH}`, {
      method: 'GET',
      headers: buildVercelCronHeaders(secret),
      signal: controller.signal,
    })
    const body = await response.text()
    let payload
    try {
      payload = body ? JSON.parse(body) : null
    } catch {
      throw new IndexingSimulationError('cron_response_invalid', 'cron response is not valid JSON')
    }
    if (response.status !== 202) throw new IndexingSimulationError('cron_http_status', `cron endpoint returned HTTP ${response.status}`)
    return { status: response.status, durationMs: Math.max(0, Date.now() - startedAt), data: payload?.data ?? null }
  } catch (error) {
    if (error instanceof IndexingSimulationError) throw error
    if (error?.name === 'AbortError') throw new IndexingSimulationError('cron_request_timeout', 'cron request exceeded the simulation timeout')
    throw new IndexingSimulationError('cron_request_failed', 'cron request failed')
  } finally {
    globalThis.clearTimeout(timer)
  }
}

function zeroQueues() {
  return { ingestion: { ...EMPTY_COUNTERS }, accountDeletion: { ...EMPTY_COUNTERS } }
}

function createEmbeddedIndexingRunner({ runtime, environment, database, targetIds, maxClaims }) {
  const scope = { jobIds: targetIds }
  let invocation = 0
  return async () => {
    invocation += 1
    const result = await runForceDrain({
      options: {
        confirm: true,
        dryRun: false,
        confirmDatabase: database,
        maxClaims,
        budgetMs: DEFAULT_DRAIN_BUDGET_MS,
      },
      environment,
      runtime,
      scope,
    })
    const queues = zeroQueues()
    queues.indexing = result.counters
    return {
      runId: `cron-indexing-sim-${invocation}-${randomUUID()}`,
      startedAt: result.startedAt,
      finishedAt: result.finishedAt,
      recovery: { inspected: 0, recovered: 0, retriesCreated: 0, failed: 0 },
      queues,
      nextAvailableAt: result.nextAvailableAt,
    }
  }
}

function safeRequestError(error) {
  return {
    code: typeof error?.code === 'string' ? error.code : 'cron_request_failed',
    type: error?.name ?? 'Error',
  }
}

export async function runIndexingSimulation({ options = parseIndexingSimulationArgs([]), environment = process.env, fetchImpl = globalThis.fetch } = {}) {
  configureDns()
  if (!options || options.help) return { ok: true, help: true }
  const runtimeConfig = validateRuntimeConfiguration(environment)
  if (options.confirm && options.confirmDatabase !== runtimeConfig.mongo.database) {
    throw new IndexingSimulationError('indexing_simulation_database_mismatch', 'confirm-database does not match the configured runtime database')
  }
  const context = await getMongoContext(runtimeConfig, environment)
  let server
  let configuredRuntime
  try {
    const initialDocuments = await readInitialBatch(context.db)
    const initial = assertInitialIndexingBatch(initialDocuments.map(serializeIndexingJobState), options)
    const initialBacklog = await nonTerminalCount(context.db)
    if (initialBacklog !== initial.total) {
      throw new IndexingSimulationError('indexing_simulation_backlog_changed', 'non-terminal indexing backlog is not exactly the requested target batch')
    }
    const targetIds = initialDocuments.map((document) => document._id)
    const beforeJobs = initialDocuments.map(serializeIndexingJobState)
    if (!options.confirm) {
      return {
        ok: true,
        mode: 'preflight',
        target: { ...initial, statusCounts: statusCounts(beforeJobs), errorCounts: errorCounts(beforeJobs) },
        before: beforeJobs,
      }
    }

    const secret = resolveMachineSecret(environment, runtimeConfig)
    configuredRuntime = await createConfiguredRuntime({ environment })
    const dueWorkRunner = createEmbeddedIndexingRunner({
      runtime: configuredRuntime,
      environment,
      database: runtimeConfig.mongo.database,
      targetIds: initial.ids,
      maxClaims: options.maxClaims,
    })
    server = createServer(createApp({ dueWorkRunner, machineSecret: secret }))
    const baseUrl = await listen(server)
    const requests = []
    const afterInvocations = []
    let requestError = null

    for (let index = 0; index < options.maxInvocations; index += 1) {
      try {
        const request = await requestCron({ fetchImpl, baseUrl, secret, timeoutMs: options.timeoutMs })
        const currentDocuments = await readJobsByIds(context.db, targetIds)
        const currentJobs = currentDocuments.map(serializeIndexingJobState)
        requests.push({ invocation: index + 1, ...request })
        afterInvocations.push({
          invocation: index + 1,
          summary: summarizeIndexingJobs(currentJobs),
          statusCounts: statusCounts(currentJobs),
          errorCounts: errorCounts(currentJobs),
          nonTerminal: currentJobs.filter((job) => NON_TERMINAL.has(job.status)).length,
        })
        if (afterInvocations.at(-1).nonTerminal === 0) break
      } catch (error) {
        requestError = safeRequestError(error)
        break
      }
    }

    const finalDocuments = await readJobsByIds(context.db, targetIds)
    const finalJobs = finalDocuments.map(serializeIndexingJobState)
    const finalSummary = summarizeIndexingJobs(finalJobs)
    const pendingTarget = finalJobs.filter((job) => NON_TERMINAL.has(job.status))
    const nonTerminalBacklogAfter = await nonTerminalCount(context.db)
    const outcome = summarizeIndexingOutcome({ requestError, pendingTarget, finalSummary, nonTerminalBacklogAfter })
    return {
      ...outcome,
      mode: 'embedded-http-indexing',
      request: { url: `${baseUrl}${INDEXING_CRON_PATH}`, userAgent: 'vercel-cron/1.0', invocations: requests },
      requestError,
      target: { ...initial, statusCounts: statusCounts(beforeJobs), errorCounts: errorCounts(beforeJobs) },
      before: beforeJobs,
      afterInvocations,
      after: { ...finalSummary, statusCounts: statusCounts(finalJobs), errorCounts: errorCounts(finalJobs), jobs: finalJobs },
      pendingTarget,
      nonTerminalBacklogAfter,
    }
  } finally {
    await closeServer(server)
    await closeConfiguredRuntime(configuredRuntime)
    await closeMongoConnection()
  }
}

function safeError(error) {
  const code = typeof error?.code === 'string' && /^[a-z0-9_:-]{1,128}$/i.test(error.code) ? error.code : 'indexing_simulation_failed'
  return { ok: false, code, type: error?.name ?? 'Error' }
}

export async function main(argv = process.argv.slice(2), { environment = process.env, log = console.log, errorLog = console.error } = {}) {
  try {
    const options = parseIndexingSimulationArgs(argv)
    if (options.help) {
      log(SIMULATION_USAGE)
      return { ok: true, help: true }
    }
    const result = await runIndexingSimulation({ options, environment })
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
