import { randomBytes } from 'node:crypto'
import { deriveLeaseKey } from '../domain/jobs/lease-keys.js'
import { monotonicNow, runtimeFailure, settleBeforeDeadline, settleWithinGrace } from './runtime-bounds.js'
import { safeEvent } from './runtime-trace.js'

function safeOutcomeError(error, now) {
  if (!error) return undefined
  return {
    code: typeof error.code === 'string' && /^[a-z0-9_:-]{1,128}$/.test(error.code) ? error.code : 'worker_failed',
    message: 'Indexing job did not complete safely', retryable: Boolean(error.retryable) || error.code === 'lease_fence_stale', occurredAt: now,
    ...(Number.isInteger(error.upstreamStatus) && error.upstreamStatus >= 100 && error.upstreamStatus <= 599 ? { upstreamStatus: error.upstreamStatus } : {}),
  }
}

const MIN_DEFER_MS = 1_000
const MAX_DEFER_MS = 15 * 60 * 1_000
const DEFAULT_DEFER_MS = 5 * 60 * 1_000
const FINALIZATION_GRACE_MS = 5_000

function validDate(value, label) {
  const result = value instanceof Date ? new Date(value) : new Date(value)
  if (Number.isNaN(result.getTime())) throw new Error(`${label} is invalid`)
  return result
}

function deadlineError() {
  return runtimeFailure('indexing_deadline_exceeded', 'Indexing execution deadline was exceeded')
}

function finalizationError() {
  return runtimeFailure('indexing_finalization_unresolved', 'Indexing terminal outcome could not be finalized')
}

function finalizationTraceStatus(error) {
  return ['indexing_deadline_exceeded', 'indexing_finalization_unresolved'].includes(error?.code) ? 'timeout' : 'failed'
}
function boundedFinalizationDeadline() {
  return new Date(Date.now() + FINALIZATION_GRACE_MS)
}

async function runBoundedMutation(operation, { errorFactory = finalizationError } = {}) {
  const controller = new globalThis.AbortController()
  const finalizationDeadline = boundedFinalizationDeadline()
  const operationPromise = Promise.resolve().then(() => operation({ signal: controller.signal, deadline: finalizationDeadline }))
  const settled = await settleWithinGrace(operationPromise, FINALIZATION_GRACE_MS, { onTimeout: () => controller.abort(errorFactory()) })
  if (settled.kind === 'operation' && settled.settled) return settled.value
  if (settled.kind === 'operation') throw settled.error ?? errorFactory()
  throw errorFactory()
}

async function releaseLease({ leaseRepository, fence, ownerToken }) {
  if (typeof leaseRepository?.release !== 'function') return false
  const settled = await runBoundedMutation(
    ({ signal, deadline }) => leaseRepository.release({ ...fence, ownerToken, signal, deadline }),
  )
  return Boolean(settled)
}

async function deferJob({ jobRepository, candidate, fence, delayMs, incrementAttempt }) {
  if (typeof jobRepository?.deferWithFence !== 'function') throw finalizationError()
  return runBoundedMutation(
    ({ signal, deadline }) => jobRepository.deferWithFence({ jobId: candidate.id, fence, delayMs, signal, deadline, ...(incrementAttempt === undefined ? {} : { incrementAttempt }) }),
  )
}

function deferDelayMs(value) {
  const seconds = Number(value)
  if (!Number.isFinite(seconds) || seconds <= 0) return DEFAULT_DEFER_MS
  return Math.max(MIN_DEFER_MS, Math.min(MAX_DEFER_MS, Math.ceil(seconds * 1_000)))
}

function externalAttempts(error) {
  if (Number.isInteger(error?.externalAttempts) && error.externalAttempts >= 0) return error.externalAttempts
  if (Number.isInteger(error?.metadata?.externalAttempts) && error.metadata.externalAttempts >= 0) return error.metadata.externalAttempts
  return undefined
}

function shouldDeferOutcome(outcome, candidate) {
  const executionAttempt = Number.isInteger(candidate?.attempt) && candidate.attempt > 0 ? candidate.attempt : 1
  if (outcome?.status === 'deferred') return executionAttempt < 3
  const attempts = externalAttempts(outcome?.error)
  const durableRecovery = outcome?.error?.durableRecovery === true
  return Boolean(outcome?.error?.retryable) && (attempts === undefined || attempts === 0) && (executionAttempt < 3 || durableRecovery)
}

function shouldIncrementAttempt(error) {
  return error?.durableRecovery !== true
}

