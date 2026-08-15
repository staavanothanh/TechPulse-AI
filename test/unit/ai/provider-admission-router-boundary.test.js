import { describe, expect, it, vi } from 'vitest'
import { createProviderAdmission } from '../../../server/ai/provider-admission.js'
import { ProviderAdapterError } from '../../../server/ai/provider-error-taxonomy.js'

const route = Object.freeze({
  routeId: 'primary', providerId: 'provider-a', providerFailureDomainId: 'domain-a', admissionDomainId: 'admission-a',
  model: 'model-a', operations: Object.freeze(['answer']), capability: 'zdr-verified', enabled: true,
  evidenceExpiresAt: '2099-01-01T00:00:00.000Z',
})
const admissionDomain = Object.freeze({ admissionDomainId: 'admission-a', providerId: 'provider-a', maxConcurrency: 1, budgetLimit: 10, budgetWindow: 'day' })
const failureDomain = Object.freeze({ providerFailureDomainId: 'domain-a', configVersion: 2, failureThreshold: 3, cooldownSeconds: 60 })
const registry = Object.freeze({
  domains: Object.freeze([admissionDomain]),
  routes: Object.freeze([route]),
  providerFailureDomains: Object.freeze([failureDomain]),
})

function repositories() {
  return {
    repository: {
      reserveProviderCall: vi.fn(async () => ({ allowed: true })),
      releaseProviderCall: vi.fn(async () => true),
    },
    failureDomainRepository: {
      admitProviderDomain: vi.fn(async () => ({ allowed: true, reservationId: 'domain-reservation', probe: true, state: { internal: true } })),
      reportProviderDomain: vi.fn(async () => true),
    },
  }
}

describe('provider admission router capability', () => {
  it('exposes immutable route metadata and delegates provider-domain state through the abstract boundary', async () => {
    const stores = repositories()
    const boundary = createProviderAdmission({
      ...stores,
      registry,
      now: () => new Date('2026-08-15T00:00:00.000Z'),
      providerDomainReservationId: () => 'domain-reservation',
    })

    expect(boundary.getRoute('primary')).toBe(route)
    expect(boundary.getRoute('missing')).toBeNull()
    await expect(boundary.admitProviderDomain({ routeId: 'primary', attemptId: 'attempt-1' })).resolves.toEqual({ allowed: true, reservationId: 'domain-reservation' })
    expect(stores.failureDomainRepository.admitProviderDomain).toHaveBeenCalledWith({
      domain: failureDomain, reservationId: 'domain-reservation', now: new Date('2026-08-15T00:00:00.000Z'),
    })
    await boundary.reportProviderDomain({ routeId: 'primary', reservationId: 'domain-reservation', outcome: 'provider-retryable-failure', errorCode: 'provider_domain_unavailable' })
    expect(stores.failureDomainRepository.reportProviderDomain).toHaveBeenCalledWith({
      domain: failureDomain, reservationId: 'domain-reservation', outcome: 'provider-retryable-failure', now: new Date('2026-08-15T00:00:00.000Z'),
    })
  })

  it('preserves a closed safe adapter error so the router can select the correct fallback family', async () => {
    const stores = repositories()
    const boundary = createProviderAdmission({ ...stores, registry })
    const adapterError = new ProviderAdapterError('model-retryable', { upstreamStatus: 429 })

    await expect(boundary.run({
      routeId: 'primary', capability: 'zdr-verified', attemptId: 'attempt-1', kind: 'answer-primary',
      invoke: async () => { throw adapterError },
    })).rejects.toBe(adapterError)
    expect(stores.repository.releaseProviderCall).toHaveBeenCalledWith(expect.objectContaining({
      outcome: 'retryable-failure', errorCode: 'provider_model_unavailable',
    }))
  })

  it('classifies runtime reserve denial as provider-retryable but keeps invalid candidate gates terminal', async () => {
    const denied = repositories()
    denied.repository.reserveProviderCall.mockResolvedValue({ allowed: false, reason: 'concurrency-limit', retryAfterSeconds: 4 })
    const boundary = createProviderAdmission({ ...denied, registry })

    await expect(boundary.run({
      routeId: 'primary', capability: 'zdr-verified', attemptId: 'attempt-1', kind: 'answer-primary', invoke: vi.fn(),
    })).rejects.toMatchObject({ failureClass: 'provider-retryable', retryable: true, retryAfterSeconds: 4 })

    await expect(boundary.run({
      routeId: 'missing', capability: 'zdr-verified', attemptId: 'attempt-1', kind: 'answer-primary', invoke: vi.fn(),
    })).rejects.toMatchObject({ failureClass: 'config', retryable: false })

    const downgraded = createProviderAdmission({
      ...repositories(),
      registry: { ...registry, routes: [{ ...route, capability: 'nonconfidential' }] },
    })
    await expect(downgraded.run({
      routeId: 'primary', capability: 'zdr-verified', attemptId: 'attempt-1', kind: 'answer-primary', invoke: vi.fn(),
    })).rejects.toMatchObject({ failureClass: 'privacy', retryable: false })

    const expired = createProviderAdmission({
      ...repositories(),
      registry: { ...registry, routes: [{ ...route, evidenceExpiresAt: '2026-08-14T00:00:00.000Z' }] },
      now: () => new Date('2026-08-15T00:00:00.000Z'),
    })
    await expect(expired.run({
      routeId: 'primary', capability: 'zdr-verified', attemptId: 'attempt-1', kind: 'answer-primary', invoke: vi.fn(),
    })).rejects.toMatchObject({ failureClass: 'config', retryable: false })
  })
})
