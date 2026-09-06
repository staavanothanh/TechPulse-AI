import { randomUUID } from 'node:crypto'
import { ProviderAdapterError } from './provider-error-taxonomy.js'

const KINDS = new Set(['summary', 'embedding', 'answer-primary', 'answer-fallback', 'answer-support'])

export class ProviderBoundaryError extends ProviderAdapterError {
  constructor(code, message, { retryAfterSeconds, retryable = true, failureClass = 'config', providerDomainOutcome } = {}) {
    super(failureClass, { retryAfterSeconds })
    this.name = 'ProviderBoundaryError'
    this.message = message
    this.status = 503
    this.code = code
    this.retryable = retryable
    if (providerDomainOutcome) this.providerDomainOutcome = providerDomainOutcome
    if (retryAfterSeconds) this.retryAfterSeconds = retryAfterSeconds
  }
}

function capabilityAllows(actual, required) {
  return actual === 'zdr-verified' || actual === required
}

function deadlineAt(value) {
  if (value === undefined || value === null) return undefined
  const date = value instanceof Date ? value : new Date(value)
  return Number.isNaN(date.getTime()) ? undefined : date.getTime()
}

function executionUnavailable({ signal, deadline, now }) {
  if (signal?.aborted) return true
  const deadlineValue = deadlineAt(deadline)
  const current = now()
  return deadlineValue !== undefined && current instanceof Date && current.getTime() >= deadlineValue
}

function cancellationError() {
  return new ProviderAdapterError('policy', { localControl: true })
}

function assertExecutionAvailable(context) {
  if (executionUnavailable(context)) throw cancellationError()
}
function awaitExecution(operation, context, onLateResult) {
  assertExecutionAvailable(context)
  const signal = context.signal
  const deadline = deadlineAt(context.deadline)
  if (!signal && deadline === undefined) return Promise.resolve().then(operation)
  return new Promise((resolve, reject) => {
    let settled = false
    let timer
    const finish = (callback, value) => {
      if (settled) return
      settled = true
      if (timer) globalThis.clearTimeout(timer)
      signal?.removeEventListener?.('abort', onAbort)
      callback(value)
    }
    const observeLateResult = (value) => {
      if (typeof onLateResult !== 'function') return
      void Promise.resolve().then(() => onLateResult(value)).catch(() => {})
    }
    const onAbort = () => finish(reject, cancellationError())
    signal?.addEventListener?.('abort', onAbort, { once: true })
    if (executionUnavailable(context)) { onAbort(); return }
    if (deadline !== undefined) {
      const current = context.now()
      const remaining = current instanceof Date ? deadline - current.getTime() : 0
      if (remaining <= 0) { onAbort(); return }
      timer = globalThis.setTimeout(onAbort, remaining)
      timer.unref?.()
    }
    const operationPromise = Promise.resolve().then(operation)
    operationPromise.then(
      (value) => {
        if (settled) {
          observeLateResult(value)
          return
        }
        finish(resolve, value)
      },
      (error) => {
        if (!settled) finish(reject, error)
      },
    )
  })
}

