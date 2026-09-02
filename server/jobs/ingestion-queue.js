import { randomBytes } from 'node:crypto'
import { deriveLeaseKey } from '../domain/jobs/lease-keys.js'
import { safeErrorCode, safeEvent, startRuntimePhase } from './runtime-trace.js'
import { monotonicNow, runtimeFailure, settleBeforeDeadline, settleWithinGrace } from './runtime-bounds.js'

const DEFAULT_EXECUTION_TIMEOUT_MS = 5 * 60 * 1000
const DEFAULT_FINALIZATION_GRACE_MS = 1_000
const MAX_EXECUTION_TIMEOUT_MS = 15 * 60 * 1000
const ADMISSION_DEFER_MS = 5 * 60 * 1000

function safeOutcomeError(error, now) {
  if (!error) return undefined
  const code = safeErrorCode(error.code)
  return {
    code,
    message: 'Ingestion job did not complete safely',
    retryable: Boolean(error.retryable) || code === 'lease_fence_stale',
    occurredAt: error.occurredAt instanceof Date && !Number.isNaN(error.occurredAt.getTime()) ? new Date(error.occurredAt) : now,
    ...(Number.isInteger(error.upstreamStatus) && error.upstreamStatus >= 100 && error.upstreamStatus <= 599 ? { upstreamStatus: error.upstreamStatus } : {}),
  }
}


function unresolvedFinalization() {
  return runtimeFailure('ingestion_finalization_unresolved', 'Ingestion terminal outcome could not be finalized')
}
async function attemptOrphanFinalization({ jobRepository, candidate, fence, error, reportStage, maxWaitMs = 0, deadline }) {
  const finishedAt = new Date()
  const finalizationDeadline = boundedFinalizationDeadline(deadline, maxWaitMs)
  reportStage({ stage: 'ingestion.orphan_finalization', status: 'started' })
  if (typeof jobRepository.finalizeOrphanedAttempt === 'function') {
    const controller = new globalThis.AbortController()
    try {
      const operation = Promise.resolve().then(() => jobRepository.finalizeOrphanedAttempt({ jobId: candidate.id, fence, error: safeOutcomeError(error, finishedAt), now: finishedAt, signal: controller.signal, deadline: finalizationDeadline }))
      const settled = await settleWithinGrace(operation, maxWaitMs, { onTimeout: () => controller.abort(unresolvedFinalization()) })
      if (settled.kind === 'operation' && settled.settled && settled.value) {
        reportStage({ stage: 'ingestion.orphan_finalization', status: 'succeeded' })
        return true
      }
      if (settled.kind === 'grace') controller.abort(unresolvedFinalization())
      if (settled.kind === 'operation' && !settled.settled) throw settled.error
    } catch (finalizationError) {
      reportStage({ stage: 'ingestion.orphan_finalization', status: 'failed', error: { code: safeErrorCode(finalizationError?.code), retryable: Boolean(finalizationError?.retryable) } })
      return false
    }
  }
  reportStage({ stage: 'ingestion.orphan_finalization', status: 'failed', error: unresolvedFinalization() })
  return false
}
function validDate(value, label) {
  const result = value instanceof Date ? new Date(value) : new Date(value)
  if (Number.isNaN(result.getTime())) throw new Error(`${label} is invalid`)
  return result
}
function boundedFinalizationDeadline(deadline, graceMs) {
  const requested = deadline === undefined ? 0 : validDate(deadline, 'Ingestion finalization deadline').getTime()
  return new Date(Math.max(requested, Date.now() + Math.max(0, Number(graceMs))))
}

function validDuration(value, label, maximum = MAX_EXECUTION_TIMEOUT_MS) {
  if (!Number.isInteger(value) || value < 0 || value > maximum) throw new Error(`${label} is invalid`)
  return value
}


