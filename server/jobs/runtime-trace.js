const SAFE_TOKEN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/
const SAFE_CODE = /^[a-z0-9][a-z0-9_:-]{0,127}$/
const SAFE_ERROR_CODES = new Set([
  'article_checkpoint_invalid', 'article_conflict', 'article_invalid', 'candidate_invalid', 'conflict', 'database_unavailable', 'ingestion_aborted',
  'ingestion_clock_invalid', 'ingestion_deadline_exceeded', 'ingestion_deadline_invalid', 'ingestion_finalization_unresolved', 'indexing_finalization_unresolved', 'ingestion_completion_failed', 'lease_expired', 'lease_fence_stale',
  'lease_heartbeat_lost', 'lease_heartbeat_unavailable', 'policy_version_mismatch', 'provider_error', 'runtime_error', 'source_address_blocked', 'source_policy_changed_mid_run', 'source_policy_unavailable', 'source_content_host_blocked',
  'source_content_type_rejected', 'source_decode_failed', 'source_decoded_limit', 'source_dns_empty', 'source_dns_failed', 'source_encoding_rejected',
  'source_expansion_limit', 'source_fetch_aborted', 'source_fetch_failed', 'source_fetch_timeout', 'source_payload_rejected', 'source_redirect_rejected',
  'source_upstream_status', 'source_url_rejected', 'source_wire_limit', 'source_policy_blocked', 'worker_failed', 'worker_outcome_invalid',
])
const TRACE_COUNTERS = Object.freeze(['fetched', 'created', 'updated', 'duplicate', 'skipped', 'failed', 'claimed', 'succeeded', 'partial', 'deferred'])
const NOOP_TRACE = () => {}

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
  return {
    errorCode: code(error.code),
    ...(typeof error.retryable === 'boolean' ? { retryable: error.retryable } : {}),
  }
}

function safeEvent(event = {}, now = () => new Date()) {
  const input = event && typeof event === 'object' && !Array.isArray(event) ? event : {}
  const counters = safeCounters(input.counters)
  const payload = {
    type: 'techpulse.runtime-trace',
    version: 1,
    at: date(now(), 'Runtime trace clock').toISOString(),
    ...(token(input.event) ? { event: token(input.event) } : { event: 'phase' }),
    ...(token(input.runId) ? { runId: token(input.runId) } : {}),
    ...(token(input.queueName) ? { queueName: token(input.queueName) } : {}),
    ...(token(input.jobId) ? { jobId: token(input.jobId) } : {}),
    ...(token(input.sourceId) ? { sourceId: token(input.sourceId) } : {}),
    ...(token(input.sourceKey) ? { sourceKey: token(input.sourceKey) } : {}),
    ...(integer(input.leaseGeneration) !== undefined ? { leaseGeneration: integer(input.leaseGeneration) } : {}),
    ...(token(input.stage) ? { stage: token(input.stage) } : {}),
    ...(token(input.status) ? { status: token(input.status) } : {}),
    ...(integer(input.elapsedMs) !== undefined ? { elapsedMs: integer(input.elapsedMs) } : {}),
    ...(integer(input.batchSize) !== undefined ? { batchSize: integer(input.batchSize) } : {}),
    ...(integer(input.candidateCount) !== undefined ? { candidateCount: integer(input.candidateCount) } : {}),
    ...(input.deadlineAt !== undefined ? { deadlineAt: date(input.deadlineAt, 'Runtime trace deadline').toISOString() } : {}),
    ...(counters ? { counters } : {}),
  }
  return Object.freeze({ ...payload, ...safeError(input.error) })
}

export function createRuntimeTracer({ log = console.info, now = () => new Date(), enabled = true } = {}) {
  if (typeof log !== 'function') throw new Error('Runtime trace logger is required')
  if (typeof now !== 'function') throw new Error('Runtime trace clock is required')
  return (event = {}) => {
    if (enabled !== true) return
    log(JSON.stringify(safeEvent(event, now)))
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
export function safeErrorCode(value) {
  const result = String(value ?? '')
  return SAFE_CODE.test(result) && SAFE_ERROR_CODES.has(result) ? result : 'worker_failed'
}

export { safeCounters, safeError, safeEvent }
