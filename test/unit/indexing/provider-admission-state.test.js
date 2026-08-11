import { describe, expect, it } from 'vitest'
import { applyProviderRelease, applyProviderReservation } from '../../../server/repositories/mongo/provider-admission-repository.js'

const now = new Date('2026-08-10T00:00:00.000Z')
const domain = { admissionDomainId: 'shared', provider: 'openrouter', maxConcurrency: 1, budgetLimit: 2, budgetWindow: 'day' }
const primary = { routeId: 'primary', admissionDomainId: 'shared' }
const fallback = { routeId: 'fallback', admissionDomainId: 'shared' }

describe('Step 9 aggregate provider admission state', () => {
  it('makes two routes sharing one credential/domain contend for one aggregate slot and budget', () => {
    const first = applyProviderReservation(null, { domain, route: primary, reservationId: 'reservation-primary', attemptId: '507f1f77bcf86cd799439041', kind: 'summary', units: 1, now, expiresAt: new Date(now.getTime() + 60_000) })
    expect(first.allowed).toBe(true)
    const second = applyProviderReservation(first.state, { domain, route: fallback, reservationId: 'reservation-fallback', attemptId: '507f1f77bcf86cd799439042', kind: 'summary', units: 1, now, expiresAt: new Date(now.getTime() + 60_000) })
    expect(second).toEqual(expect.objectContaining({ allowed: false, reason: 'concurrency-limit' }))
    const released = applyProviderRelease(first.state, { routeId: 'primary', reservationId: 'reservation-primary', outcome: 'succeeded', now })
    const admitted = applyProviderReservation(released.state, { domain, route: fallback, reservationId: 'reservation-fallback', attemptId: '507f1f77bcf86cd799439042', kind: 'summary', units: 1, now, expiresAt: new Date(now.getTime() + 60_000) })
    expect(admitted.allowed).toBe(true)
    expect(admitted.state.spentUnits).toBe(2)
  })

  it('opens only the failing route after three retryable failures for sixty seconds', () => {
    let state = null
    for (let failure = 0; failure < 3; failure += 1) {
      const id = `reservation-${failure}`
      const reserved = applyProviderReservation(state, { domain: { ...domain, maxConcurrency: 2, budgetLimit: 10 }, route: primary, reservationId: id, attemptId: '507f1f77bcf86cd799439041', kind: 'summary', units: 1, now, expiresAt: new Date(now.getTime() + 60_000) })
      state = applyProviderRelease(reserved.state, { routeId: 'primary', reservationId: id, outcome: 'retryable-failure', now }).state
    }
    expect(state.routeCircuits.find(({ routeId }) => routeId === 'primary')).toEqual(expect.objectContaining({ state: 'open', consecutiveRetryableFailures: 3, cooldownUntil: new Date(now.getTime() + 60_000) }))
    expect(applyProviderReservation(state, { domain: { ...domain, maxConcurrency: 2, budgetLimit: 10 }, route: primary, reservationId: 'blocked-route', attemptId: '507f1f77bcf86cd799439041', kind: 'summary', units: 1, now, expiresAt: new Date(now.getTime() + 60_000) })).toEqual(expect.objectContaining({ allowed: false, reason: 'circuit-open', retryAfterSeconds: 60 }))
    expect(applyProviderReservation(state, { domain: { ...domain, maxConcurrency: 2, budgetLimit: 10 }, route: fallback, reservationId: 'healthy-route', attemptId: '507f1f77bcf86cd799439042', kind: 'summary', units: 1, now, expiresAt: new Date(now.getTime() + 60_000) }).allowed).toBe(true)
  })

  it('allows exactly one half-open probe and prunes expired reservations atomically', () => {
    const opened = {
      _id: '507f1f77bcf86cd799439099', admissionDomainId: 'shared', provider: 'openrouter', maxConcurrency: 1,
      budgetWindowStart: new Date('2026-08-10T00:00:00.000Z'), spentUnits: 0, budgetLimit: 2,
      activeReservations: [{ reservationId: 'expired-one', routeId: 'fallback', attemptId: '507f1f77bcf86cd799439042', kind: 'summary', expiresAt: new Date('2026-08-09T23:59:00.000Z') }],
      routeCircuits: [{ routeId: 'primary', state: 'open', consecutiveRetryableFailures: 3, cooldownUntil: new Date('2026-08-09T23:59:59.000Z') }], updatedAt: now,
    }
    const probe = applyProviderReservation(opened, { domain, route: primary, reservationId: 'half-open-probe', attemptId: '507f1f77bcf86cd799439041', kind: 'summary', units: 1, now, expiresAt: new Date(now.getTime() + 60_000) })
    expect(probe.allowed).toBe(true)
    expect(probe.state.activeReservations.map(({ reservationId }) => reservationId)).toEqual(['half-open-probe'])
    expect(probe.state.routeCircuits[0]).toEqual(expect.objectContaining({ state: 'half-open', halfOpenProbeReservationId: 'half-open-probe' }))
    expect(applyProviderReservation(probe.state, { domain, route: primary, reservationId: 'second-probe', attemptId: '507f1f77bcf86cd799439043', kind: 'summary', units: 1, now, expiresAt: new Date(now.getTime() + 60_000) })).toEqual(expect.objectContaining({ allowed: false, reason: 'circuit-open' }))
  })
})
