import { createHash } from 'node:crypto'
import { ObjectId } from 'mongodb'

const SAFE_TOKEN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/
const SAFE_CODE = /^[a-z0-9][a-z0-9_:-]{0,127}$/
const SAFE_ERROR_CODES = new Set([
  'ambiguous_provider_outcome', 'article_checkpoint_invalid', 'article_conflict', 'article_invalid', 'article_unavailable', 'artifact_commit_stale', 'artifact_failed', 'candidate_invalid', 'cleanup_incomplete', 'conflict', 'database_unavailable', 'embedding_compatibility_mismatch', 'embedding_unavailable', 'embedding_version_mismatch',
  'indexing_cancelled', 'indexing_task_invalid', 'ingestion_aborted', 'ingestion_clock_invalid', 'ingestion_deadline_exceeded', 'ingestion_deadline_invalid', 'ingestion_finalization_unresolved', 'indexing_finalization_unresolved', 'ingestion_completion_failed', 'indexing_deadline_exceeded', 'lease_expired', 'lease_fence_stale',
  'lease_heartbeat_lost', 'lease_heartbeat_unavailable', 'policy_blocked', 'policy_input_invalid', 'policy_version_mismatch', 'privacy_blocked', 'privacy_input_blocked', 'provider_config_invalid', 'provider_credential_unavailable', 'provider_domain_unavailable', 'provider_error', 'provider_failed', 'provider_http_error', 'provider_model_unavailable', 'provider_network_error', 'provider_response_invalid', 'provider_route_invalid', 'provider_schema_invalid', 'provider_support_invalid', 'provider_unavailable', 'reconciliation_failed', 'runtime_error', 'sensitive_input', 'service_unavailable', 'source_inactive', 'source_policy_invalid', 'source_policy_reconciliation_not_ready', 'source_scope_denied',
  'source_address_blocked', 'source_policy_changed_mid_run', 'source_policy_unavailable', 'source_content_host_blocked', 'source_content_type_rejected', 'source_decode_failed', 'source_decoded_limit', 'source_dns_empty', 'source_dns_failed', 'source_encoding_rejected', 'source_expansion_limit', 'source_fetch_aborted', 'source_fetch_failed', 'source_fetch_timeout', 'source_payload_rejected', 'source_redirect_rejected', 'source_upstream_status', 'source_url_rejected', 'source_wire_limit', 'source_policy_blocked', 'temporary_input_unavailable', 'worker_failed', 'worker_outcome_invalid',
])
const TRACE_COUNTERS = Object.freeze(['fetched', 'created', 'updated', 'duplicate', 'skipped', 'failed', 'claimed', 'succeeded', 'partial', 'deferred', 'inspected', 'recovered', 'retriesCreated'])
const NOOP_TRACE = () => {}
const MAX_PENDING_WRITES = 256
const EVENT_RETENTION_DAYS = 30
const DAY_MS = 24 * 60 * 60 * 1000

function integer(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : undefined
}

function token(value) {
  const result = String(value ?? '')
  return SAFE_TOKEN.test(result) ? result : undefined
}

function code(value) {
  const result = String(value ?? '')
  return SAFE_CODE.test(result) && SAFE_ERROR_CODES.has(result) ? result : 'runtime_error'
}
function sequence(value) {
  return Number.isInteger(value) && value >= 0 && value <= 2_147_483_647 ? value : undefined
}

function date(value, label) {
  const result = value instanceof Date ? new Date(value.getTime()) : new Date(value)
  if (Number.isNaN(result.getTime())) throw new Error(`${label} is invalid`)
  return result
}

function milliseconds(value, label) {
  const result = value instanceof Date ? value.getTime() : Number(value)
  if (!Number.isFinite(result)) throw new Error(`${label} is invalid`)
  return result
}

function safeCounters(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  const counters = Object.fromEntries(TRACE_COUNTERS
    .map((key) => [key, integer(value[key])])
    .filter(([, item]) => item !== undefined))
  return Object.keys(counters).length > 0 ? counters : undefined
}

function safeError(error) {
  if (!error) return {}
  const upstreamStatus = Number.isInteger(error.upstreamStatus) && error.upstreamStatus >= 100 && error.upstreamStatus <= 599
    ? error.upstreamStatus
    : undefined
  return {
    errorCode: code(error.code),
    ...(typeof error.retryable === 'boolean' ? { retryable: error.retryable } : {}),
    ...(upstreamStatus !== undefined ? { upstreamStatus } : {}),
  }
}

export function canonicalObservabilityEventId({
  runId = '',
  queueName = '',
  task = '',
  jobId = '',
  articleId = '',
  sourceId = '',
  sequence = '',
  leaseGeneration = '',
  stage = '',
  status = '',
  at = '',
  event = 'phase',
} = {}) {
  const payload = [event, runId, queueName, task, jobId, articleId, sourceId, sequence, leaseGeneration, stage, status, at].join('\u0000')
  return createHash('sha256').update(payload).digest('hex')
}