export function createProviderAdmission({
  repository,
  failureDomainRepository,
  registry,
  now = () => new Date(),
  reservationId = randomUUID,
  providerDomainReservationId = randomUUID,
  reservationTtlMs = 60_000,
} = {}) {
  if (!repository || typeof repository.reserveProviderCall !== 'function' || typeof repository.releaseProviderCall !== 'function') throw new Error('Provider admission repository is required')
  const domains = new Map((registry?.domains ?? []).map((domain) => [domain.admissionDomainId, domain]))
  const routes = new Map((registry?.routes ?? []).map((route) => [route.routeId, route]))
  const failureDomains = new Map((registry?.providerFailureDomains ?? []).map((domain) => [domain.providerFailureDomainId, domain]))
  const admitFailureDomain = failureDomainRepository?.admitProviderDomain ?? failureDomainRepository?.admitProviderCall
  const reportFailureDomain = failureDomainRepository?.reportProviderDomain ?? failureDomainRepository?.recordProviderCallOutcome
  if (failureDomains.size > 0 && (typeof admitFailureDomain !== 'function' || typeof reportFailureDomain !== 'function')) throw new Error('Provider failure-domain repository is required')
  return Object.freeze({
    getRoute(routeId) {
      return routes.get(routeId) ?? null
    },
    async admitProviderDomain({ routeId, attemptId, signal, deadline } = {}) {
      const context = { signal, deadline, now }
      assertExecutionAvailable(context)
      const route = routes.get(routeId)
      const domain = route ? failureDomains.get(route.providerFailureDomainId) : null
      if (!route) return { allowed: false, reason: 'route-unavailable' }
      if (!domain) return failureDomains.size === 0 ? { allowed: true } : { allowed: false, reason: 'provider-domain-unavailable' }
      if (typeof attemptId !== 'string' || attemptId.length < 1) return { allowed: false, reason: 'attempt-invalid' }
      const id = providerDomainReservationId()
      let result
      let reported = false
      const reportCancelled = async () => {
        if (reported) return
        reported = true
        await reportFailureDomain.call(failureDomainRepository, { domain, reservationId: id, outcome: 'cancelled', now: now() })
      }
      const observeLateAdmission = async (admission) => {
        if (admission?.allowed) await reportCancelled()
      }
      try {
        result = await awaitExecution(() => admitFailureDomain.call(failureDomainRepository, { domain, reservationId: id, now: now(), signal, deadline }), context, observeLateAdmission)
        assertExecutionAvailable(context)
      } catch (error) {
        if (executionUnavailable(context)) {
          if (result?.allowed) await reportCancelled().catch(() => {})
          throw cancellationError()
        }
        throw error
      }
      if (result?.allowed) return Object.freeze({ allowed: true, reservationId: id })
      return Object.freeze({
        allowed: false,
        reason: result?.reason === 'provider-domain-open' ? result.reason : 'provider-domain-unavailable',
        ...(Number.isInteger(result?.retryAfterSeconds) && result.retryAfterSeconds > 0 ? { retryAfterSeconds: result.retryAfterSeconds } : {}),
      })
    },
    async reportProviderDomain({ routeId, reservationId: id, outcome } = {}) {
      const route = routes.get(routeId)
      const domain = route ? failureDomains.get(route.providerFailureDomainId) : null
      if (!domain) return failureDomains.size === 0
      if (typeof id !== 'string' || id.length < 1 || !['succeeded', 'model-retryable-failure', 'provider-retryable-failure', 'terminal-failure', 'cancelled'].includes(outcome)) throw new Error('Provider failure-domain outcome is invalid')
      return reportFailureDomain.call(failureDomainRepository, { domain, reservationId: id, outcome, now: now() })
    },
    async run({ routeId, capability = 'nonconfidential', attemptId, kind, units = 1, invoke, signal, deadline } = {}) {
      const context = { signal, deadline, now }
      assertExecutionAvailable(context)
      const route = routes.get(routeId)
      const domain = route ? domains.get(route.admissionDomainId) : null
      const reservedAt = now()
      const evidenceExpiresAt = route?.evidenceExpiresAt ? new Date(route.evidenceExpiresAt) : null
      if (!route || !domain || route.enabled !== true || !KINDS.has(kind) || typeof invoke !== 'function') throw new ProviderBoundaryError('provider_unavailable', 'No eligible AI provider route is available', { retryable: false })
      if (!capabilityAllows(route.capability, capability)) throw new ProviderBoundaryError('provider_unavailable', 'No eligible AI provider route is available', { retryable: false, failureClass: 'privacy' })
      if (capability === 'zdr-verified' && (!evidenceExpiresAt || Number.isNaN(evidenceExpiresAt.getTime()) || evidenceExpiresAt <= reservedAt)) throw new ProviderBoundaryError('provider_unavailable', 'No eligible AI provider route is available', { retryable: false })
      const id = reservationId()
      let reserved = false
      const release = async ({ outcome, errorCode } = {}) => {
        if (!reserved) return
        reserved = false
        await repository.releaseProviderCall({
          admissionDomainId: domain.admissionDomainId, routeId, reservationId: id, outcome,
          ...(errorCode ? { errorCode } : {}), now: now(),
        })
      }
      const observeLateReservation = async (reservation) => {
        if (!reservation?.allowed) return
        reserved = true
        await release({ outcome: 'cancelled', errorCode: 'execution_cancelled' })
      }
      const reservation = await awaitExecution(() => repository.reserveProviderCall({
        domain, route, reservationId: id, attemptId, kind, units,
        now: reservedAt, expiresAt: new Date(reservedAt.getTime() + reservationTtlMs), signal, deadline,
      }), context, observeLateReservation)
      if (!reservation?.allowed) throw new ProviderBoundaryError('provider_unavailable', 'AI provider is temporarily unavailable', { retryAfterSeconds: reservation?.retryAfterSeconds, failureClass: 'provider-retryable', providerDomainOutcome: 'terminal-failure' })
      reserved = true
      try {
        assertExecutionAvailable(context)
        if (capability === 'zdr-verified' && evidenceExpiresAt <= now()) {
          const error = new ProviderBoundaryError('provider_unavailable', 'Current private provider evidence has expired', { retryable: false })
          error.releaseCode = 'provider_evidence_expired'
          throw error
        }
        const result = await invoke(route)
        assertExecutionAvailable(context)
        await release({ outcome: 'succeeded' })
        return result
      } catch (error) {
        const cancelled = executionUnavailable(context)
        const localControl = cancelled || error instanceof ProviderAdapterError && error.providerLocalControl === true
        await release({
          outcome: localControl ? 'cancelled' : error?.retryable === true ? 'retryable-failure' : 'nonretryable-failure',
          errorCode: cancelled ? 'execution_cancelled' : typeof error?.releaseCode === 'string' ? error.releaseCode : typeof error?.code === 'string' ? error.code.slice(0, 128) : 'provider_failed',
        }).catch(() => {})
        if (cancelled) throw cancellationError()
        if (localControl) throw error
        if (error?.name === 'EvidenceSelectionError' && ['policy-blocked', 'insufficient-evidence'].includes(error.code)) {
          error.message = error.code === 'policy-blocked' ? 'Provider input is no longer permitted' : 'Provider evidence is no longer sufficient'
          throw error
        }
        if (error?.name === 'PrivacyAdmissionError' && ['sensitive-input', 'provider-unavailable'].includes(error.code)) {
          error.message = error.code === 'sensitive-input' ? 'Provider input cannot be processed safely' : 'Current private provider route is unavailable'
          throw error
        }
        if (error instanceof ProviderAdapterError) throw error
        throw new ProviderBoundaryError('provider_unavailable', 'AI provider is temporarily unavailable', { retryable: false, failureClass: 'ambiguous' })
      }
    },
  })
}