function leaseHeartbeatError() {
  return Object.assign(new Error('Indexing lease heartbeat was lost'), {
    code: 'lease_heartbeat_lost',
    retryable: true,
  })
}
function leaseHeartbeatUnavailableError() {
  return runtimeFailure('lease_heartbeat_unavailable', 'Indexing lease heartbeat could not be verified', true)
}
function isLeaseLost(error) {
  return ['lease_heartbeat_lost', 'lease_heartbeat_unavailable'].includes(error?.code)
}

function startLeaseHeartbeat({ leaseRepository, fence, ownerToken, leaseMs, deadline, onLost }) {
  const controller = new globalThis.AbortController()
  if (typeof leaseRepository?.heartbeat !== 'function') return { signal: controller.signal, abort: (reason) => controller.abort(reason), stop() {} }
  const intervalMs = Math.max(100, Math.floor(Number(leaseMs) / 3) || 100)
  let stopped = false
  let inFlight = false
  const timer = globalThis.setInterval(() => {
    if (stopped || inFlight || controller.signal.aborted) return
    inFlight = true
    Promise.resolve()
      .then(() => leaseRepository.heartbeat({ key: fence.key, jobId: fence.jobId, leaseGeneration: fence.leaseGeneration, ownerToken, leaseMs, signal: controller.signal, ...(deadline ? { deadline } : {}) }))
      .then((owned) => {
        if (owned !== true && !controller.signal.aborted) {
          const error = leaseHeartbeatError()
          try { onLost?.(error) } catch { /* telemetry cannot change job outcomes */ }
          controller.abort(error)
        }
      })
      .catch(() => {
        if (!controller.signal.aborted) {
          const error = leaseHeartbeatUnavailableError()
          try { onLost?.(error) } catch { /* telemetry cannot change job outcomes */ }
          controller.abort(error)
        }
      })
      .finally(() => { inFlight = false })
  }, intervalMs)
  timer.unref?.()
  return {
    signal: controller.signal,
    abort: (reason) => controller.abort(reason),
    stop() { stopped = true; globalThis.clearInterval(timer); controller.abort() },
  }
}