function safeEvent(event = {}, now = () => new Date()) {
  const input = event && typeof event === 'object' && !Array.isArray(event) ? event : {}
  const counters = safeCounters(input.counters)
  const eventAt = input.at !== undefined
    ? date(input.at, 'Runtime trace event time').toISOString()
    : date(now(), 'Runtime trace clock').toISOString()
  const eventName = token(input.event) ?? 'phase'
  const runId = token(input.runId)
  const queueName = token(input.queueName)
  const task = token(input.task)
  const jobId = token(input.jobId)
  const articleId = token(input.articleId)
  const sourceId = token(input.sourceId)
  const sourceKey = token(input.sourceKey)
  const leaseGeneration = integer(input.leaseGeneration)
  const stage = token(input.stage)
  const status = token(input.status)
  const eventSequence = sequence(input.sequence)
  const inputError = input.error ?? (input.errorCode !== undefined
    ? { code: input.errorCode, retryable: input.retryable, upstreamStatus: input.upstreamStatus }
    : undefined)
  const errorDetails = safeError(inputError)
  const eventId = typeof input.eventId === 'string' && /^[a-f0-9]{64}$/.test(input.eventId)
    ? input.eventId
    : canonicalObservabilityEventId({
      event: eventName,
      runId: runId ?? '',
      queueName: queueName ?? '',
      task: task ?? '',
      jobId: jobId ?? '',
      articleId: articleId ?? '',
      sequence: eventSequence ?? '',
      sourceId: sourceId ?? '',
      leaseGeneration: leaseGeneration ?? '',
      stage: stage ?? '',
      status: status ?? '',
      at: eventAt,
    })

  const payload = {
    type: 'techpulse.runtime-trace',
    version: 1,
    eventId,
    at: eventAt,
    event: eventName,
    ...(runId ? { runId } : {}),
    ...(queueName ? { queueName } : {}),
    ...(task ? { task } : {}),
    ...(jobId ? { jobId } : {}),
    ...(articleId ? { articleId } : {}),
    ...(sourceId ? { sourceId } : {}),
    ...(eventSequence !== undefined ? { sequence: eventSequence } : {}),
    ...(sourceKey ? { sourceKey } : {}),
    ...(leaseGeneration !== undefined ? { leaseGeneration } : {}),
    ...(integer(input.remainingClaims) !== undefined ? { remainingClaims: integer(input.remainingClaims) } : {}),
    ...(integer(input.profileMaxJobs) !== undefined ? { profileMaxJobs: integer(input.profileMaxJobs) } : {}),
    ...(stage ? { stage } : {}),
    ...(status ? { status } : {}),
    ...(integer(input.elapsedMs) !== undefined ? { elapsedMs: integer(input.elapsedMs) } : {}),
    ...(integer(input.batchSize) !== undefined ? { batchSize: integer(input.batchSize) } : {}),
    ...(integer(input.candidateCount) !== undefined ? { candidateCount: integer(input.candidateCount) } : {}),
    ...(input.deadlineAt !== undefined ? { deadlineAt: date(input.deadlineAt, 'Runtime trace deadline').toISOString() } : {}),
    ...(counters ? { counters } : {}),
    ...errorDetails,
  }
  return Object.freeze(payload)
}

export function createLifecycleEventDocument(eventInput = {}, now = () => new Date()) {
  const normalized = safeEvent(eventInput, now)
  const occurredAt = new Date(normalized.at)
  const purgeAfter = new Date(occurredAt.getTime() + EVENT_RETENTION_DAYS * DAY_MS)
  const errorObj = normalized.errorCode
    ? {
      code: normalized.errorCode,
      retryable: normalized.retryable ?? false,
      occurredAt,
      ...(normalized.upstreamStatus !== undefined ? { upstreamStatus: normalized.upstreamStatus } : {}),
    }
    : undefined
  const doc = {
    _id: new ObjectId(),
    eventId: normalized.eventId,
    version: normalized.version,
    occurredAt,
    eventType: normalized.event,
    stage: normalized.stage ?? 'unknown',
    status: normalized.status ?? 'unknown',
    purgeAfter,
    createdAt: occurredAt,
  }
  for (const key of ['runId', 'queueName', 'task', 'jobId', 'articleId', 'sourceId', 'sourceKey', 'sequence', 'leaseGeneration', 'remainingClaims', 'profileMaxJobs', 'elapsedMs']) {
    if (normalized[key] !== undefined) doc[key] = normalized[key]
  }
  if (normalized.counters) doc.counters = normalized.counters
  if (errorObj) doc.error = errorObj
  return doc
}