function startLeaseHeartbeat({ leaseRepository, fence, ownerToken, leaseMs, onLost, deadline }) {
  const controller = new globalThis.AbortController()
  if (typeof leaseRepository?.heartbeat !== 'function') return () => {}
  const intervalMs = Math.max(100, Math.floor(Number(leaseMs) / 3) || 100)
  let stopped = false
  let inFlight = false
  let lost = false
  const notifyLost = (reason = runtimeFailure('lease_heartbeat_lost', 'Ingestion lease ownership was lost', true)) => {
    if (stopped || lost) return
    lost = true
    onLost(reason)
  }
  const timer = globalThis.setInterval(() => {
    if (stopped || inFlight || lost || controller.signal.aborted) return
    inFlight = true
    Promise.resolve()
      .then(() => leaseRepository.heartbeat({ key: fence.key, jobId: fence.jobId, leaseGeneration: fence.leaseGeneration, ownerToken, leaseMs, signal: controller.signal, ...(deadline ? { deadline } : {}) }))
      .then((owned) => { if (owned !== true) notifyLost() })
      .catch(() => notifyLost(runtimeFailure('lease_heartbeat_unavailable', 'Ingestion lease heartbeat could not be verified', true)))
      .finally(() => { inFlight = false })
  }, intervalMs)
  timer.unref?.()
  return () => { stopped = true; globalThis.clearInterval(timer); controller.abort() }
}

async function releaseAcquiredLease({ leaseRepository, fence, ownerToken, maxWaitMs, deadline }) {
  if (typeof leaseRepository?.release !== 'function') return false
  const controller = new globalThis.AbortController()
  const finalizationDeadline = boundedFinalizationDeadline(deadline, maxWaitMs)
  const operation = Promise.resolve().then(() => leaseRepository.release({ ...fence, ownerToken, signal: controller.signal, deadline: finalizationDeadline }))
  const settled = await settleWithinGrace(operation, maxWaitMs, { onTimeout: () => controller.abort(unresolvedFinalization()) })
  return settled.kind === 'operation' && settled.settled
}

async function deferClaimedJobAfterDeadline({ jobRepository, candidate, fence, maxWaitMs, deadline }) {
  if (typeof jobRepository?.deferWithFence !== 'function') return false
  const controller = new globalThis.AbortController()
  const finalizationDeadline = boundedFinalizationDeadline(deadline, maxWaitMs)
  const operation = Promise.resolve().then(() => jobRepository.deferWithFence({ jobId: candidate.id, fence, delayMs: ADMISSION_DEFER_MS, signal: controller.signal, deadline: finalizationDeadline }))
  const settled = await settleWithinGrace(operation, maxWaitMs, { onTimeout: () => controller.abort(unresolvedFinalization()) })
  return settled.kind === 'operation' && settled.settled ? (settled.value ?? true) : false
}

async function runExecutor({ executor, input, controller, timeoutMs, finalizationGraceMs, onLeaseLost }) {
  let resolveLeaseLost
  const leaseLost = new Promise((resolve) => { resolveLeaseLost = resolve })
  const operation = Promise.resolve().then(() => executor(input))
  operation.catch(() => {})
  let deadlineTimer
  const deadline = new Promise((resolve) => {
    deadlineTimer = globalThis.setTimeout(() => {
      const error = runtimeFailure('ingestion_deadline_exceeded', 'Ingestion execution deadline was exceeded')
      controller.abort(error)
      resolve({ kind: 'deadline', error })
    }, timeoutMs)
  })
  const stopHeartbeat = onLeaseLost((reason) => {
    const safe = ['lease_heartbeat_lost', 'lease_heartbeat_unavailable'].includes(reason?.code)
      ? reason
      : runtimeFailure('lease_heartbeat_unavailable', 'Ingestion lease heartbeat could not be verified', true)
    controller.abort(safe)
    resolveLeaseLost({ kind: 'lease', error: safe })
  })
  try {
    const winner = await Promise.race([
      operation.then((value) => ({ kind: 'result', value }), (error) => ({ kind: 'error', error })),
      leaseLost,
      deadline,
    ])
    if (controller.signal.aborted && ['lease_heartbeat_lost', 'lease_heartbeat_unavailable'].includes(controller.signal.reason?.code)) throw controller.signal.reason
    if (winner.kind === 'lease') {
      await settleWithinGrace(operation, finalizationGraceMs)
      throw winner.error
    }
    if (winner.kind === 'deadline') {
      const settled = await settleWithinGrace(operation, finalizationGraceMs)
      if (settled.kind === 'operation' && ['lease_heartbeat_lost', 'lease_heartbeat_unavailable'].includes(settled.error?.code)) throw settled.error
      return { outcome: { status: 'failed', error: winner.error }, timedOut: true, stopHeartbeat }
    }
    if (winner.kind === 'error') return { outcome: { status: 'failed', error: winner.error }, timedOut: false, stopHeartbeat }
    return { outcome: winner.value, timedOut: false, stopHeartbeat }
  } catch (error) {
    if (['lease_heartbeat_lost', 'lease_heartbeat_unavailable'].includes(error?.code)) stopHeartbeat()
    throw error
  } finally {
    globalThis.clearTimeout(deadlineTimer)
  }
}

