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
      if (!route || !domain || route.enabled !== true || !capabilityAllows(route.capability, capability) || !KINDS.has(kind) || typeof invoke !== 'function') throw new ProviderBoundaryError('provider_unavailable', 'No eligible AI provider route is available', { retryable: false })
      const reservedAt = now()
      const id = reservationId()
      const reservation = await repository.reserveProviderCall({
        domain, route, reservationId: id, attemptId, kind, units,
        now: reservedAt, expiresAt: new Date(reservedAt.getTime() + reservationTtlMs),
      })
      if (!reservation?.allowed) throw new ProviderBoundaryError('provider_unavailable', 'AI provider is temporarily unavailable', { retryAfterSeconds: reservation?.retryAfterSeconds })
      try {
        const result = await invoke(route)
        await repository.releaseProviderCall({ admissionDomainId: domain.admissionDomainId, routeId, reservationId: id, outcome: 'succeeded', now: now() })
        return result
      } catch (error) {
        await repository.releaseProviderCall({
          admissionDomainId: domain.admissionDomainId, routeId, reservationId: id,
          outcome: error?.retryable === true ? 'retryable-failure' : 'nonretryable-failure',
          errorCode: typeof error?.code === 'string' ? error.code.slice(0, 128) : 'provider_failed', now: now(),
        })
        throw new ProviderBoundaryError('provider_unavailable', 'AI provider is temporarily unavailable', { retryable: error?.retryable === true })
      }
    },
  })
}