export function createIndexingQueueAdapter({ jobRepository, leaseRepository, executor, leaseMs = 30_000, ownerToken = () => randomBytes(32).toString('hex'), trace = () => {} } = {}) {
  if (!jobRepository || !leaseRepository) throw new Error('Indexing job and lease repositories are required')
  const emitTrace = typeof trace === 'function' ? (event) => {
    try { trace(safeEvent(event, () => new Date())) } catch { /* telemetry cannot change job outcomes */ }
  } : () => {}
  return Object.freeze({
    queueName: 'indexing',
    recoveryStrategy: 'terminal-parent-linked-retry',
    selectDue: ({ now, task, tasks, excludeArticleIds, jobIds, sourceId, expectedSourcePolicyVersion, actorScope, trigger, signal, deadline } = {}) => jobRepository.selectDueIndexing({ now, task, tasks, excludeArticleIds, jobIds, sourceId, expectedSourcePolicyVersion, actorScope, trigger, ...(signal ? { signal } : {}), ...(deadline ? { deadline } : {}) }),
    recoverExpired: ({ now, limit, signal, deadline } = {}) => jobRepository.recoverExpiredIndexing({ leaseRepository, now, limit, ...(signal ? { signal } : {}), ...(deadline ? { deadline } : {}) }),
    nextAvailableAt: (input = {}) => jobRepository.nextAvailableAt(input),
    async claimAndExecute({ candidate, now = new Date(), deadline, signal, runId } = {}) {
      if (signal?.aborted) return { status: 'deferred', claimed: false }
      const startedAt = validDate(now, 'Indexing admission time')
      const deadlineAt = deadline === undefined ? null : validDate(deadline, 'Indexing deadline')
      const admissionStartedAt = monotonicNow()
      const admissionWallStartedAt = Date.now()
      const remainingAdmissionMs = () => deadlineAt === null
        ? Number.POSITIVE_INFINITY
        : Math.max(0, deadlineAt.getTime() - startedAt.getTime() - Math.max(0, monotonicNow() - admissionStartedAt, Date.now() - admissionWallStartedAt))
      const token = ownerToken()
      if (remainingAdmissionMs() === 0) return { status: 'deferred', claimed: false }

      const acquireController = new globalThis.AbortController()
      signal?.addEventListener?.('abort', () => acquireController.abort(signal.reason), { once: true })
      const acquireOperation = Promise.resolve().then(() => leaseRepository.acquire({ key: deriveLeaseKey('indexing', candidate.articleId), jobId: candidate.id, ownerToken: token, now: startedAt, leaseMs, signal: acquireController.signal, ...(deadlineAt ? { deadline: deadlineAt } : {}) }))
      const acquired = await settleBeforeDeadline(acquireOperation, remainingAdmissionMs(), {
        timeoutError: deadlineError,
        onTimeout: (error) => acquireController.abort(error),
        onLate: (result) => result.settled && result.value
          ? releaseLease({ leaseRepository, fence: result.value, ownerToken: token })
          : undefined,
      })
      if (acquired.kind === 'deadline') return { status: 'deferred', claimed: false }
      if (!acquired.settled) {
        if (acquired.error?.status === 409 && acquired.error?.code === 'conflict') return { status: 'deferred', claimed: false }
        if (acquired.error?.code === 'indexing_deadline_exceeded' || remainingAdmissionMs() === 0) return { status: 'deferred', claimed: false }
        throw acquired.error
      }
      const fence = acquired.value
      if (remainingAdmissionMs() === 0) {
        await releaseLease({ leaseRepository, fence, ownerToken: token })
        return { status: 'deferred', claimed: false }
      }

      const buildTraceContext = (generation = fence.leaseGeneration) => Object.freeze({
        runId,
        queueName: 'indexing',
        task: candidate.task,
        jobId: String(candidate.id),
        articleId: String(candidate.articleId),
        sourceId: candidate.sourceId ? String(candidate.sourceId) : undefined,
        leaseGeneration: generation,
        ...(deadlineAt ? { deadlineAt } : {}),
      })
      const claimController = new globalThis.AbortController()
      signal?.addEventListener?.('abort', () => claimController.abort(signal.reason), { once: true })
      const claimOperation = Promise.resolve().then(() => jobRepository.claimQueuedWithFence({ jobId: candidate.id, fence, signal: claimController.signal, ...(deadlineAt ? { deadline: deadlineAt } : {}) }))
      const claimedResult = await settleBeforeDeadline(claimOperation, remainingAdmissionMs(), {
        timeoutError: deadlineError,
        onTimeout: (error) => claimController.abort(error),
        onLate: (result) => result.settled && result.value
          ? deferJob({ jobRepository, candidate, fence, delayMs: DEFAULT_DEFER_MS })
          : releaseLease({ leaseRepository, fence, ownerToken: token }),
      })
      if (claimedResult.kind === 'deadline') {
        return { status: 'deferred', claimed: false }
      }
      if (!claimedResult.settled) {
        await releaseLease({ leaseRepository, fence, ownerToken: token })
        if (claimedResult.error?.status !== 409 || claimedResult.error?.code !== 'conflict') {
          if (claimedResult.error?.code === 'indexing_deadline_exceeded' || remainingAdmissionMs() === 0) return { status: 'deferred', claimed: false }
          throw claimedResult.error
        }
        return { status: 'deferred', claimed: false }
      }
      const claimed = claimedResult.value
      const traceContext = buildTraceContext(fence.leaseGeneration)
      if (remainingAdmissionMs() === 0) {
        if (claimed) {
          emitTrace({ ...traceContext, stage: 'indexing.claim', status: 'succeeded' })
          emitTrace({ ...traceContext, stage: 'indexing.deadline', status: 'timeout', error: deadlineError() })
          await deferJob({ jobRepository, candidate, fence, delayMs: DEFAULT_DEFER_MS })
          emitTrace({ ...traceContext, stage: 'indexing.completion', status: 'deferred', error: deadlineError() })
          return { status: 'deferred', claimed: true }
        }
        await releaseLease({ leaseRepository, fence, ownerToken: token })
        return { status: 'deferred', claimed: false }
      }
      if (!claimed) {
        await releaseLease({ leaseRepository, fence, ownerToken: token })
        return { status: 'deferred', claimed: false }
      }
      emitTrace({ ...traceContext, stage: 'indexing.claim', status: 'succeeded' })
      const deferAndTrace = async ({ delayMs, incrementAttempt, error, includeRetryAfter = false } = {}) => {
        let deferred
        try {
          deferred = await deferJob({ jobRepository, candidate, fence, delayMs, incrementAttempt })
        } catch (deferError) {
          emitTrace({ ...traceContext, stage: 'indexing.executor', status: 'failed', error: deferError })
          emitTrace({ ...traceContext, stage: 'indexing.completion', status: 'failed', error: deferError })
          throw deferError
        }
        const status = deferred?.status === 'cancelled' ? 'partial' : 'deferred'
        emitTrace({ ...traceContext, stage: 'indexing.executor', status, ...(error ? { error } : {}) })
        emitTrace({ ...traceContext, stage: 'indexing.completion', status, ...(error ? { error } : {}) })
        return { status, claimed: true, ...(includeRetryAfter ? { retryAfterSeconds: Math.ceil(delayMs / 1_000) } : {}) }
      }


      if (typeof executor !== 'function') {
        return deferAndTrace({ delayMs: DEFAULT_DEFER_MS })
      }
      const cancellationRequested = typeof jobRepository.cancellationRequestedWithFence === 'function'
        && await runBoundedMutation(({ signal, deadline: operationDeadline }) => jobRepository.cancellationRequestedWithFence({ jobId: candidate.id, fence, signal, deadline: operationDeadline }))
      if (cancellationRequested) {
        emitTrace({ ...traceContext, stage: 'indexing.executor', status: 'cancelled' })
        try {
          await runBoundedMutation(({ signal, deadline: operationDeadline }) => jobRepository.completeWithFence({ jobId: candidate.id, fence, status: 'cancelled', signal, deadline: operationDeadline }))
        } catch (error) {
          emitTrace({ ...traceContext, stage: 'indexing.completion', status: finalizationTraceStatus(error), error })
          throw error
        }
        emitTrace({ ...traceContext, stage: 'indexing.completion', status: 'cancelled' })
        return { status: 'partial', claimed: true }
      }
      const heartbeat = startLeaseHeartbeat({ leaseRepository, fence, ownerToken: token, leaseMs, ...(deadlineAt ? { deadline: deadlineAt } : {}), onLost: (error) => {
        emitTrace({ ...traceContext, stage: 'indexing.heartbeat', status: 'failed', error })
      } })
      signal?.addEventListener?.('abort', () => heartbeat.abort(signal.reason), { once: true })
      try {
        let outcome
        try {
          const executionOperation = Promise.resolve().then(() => executor({
            job: { ...candidate, leaseGeneration: fence.leaseGeneration },
            fence,
            ownerToken: token,
            now: startedAt,
            deadline: deadlineAt ?? deadline,
            signal: heartbeat.signal,
          }))
          const execution = await settleBeforeDeadline(executionOperation, deadlineAt ? Math.max(0, deadlineAt.getTime() - Date.now()) : Number.POSITIVE_INFINITY, {
            timeoutError: deadlineError,
            onTimeout: (error) => heartbeat.abort(error),
          })
          if (execution.kind === 'deadline') throw execution.error
          if (!execution.settled) throw execution.error
          outcome = execution.value
          emitTrace({ ...traceContext, stage: 'indexing.executor', status: outcome?.status ?? 'succeeded' })
        } catch (error) {
          if (isLeaseLost(heartbeat.signal.reason ?? error)) throw heartbeat.signal.reason ?? error
          if (error?.code === 'indexing_deadline_exceeded') {
            emitTrace({ ...traceContext, stage: 'indexing.deadline', status: 'timeout', error })
            outcome = { status: 'failed', error: { code: 'indexing_deadline_exceeded', retryable: false } }
            emitTrace({ ...traceContext, stage: 'indexing.executor', status: 'timeout', error: outcome.error })
          } else if (shouldDeferOutcome({ error }, candidate)) {
            const delayMs = deferDelayMs(error.retryAfterSeconds)
            return deferAndTrace({ delayMs, incrementAttempt: shouldIncrementAttempt(error), error, includeRetryAfter: true })
          } else {
            outcome = { status: 'failed', error: { code: error?.code ?? 'worker_failed', retryable: Boolean(error?.retryable), upstreamStatus: error?.upstreamStatus } }
            emitTrace({ ...traceContext, stage: 'indexing.executor', status: 'failed', error: outcome.error })
          }
        }
        if (isLeaseLost(heartbeat.signal.reason)) throw heartbeat.signal.reason
        if (shouldDeferOutcome(outcome, candidate)) {
          const delayMs = deferDelayMs(outcome.retryAfterSeconds ?? outcome.error?.retryAfterSeconds)
          return deferAndTrace({ delayMs, incrementAttempt: shouldIncrementAttempt(outcome.error), error: outcome.error, includeRetryAfter: true })
        }
        const status = ['succeeded', 'partial', 'failed', 'cancelled'].includes(outcome?.status) ? outcome.status : 'failed'
        const finishedAt = new Date()
        try {
          await runBoundedMutation(({ signal, deadline: operationDeadline }) => jobRepository.completeWithFence({ jobId: candidate.id, fence, status, error: safeOutcomeError(outcome?.error, finishedAt), inputHash: outcome?.inputHash, signal, deadline: operationDeadline }))
        } catch (error) {
          emitTrace({ ...traceContext, stage: 'indexing.completion', status: finalizationTraceStatus(error), error })
          throw error
        }
        emitTrace({ ...traceContext, stage: 'indexing.completion', status, error: outcome?.error })
        return { status: status === 'cancelled' ? 'partial' : status, claimed: true }
      } finally {
        heartbeat.stop()
      }
    },
  })
}