export function createRuntimeTracer({ log = console.info, now = () => new Date(), enabled = true, repository, onPersistenceDegraded = () => {} } = {}) {
  if (typeof log !== 'function') throw new Error('Runtime trace logger is required')
  if (typeof now !== 'function') throw new Error('Runtime trace clock is required')
  const pending = new Set()
  let persistenceHealthy = true
  let failedWriteCount = 0
  let droppedWriteCount = 0
  let degradationNotified = false
  const notifyPersistenceDegraded = () => {
    if (degradationNotified) return
    degradationNotified = true
    try { onPersistenceDegraded({ failedWriteCount, droppedWriteCount }) } catch { /* telemetry cannot change job outcomes */ }
  }
  const markPersistenceFailure = () => {
    persistenceHealthy = false
    failedWriteCount += 1
    notifyPersistenceDegraded()
  }
  const trace = (event = {}) => {
    if (enabled !== true) return
    let payload
    try {
      payload = safeEvent(event, now)
      log(JSON.stringify(payload))
    } catch {
      return
    }
    if (repository && typeof repository.recordLifecycleEvent === 'function') {
      if (pending.size >= MAX_PENDING_WRITES) {
        persistenceHealthy = false
        droppedWriteCount += 1
        notifyPersistenceDegraded()
        return
      }
      try {
        const operation = Promise.resolve(repository.recordLifecycleEvent(payload))
        pending.add(operation)
        operation.then((persisted) => {
          if (persisted !== true) markPersistenceFailure()
          pending.delete(operation)
        }, () => {
          markPersistenceFailure()
          pending.delete(operation)
        })
      } catch {
        markPersistenceFailure()
      }
    }
  }
  const flush = async ({ deadline, maxWaitMs = 1_000 } = {}) => {
    const deadlineMs = deadline === undefined ? Number.POSITIVE_INFINITY : date(deadline, 'Runtime trace flush deadline').getTime()
    const configuredWaitMs = Number(maxWaitMs)
    const waitMs = Number.isFinite(configuredWaitMs) ? Math.max(0, configuredWaitMs) : 1_000
    const availableMs = Number.isFinite(deadlineMs) ? Math.max(0, deadlineMs - Date.now()) : waitMs
    const expiresAt = Date.now() + Math.min(waitMs, availableMs)
    while (pending.size > 0 && Date.now() < expiresAt) {
      const waiting = Promise.allSettled([...pending])
      const remaining = Math.max(0, expiresAt - Date.now())
      if (remaining === 0) break
      await Promise.race([waiting, new Promise((resolve) => {
        const timer = globalThis.setTimeout(resolve, remaining)
        timer.unref?.()
      })])
    }
    return pending.size === 0 && persistenceHealthy
  }
  Object.defineProperties(trace, {
    flush: { value: flush },
    pendingCount: { get: () => pending.size },
    persistenceHealthy: { get: () => persistenceHealthy },
    failedWriteCount: { get: () => failedWriteCount },
    droppedWriteCount: { get: () => droppedWriteCount },
  })
  return trace
}

export async function flushRuntimeTrace(trace, options = {}) {
  if (typeof trace?.flush !== 'function') return true
  try {
    return await trace.flush(options)
  } catch {
    return false
  }
}

export function startRuntimePhase({ trace = NOOP_TRACE, stage, now = () => Date.now(), context = {} } = {}) {
  if (typeof trace !== 'function') throw new Error('Runtime trace callback is required')
  if (!token(stage)) throw new Error('Runtime trace stage is invalid')
  if (!context || typeof context !== 'object' || Array.isArray(context)) throw new Error('Runtime trace context is invalid')
  const startedAt = milliseconds(now(), 'Runtime phase clock')
  trace({ ...context, event: 'phase', stage, status: 'started' })
  const finish = (status, details = {}) => {
    const elapsedMs = Math.max(0, Math.floor(milliseconds(now(), 'Runtime phase clock') - startedAt))
    trace({ ...context, event: 'phase', stage, status, elapsedMs, ...details })
  }
  return Object.freeze({
    succeed: (details = {}) => finish('succeeded', details),
    fail: (error, details = {}) => finish('failed', { ...details, error }),
    timeout: (error, details = {}) => finish('timeout', { ...details, error }),
  })
}

export function reportRuntimeTraceDegraded({ failedWriteCount = 0, droppedWriteCount = 0 } = {}, log = console.warn) {
  if (typeof log !== 'function') return false
  try {
    log(JSON.stringify({ type: 'techpulse.runtime-trace-health', version: 1, status: 'degraded', failedWriteCount: integer(failedWriteCount) ?? 0, droppedWriteCount: integer(droppedWriteCount) ?? 0 }))
    return true
  } catch {
    return false
  }
}

export function safeErrorCode(value) {
  const result = String(value ?? '')
  return SAFE_CODE.test(result) && SAFE_ERROR_CODES.has(result) ? result : 'worker_failed'
}

export { SAFE_ERROR_CODES, safeCounters, safeError, safeEvent, sequence as safeSequence }
