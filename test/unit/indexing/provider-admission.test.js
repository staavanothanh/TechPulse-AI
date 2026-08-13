import { describe, expect, it, vi } from 'vitest'
import { createProviderAdmission, ProviderBoundaryError } from '../../../server/ai/provider-admission.js'
import { EvidenceSelectionError } from '../../../server/domain/qa/evidence.js'

const registry = {
  domains: [{ admissionDomainId: 'shared', provider: 'openrouter', maxConcurrency: 1, budgetLimit: 10, budgetWindow: 'day' }],
  routes: [
    { routeId: 'summary-primary', admissionDomainId: 'shared', model: 'chat/model', capability: 'nonconfidential', enabled: true },
    { routeId: 'question-zdr', admissionDomainId: 'shared', model: 'zdr/model', capability: 'zdr-verified', evidenceExpiresAt: '2099-01-01T00:00:00.000Z', enabled: true },
  ],
}

describe('Step 9 provider admission boundary', () => {
  it('reserves aggregate capacity before invoke and releases idempotently after success', async () => {
    const repository = {
      reserveProviderCall: vi.fn(async () => ({ allowed: true, reservationId: 'reservation-1' })),
      releaseProviderCall: vi.fn(async () => true),
    }
    const admission = createProviderAdmission({ repository, registry, reservationId: () => 'reservation-1', now: () => new Date('2026-08-10T00:00:00.000Z') })
    const invoke = vi.fn(async (route) => ({ route: route.routeId }))
    await expect(admission.run({ routeId: 'summary-primary', capability: 'nonconfidential', attemptId: '507f1f77bcf86cd799439041', kind: 'summary', invoke })).resolves.toEqual({ route: 'summary-primary' })
    expect(repository.reserveProviderCall).toHaveBeenCalledBefore(invoke)
    expect(repository.reserveProviderCall).toHaveBeenCalledWith(expect.objectContaining({ expiresAt: new Date('2026-08-10T00:01:00.000Z') }))
    expect(repository.releaseProviderCall).toHaveBeenCalledWith(expect.objectContaining({ reservationId: 'reservation-1', outcome: 'succeeded' }))
  })

  it('never downgrades a zdr requirement and never invokes after circuit/cap rejection', async () => {
    const repository = { reserveProviderCall: vi.fn(async () => ({ allowed: false, retryAfterSeconds: 60, reason: 'circuit-open' })), releaseProviderCall: vi.fn() }
    const admission = createProviderAdmission({ repository, registry })
    const invoke = vi.fn()
    await expect(admission.run({ routeId: 'summary-primary', capability: 'zdr-verified', attemptId: '507f1f77bcf86cd799439041', kind: 'answer-primary', invoke })).rejects.toBeInstanceOf(ProviderBoundaryError)
    expect(repository.reserveProviderCall).not.toHaveBeenCalled()
    await expect(admission.run({ routeId: 'question-zdr', capability: 'zdr-verified', attemptId: '507f1f77bcf86cd799439041', kind: 'answer-primary', invoke })).rejects.toMatchObject({ code: 'provider_unavailable', retryAfterSeconds: 60 })
    expect(invoke).not.toHaveBeenCalled()
  })

  it('maps retryable provider failures into per-route circuit outcome without payload leakage', async () => {
    const repository = { reserveProviderCall: vi.fn(async () => ({ allowed: true, reservationId: 'reservation-2' })), releaseProviderCall: vi.fn(async () => true) }
    const admission = createProviderAdmission({ repository, registry, reservationId: () => 'reservation-2' })
    const providerError = Object.assign(new Error('raw vendor response with secret'), { retryable: true, code: 'upstream_timeout' })
    await expect(admission.run({ routeId: 'summary-primary', capability: 'nonconfidential', attemptId: '507f1f77bcf86cd799439041', kind: 'summary', invoke: async () => { throw providerError } })).rejects.toMatchObject({ code: 'provider_unavailable', message: 'AI provider is temporarily unavailable' })
    expect(repository.releaseProviderCall).toHaveBeenCalledWith(expect.objectContaining({ outcome: 'retryable-failure', errorCode: 'upstream_timeout' }))
  })

  it('preserves only allowlisted safe boundary errors from an admitted callback', async () => {
    const repository = { reserveProviderCall: vi.fn(async () => ({ allowed: true })), releaseProviderCall: vi.fn(async () => true) }
    const admission = createProviderAdmission({ repository, registry })
    const policyError = new EvidenceSelectionError('policy-blocked', 'internal policy details')

    await expect(admission.run({ routeId: 'question-zdr', capability: 'zdr-verified', attemptId: 'attempt-1', kind: 'answer-primary', invoke: async () => { throw policyError } })).rejects.toMatchObject({
      name: 'EvidenceSelectionError', code: 'policy-blocked', message: 'Provider input is no longer permitted',
    })
  })

  it('rechecks ZDR evidence expiry after capacity reservation and releases without invoking', async () => {
    let current = new Date('2026-08-10T00:00:00.000Z')
    const expiringRegistry = {
      ...registry,
      routes: registry.routes.map((route) => route.routeId === 'question-zdr' ? { ...route, evidenceExpiresAt: '2026-08-10T00:00:01.000Z' } : route),
    }
    const repository = {
      reserveProviderCall: vi.fn(async () => {
        current = new Date('2026-08-10T00:00:02.000Z')
        return { allowed: true }
      }),
      releaseProviderCall: vi.fn(async () => true),
    }
    const invoke = vi.fn()
    const admission = createProviderAdmission({ repository, registry: expiringRegistry, now: () => current })

    await expect(admission.run({ routeId: 'question-zdr', capability: 'zdr-verified', attemptId: 'attempt-expiry', kind: 'answer-primary', invoke })).rejects.toMatchObject({ code: 'provider_unavailable' })
    expect(invoke).not.toHaveBeenCalled()
    expect(repository.releaseProviderCall).toHaveBeenCalledWith(expect.objectContaining({ outcome: 'nonretryable-failure', errorCode: 'provider_evidence_expired' }))
  })
})
