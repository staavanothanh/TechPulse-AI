import { randomUUID } from 'node:crypto'

const KINDS = new Set(['summary', 'embedding', 'answer-primary', 'answer-fallback', 'answer-support'])

export class ProviderBoundaryError extends Error {
  constructor(code, message, { retryAfterSeconds, retryable = true } = {}) {
    super(message)
    this.name = 'ProviderBoundaryError'
    this.status = 503
    this.code = code
    this.retryable = retryable
    if (retryAfterSeconds) this.retryAfterSeconds = retryAfterSeconds
  }
}

function capabilityAllows(actual, required) {
  return actual === 'zdr-verified' || actual === required
}

export function createProviderAdmission({ repository, registry, now = () => new Date(), reservationId = randomUUID, reservationTtlMs = 60_000 } = {}) {
  if (!repository || typeof repository.reserveProviderCall !== 'function' || typeof repository.releaseProviderCall !== 'function') throw new Error('Provider admission repository is required')
  const domains = new Map((registry?.domains ?? []).map((domain) => [domain.admissionDomainId, domain]))
  const routes = new Map((registry?.routes ?? []).map((route) => [route.routeId, route]))
  return Object.freeze({
    async run({ routeId, capability = 'nonconfidential', attemptId, kind, units = 1, invoke } = {}) {
      const route = routes.get(routeId)
      const domain = route ? domains.get(route.admissionDomainId) : null
      const reservedAt = now()
      const evidenceExpiresAt = route?.evidenceExpiresAt ? new Date(route.evidenceExpiresAt) : null
      if (!route || !domain || route.enabled !== true || !capabilityAllows(route.capability, capability) || capability === 'zdr-verified' && (!evidenceExpiresAt || Number.isNaN(evidenceExpiresAt.getTime()) || evidenceExpiresAt <= reservedAt) || !KINDS.has(kind) || typeof invoke !== 'function') throw new ProviderBoundaryError('provider_unavailable', 'No eligible AI provider route is available', { retryable: false })
      const id = reservationId()
      const reservation = await repository.reserveProviderCall({
        domain, route, reservationId: id, attemptId, kind, units,
        now: reservedAt, expiresAt: new Date(reservedAt.getTime() + reservationTtlMs),
      })
      if (!reservation?.allowed) throw new ProviderBoundaryError('provider_unavailable', 'AI provider is temporarily unavailable', { retryAfterSeconds: reservation?.retryAfterSeconds })
      try {
        if (capability === 'zdr-verified' && evidenceExpiresAt <= now()) {
          const error = new ProviderBoundaryError('provider_unavailable', 'Current private provider evidence has expired', { retryable: false })
          error.releaseCode = 'provider_evidence_expired'
          throw error
        }
        const result = await invoke(route)
        await repository.releaseProviderCall({ admissionDomainId: domain.admissionDomainId, routeId, reservationId: id, outcome: 'succeeded', now: now() })
        return result
      } catch (error) {
        await repository.releaseProviderCall({
          admissionDomainId: domain.admissionDomainId, routeId, reservationId: id,
          outcome: error?.retryable === true ? 'retryable-failure' : 'nonretryable-failure',
          errorCode: typeof error?.releaseCode === 'string' ? error.releaseCode : typeof error?.code === 'string' ? error.code.slice(0, 128) : 'provider_failed', now: now(),
        })
        if (error?.name === 'EvidenceSelectionError' && ['policy-blocked', 'insufficient-evidence'].includes(error.code)) {
          error.message = error.code === 'policy-blocked' ? 'Provider input is no longer permitted' : 'Provider evidence is no longer sufficient'
          throw error
        }
        if (error?.name === 'PrivacyAdmissionError' && ['sensitive-input', 'provider-unavailable'].includes(error.code)) {
          error.message = error.code === 'sensitive-input' ? 'Provider input cannot be processed safely' : 'Current private provider route is unavailable'
          throw error
        }
        throw new ProviderBoundaryError('provider_unavailable', 'AI provider is temporarily unavailable', { retryable: error?.retryable === true })
      }
    },
  })
}