export function createIngestionQueueAdapter({
  jobRepository,
  leaseRepository,
  executor,
  leaseMs = 30_000,
  executionTimeoutMs = DEFAULT_EXECUTION_TIMEOUT_MS,
  finalizationGraceMs = DEFAULT_FINALIZATION_GRACE_MS,
  ownerToken = () => randomBytes(32).toString('hex'),
  trace = () => {},
} = {}) {
  if (!jobRepository || !leaseRepository) throw new Error('Job and lease repositories are required')
  if (!Number.isInteger(leaseMs) || leaseMs < 100 || leaseMs > 15 * 60 * 1000) throw new Error('Lease duration is invalid')
  validDuration(executionTimeoutMs, 'Ingestion execution timeout')
  const emitTrace = (event) => trace(safeEvent(event, () => new Date()))
  if (typeof trace !== 'function') throw new Error('Ingestion trace callback is required')
  return Object.freeze({
    queueName: 'ingestion',
    recoveryStrategy: 'terminal-parent-linked-retry',
    selectDue: ({ now, excludeSourceIds, signal, deadline } = {}) => jobRepository.selectDueIngestion({ now, excludeSourceIds, ...(signal ? { signal } : {}), ...(deadline ? { deadline } : {}) }),
    recoverExpired: ({ now, limit, signal, deadline } = {}) => jobRepository.recoverExpiredIngestion({ leaseRepository, now, limit, ...(signal ? { signal } : {}), ...(deadline ? { deadline } : {}) }),
    nextAvailableAt: (input = {}) => jobRepository.nextAvailableAt(input),
    async claimAndExecute({ candidate, now = new Date(), runId, deadline, signal, executionTimeoutMs: timeoutOverride, finalizationGraceMs: graceOverride } = {}) {
      if (signal?.aborted) return { status: 'deferred', claimed: false }
      const startedAt = validDate(now, 'Ingestion attempt time')
      const timeoutLimit = validDuration(timeoutOverride ?? executionTimeoutMs, 'Ingestion execution timeout')
      const grace = validDuration(graceOverride ?? finalizationGraceMs, 'Ingestion finalization grace', 60 * 1000)
      const deadlineAt = deadline === undefined ? new Date(startedAt.getTime() + timeoutLimit) : validDate(deadline, 'Ingestion deadline')
      const admissionStartedAt = monotonicNow()
      const admissionWallStartedAt = Date.now()
      const remainingAdmissionMs = () => Math.max(0, deadlineAt.getTime() - startedAt.getTime() - Math.max(0, monotonicNow() - admissionStartedAt, Date.now() - admissionWallStartedAt))
      const token = ownerToken()
      if (remainingAdmissionMs() === 0) return { status: 'deferred', claimed: false }
      const leaseKey = deriveLeaseKey('ingestion', candidate.sourceId)
      const acquireController = new globalThis.AbortController()
      signal?.addEventListener?.('abort', () => acquireController.abort(signal.reason), { once: true })
      const acquireOperation = Promise.resolve().then(() => leaseRepository.acquire({ key: leaseKey, jobId: candidate.id, ownerToken: token, now: startedAt, leaseMs, signal: acquireController.signal, deadline: deadlineAt }))
      const acquired = await settleBeforeDeadline(acquireOperation, remainingAdmissionMs(), {
        onTimeout: (error) => acquireController.abort(error),
        onLate: (result) => result.settled && result.value
          ? releaseAcquiredLease({ leaseRepository, fence: result.value, ownerToken: token, maxWaitMs: grace })
          : undefined,
      })
      if (acquired.kind === 'deadline') return { status: 'deferred', claimed: false }
      if (!acquired.settled) {
        if (acquired.error?.status === 409 && acquired.error?.code === 'conflict') return { status: 'deferred', claimed: false }
        if (acquired.error?.code === 'ingestion_deadline_exceeded' || remainingAdmissionMs() === 0) return { status: 'deferred', claimed: false }
        throw acquired.error
      }
      const fence = acquired.value
      if (remainingAdmissionMs() === 0) {
        await releaseAcquiredLease({ leaseRepository, fence, ownerToken: token, maxWaitMs: grace })
        return { status: 'deferred', claimed: false }
      }
      const claimController = new globalThis.AbortController()
      signal?.addEventListener?.('abort', () => claimController.abort(signal.reason), { once: true })
      const claimOperation = Promise.resolve().then(() => jobRepository.claimQueuedWithFence({ jobId: candidate.id, fence, signal: claimController.signal, deadline: deadlineAt }))
      const claimedResult = await settleBeforeDeadline(claimOperation, remainingAdmissionMs(), {
        onTimeout: (error) => claimController.abort(error),
        onLate: (result) => result.settled && result.value === true
          ? deferClaimedJobAfterDeadline({ jobRepository, candidate, fence, maxWaitMs: grace, deadline: deadlineAt })
          : releaseAcquiredLease({ leaseRepository, fence, ownerToken: token, maxWaitMs: grace }),
      })
      if (claimedResult.kind === 'deadline') {
        return { status: 'deferred', claimed: false }
      }
      if (!claimedResult.settled) {
        await releaseAcquiredLease({ leaseRepository, fence, ownerToken: token, maxWaitMs: grace })
        if (claimedResult.error?.status !== 409 || claimedResult.error?.code !== 'conflict') {
          if (claimedResult.error?.code === 'ingestion_deadline_exceeded' || remainingAdmissionMs() === 0) return { status: 'deferred', claimed: false }
          throw claimedResult.error
        }
        return { status: 'deferred', claimed: false }
      }
      const claimed = claimedResult.value
      if (remainingAdmissionMs() === 0) {
        if (claimed) {
          await deferClaimedJobAfterDeadline({ jobRepository, candidate, fence, maxWaitMs: grace })
          return { status: 'deferred', claimed: true }
        }
        await releaseAcquiredLease({ leaseRepository, fence, ownerToken: token, maxWaitMs: grace })
        return { status: 'deferred', claimed: false }
      }
      if (!claimed) {
        await releaseAcquiredLease({ leaseRepository, fence, ownerToken: token, maxWaitMs: grace })
        return { status: 'deferred', claimed: false }
      }
      const timeoutMs = Math.max(0, Math.min(timeoutLimit, remainingAdmissionMs()))
      const traceContext = Object.freeze({ runId, queueName: 'ingestion', jobId: String(candidate.id), sourceId: String(candidate.sourceId), leaseGeneration: fence.leaseGeneration, deadlineAt })
      emitTrace({ ...traceContext, stage: 'ingestion.claim', status: 'succeeded' })
      if (typeof executor !== 'function') {
        const deferred = await deferClaimedJobAfterDeadline({ jobRepository, candidate, fence, maxWaitMs: grace, deadline: deadlineAt })
        if (!deferred) throw unresolvedFinalization()
        return { status: deferred?.status === 'cancelled' ? 'partial' : 'deferred', claimed: true }
      }
      const controller = new globalThis.AbortController()
      signal?.addEventListener?.('abort', () => controller.abort(signal.reason), { once: true })
      const reportStage = (event) => emitTrace({ ...traceContext, ...event })
      const executorPhase = startRuntimePhase({
        trace: emitTrace,
        stage: 'ingestion.executor',
        now: () => new Date(),
        context: traceContext,
      })
      let execution
      let stopHeartbeatAfterRun
      try {
        if (timeoutMs === 0) {
          const error = runtimeFailure('ingestion_deadline_exceeded', 'Ingestion execution deadline was exceeded')
          controller.abort(error)
          execution = { outcome: { status: 'failed', error }, timedOut: true }
        } else {
          execution = await runExecutor({
            executor,
            input: { job: { ...candidate, leaseGeneration: fence.leaseGeneration }, fence, ownerToken: token, now: startedAt, runId, signal: controller.signal, deadline: deadlineAt, onStage: reportStage },
            controller,
            timeoutMs,
            finalizationGraceMs: grace,
            onLeaseLost: (onLost) => startLeaseHeartbeat({ leaseRepository, fence, ownerToken: token, leaseMs, deadline: deadlineAt, onLost: (error) => {
              reportStage({ stage: 'ingestion.heartbeat', status: 'failed', error })
              onLost(error)
            } }),
          })
          stopHeartbeatAfterRun = execution.stopHeartbeat
        }
        if (execution.timedOut) {
          reportStage({ stage: 'ingestion.deadline', status: 'timeout', error: execution.outcome.error })
          executorPhase.timeout(execution.outcome.error)
        } else if (['succeeded', 'partial', 'cancelled'].includes(execution.outcome?.status)) executorPhase.succeed({ counters: execution.outcome?.counters })
        else executorPhase.fail(execution.outcome?.error)
      } catch (error) {
        executorPhase.fail(error)
        if (error?.code === 'lease_heartbeat_lost') {
          if (await attemptOrphanFinalization({ jobRepository, candidate, fence, error, reportStage, maxWaitMs: grace, deadline: boundedFinalizationDeadline(deadlineAt, grace) })) return { status: 'failed', claimed: true }
          throw unresolvedFinalization()
        }
        if (error?.code === 'lease_heartbeat_unavailable') throw unresolvedFinalization()
        execution = { outcome: { status: 'failed', error: { code: error?.code ?? 'worker_failed', retryable: Boolean(error?.retryable), upstreamStatus: error?.upstreamStatus } }, timedOut: false }
      }
      const outcome = execution.outcome
      const status = ['succeeded', 'partial', 'failed', 'cancelled'].includes(outcome?.status) ? outcome.status : 'failed'
      const finishedAt = new Date()
      const finalizationDeadline = boundedFinalizationDeadline(deadlineAt, grace)
      const completionPhase = startRuntimePhase({ trace: emitTrace, stage: 'ingestion.completion', now: () => new Date(), context: traceContext })
      let completionTimedOut = false
      try {
        const completionController = new globalThis.AbortController()
        const completionOperation = Promise.resolve().then(() => jobRepository.completeWithFence({ jobId: candidate.id, fence, status, error: safeOutcomeError(outcome?.error, finishedAt), checkpoint: outcome?.checkpoint, counters: outcome?.counters, signal: completionController.signal, deadline: finalizationDeadline }))
        const completion = await settleWithinGrace(completionOperation, grace)
        if (completion.kind === 'grace') {
          completionTimedOut = true
          const unresolved = unresolvedFinalization()
          completionController.abort(unresolved)
          throw unresolved
        }
        if (!completion.settled) throw completion.error ?? unresolvedFinalization()
        const completed = completion.value
        completionPhase.succeed()
        const committedStatus = completed?.status ?? status
        return { status: committedStatus === 'cancelled' ? 'partial' : committedStatus, claimed: true }
      } catch (completionError) {
        if (completionTimedOut) {
          completionPhase.fail(completionError)
          throw completionError
        }
        if (completionError?.code === 'lease_heartbeat_lost') {
          const finalized = await attemptOrphanFinalization({ jobRepository, candidate, fence, error: completionError, reportStage, maxWaitMs: grace, deadline: finalizationDeadline })
          if (finalized) {
            completionPhase.succeed({ status: 'failed' })
            return { status: 'failed', claimed: true }
          }
        }
        const unresolved = unresolvedFinalization()
        completionPhase.fail(unresolved)
        throw unresolved
      } finally {
        stopHeartbeatAfterRun?.()
      }
    },
  })
}
