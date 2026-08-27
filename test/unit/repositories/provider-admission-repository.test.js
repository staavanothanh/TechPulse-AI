import { ObjectId } from 'mongodb'
import { describe, expect, it, vi } from 'vitest'
import { MongoProviderAdmissionRepository, applyProviderRelease, applyProviderReservation } from '../../../server/repositories/mongo/provider-admission-repository.js'

const attemptId = new ObjectId('507f1f77bcf86cd799439011')
const now = new Date('2026-08-20T08:00:00.000Z')
const domain = { admissionDomainId: 'domain-1', providerId: 'provider-1', maxConcurrency: 2, budgetLimit: 5, budgetWindow: 'hour' }
const route = { admissionDomainId: 'domain-1', routeId: 'route-a' }

function state(overrides = {}) {
  return {
    _id: new ObjectId('507f1f77bcf86cd799439012'),
    admissionDomainId: domain.admissionDomainId,
    providerId: domain.providerId,
    maxConcurrency: domain.maxConcurrency,
    budgetWindowStart: now,
    spentUnits: 0,
    budgetLimit: domain.budgetLimit,
    activeReservations: [],
    routeCircuits: [],
    updatedAt: now,
    ...overrides,
  }
}

function reservation(overrides = {}) {
  return { domain, route, reservationId: 'reservation-1', attemptId, kind: 'summary', units: 1, now, expiresAt: new Date(now.getTime() + 10_000), ...overrides }
}

function createContext({ current = null, updateResults = {}, session = null } = {}) {
  const queue = (name, fallback) => {
    const values = updateResults[name]
    return Array.isArray(values) && values.length > 0 ? values.shift() : fallback
  }
  const collection = {
    findOne: vi.fn(async () => current),
    insertOne: vi.fn(async () => ({ acknowledged: true })),
    replaceOne: vi.fn(async () => queue('replaceOne', { matchedCount: 1 })),
  }
  const transactionSession = session ?? {
    withTransaction: vi.fn(async (work) => work(transactionSession)),
    endSession: vi.fn(async () => {}),
  }
  const repository = new MongoProviderAdmissionRepository({ db: { collection: vi.fn(() => collection) }, client: { startSession: vi.fn(() => transactionSession) } })
  return { repository, collection, session: transactionSession }
}

describe('provider admission state machine', () => {
  it('accepts, reuses, and rejects reservations by circuit, concurrency and budget', () => {
    const first = applyProviderReservation(state(), reservation())
    expect(first).toEqual(expect.objectContaining({ allowed: true, reused: false, reservationId: 'reservation-1' }))
    expect(first.state.activeReservations).toHaveLength(1)
    expect(state().activeReservations).toHaveLength(0)
    expect(applyProviderReservation(first.state, reservation())).toEqual(expect.objectContaining({ allowed: true, reused: true }))

    const open = applyProviderReservation(state({ routeCircuits: [{ routeId: 'route-a', state: 'open', cooldownUntil: new Date(now.getTime() + 20_000), consecutiveRetryableFailures: 3 }] }), reservation())
    expect(open).toEqual(expect.objectContaining({ allowed: false, reason: 'circuit-open', retryAfterSeconds: 20 }))
    const halfOpen = applyProviderReservation(state({ routeCircuits: [{ routeId: 'route-a', state: 'open', cooldownUntil: new Date(now.getTime() - 1), consecutiveRetryableFailures: 3 }] }), reservation())
    expect(halfOpen.allowed).toBe(true)
    expect(halfOpen.state.routeCircuits[0].state).toBe('half-open')
    expect(applyProviderReservation(halfOpen.state, reservation({ reservationId: 'reservation-2' }))).toEqual(expect.objectContaining({ allowed: false, reason: 'circuit-open' }))

    const atConcurrency = state({ activeReservations: [{ reservationId: 'a', routeId: 'route-a', attemptId, expiresAt: new Date(now.getTime() + 1_000) }, { reservationId: 'b', routeId: 'route-a', attemptId, expiresAt: new Date(now.getTime() + 1_000) }] })
    expect(applyProviderReservation(atConcurrency, reservation())).toEqual(expect.objectContaining({ allowed: false, reason: 'concurrency-limit' }))
    expect(applyProviderReservation(state({ spentUnits: 5 }), reservation())).toEqual(expect.objectContaining({ allowed: false, reason: 'budget-limit' }))
  })

  it('resets expired windows, prunes probes, and validates reservation input', () => {
    const previous = state({ budgetWindowStart: new Date(now.getTime() - 2 * 60 * 60 * 1000), spentUnits: 5, routeCircuits: [{ routeId: 'route-a', state: 'half-open', halfOpenProbeReservationId: 'expired', consecutiveRetryableFailures: 1 }], activeReservations: [] })
    const result = applyProviderReservation(previous, reservation())
    expect(result.state.spentUnits).toBe(1)
    expect(result.state.budgetWindowStart).toEqual(now)
    expect(result.state.routeCircuits[0]).toHaveProperty('halfOpenProbeReservationId', 'reservation-1')
    expect(() => applyProviderReservation(state(), { ...reservation(), now: 'bad' })).toThrow(/time/i)
    expect(() => applyProviderReservation(state(), { ...reservation(), expiresAt: now })).toThrow(/input/i)
    expect(() => applyProviderReservation(state(), { ...reservation(), route: { ...route, admissionDomainId: 'other' } })).toThrow(/input/i)
    expect(() => applyProviderReservation(state(), { ...reservation(), units: 0 })).toThrow(/input/i)
    expect(() => applyProviderReservation(state(), { ...reservation(), reservationId: 'short' })).toThrow(/input/i)
    expect(() => applyProviderReservation(state(), { ...reservation(), domain: { ...domain, budgetWindow: 'year' } })).toThrow(/window/i)
  })

  it('releases reservations and transitions retryable circuit failures', () => {
    expect(applyProviderRelease(null, { routeId: 'route-a', reservationId: 'x', outcome: 'succeeded', now })).toEqual({ released: true, state: null })
    const initial = state({ activeReservations: [{ reservationId: 'reservation-1', routeId: 'route-a', attemptId, expiresAt: new Date(now.getTime() + 1000) }], routeCircuits: [{ routeId: 'route-a', state: 'closed', consecutiveRetryableFailures: 2 }] })
    const failed = applyProviderRelease(initial, { routeId: 'route-a', reservationId: 'reservation-1', outcome: 'retryable-failure', now })
    expect(failed.state.activeReservations).toHaveLength(0)
    expect(failed.state.routeCircuits[0]).toEqual(expect.objectContaining({ state: 'open', consecutiveRetryableFailures: 3, cooldownUntil: expect.any(Date) }))
    const success = applyProviderRelease(failed.state, { routeId: 'route-a', reservationId: 'missing', outcome: 'succeeded', now })
    expect(success.state).toBe(failed.state)
    const released = applyProviderRelease(state({ activeReservations: [{ reservationId: 'probe', routeId: 'route-a', attemptId, expiresAt: new Date(now.getTime() + 1000) }], routeCircuits: [{ routeId: 'route-a', state: 'half-open', halfOpenProbeReservationId: 'probe', consecutiveRetryableFailures: 2 }] }), { routeId: 'route-a', reservationId: 'probe', outcome: 'succeeded', now })
    expect(released.state.routeCircuits[0]).toEqual(expect.objectContaining({ state: 'closed', consecutiveRetryableFailures: 0 }))
    expect(released.state.routeCircuits[0]).not.toHaveProperty('cooldownUntil')
  })

  it('persists allowed state through Mongo transactions and retries CAS conflicts', async () => {
    expect(() => new MongoProviderAdmissionRepository()).toThrow(/context/i)
    const fresh = createContext()
    await expect(fresh.repository.reserveProviderCall(reservation())).resolves.toEqual(expect.objectContaining({ allowed: true }))
    expect(fresh.collection.insertOne).toHaveBeenCalled()
    expect(fresh.session.endSession).toHaveBeenCalled()

    const existing = createContext({ current: state() })
    await expect(existing.repository.releaseProviderCall({ admissionDomainId: domain.admissionDomainId, routeId: 'route-a', reservationId: 'missing', outcome: 'succeeded', now })).resolves.toEqual(expect.objectContaining({ released: true }))
    expect(existing.collection.replaceOne).toHaveBeenCalled()

    const disallowed = createContext({ current: state({ activeReservations: [{ reservationId: 'a', routeId: 'route-a', attemptId, expiresAt: new Date(now.getTime() + 1000) }, { reservationId: 'b', routeId: 'route-a', attemptId, expiresAt: new Date(now.getTime() + 1000) }] }) })
    await expect(disallowed.repository.reserveProviderCall(reservation())).resolves.toEqual(expect.objectContaining({ allowed: false, reason: 'concurrency-limit' }))
    expect(disallowed.collection.replaceOne).not.toHaveBeenCalled()

    const conflict = Object.assign(new Error('cas'), { code: 'provider_admission_conflict' })
    const session = { withTransaction: vi.fn().mockRejectedValueOnce(conflict).mockRejectedValueOnce(conflict).mockImplementation(async (work) => work(session)), endSession: vi.fn(async () => {}) }
    const retry = createContext({ session, updateResults: { replaceOne: [{ matchedCount: 1 }] } })
    await expect(retry.repository.releaseProviderCall({ admissionDomainId: domain.admissionDomainId, routeId: 'route-a', reservationId: 'missing', outcome: 'succeeded', now })).resolves.toEqual(expect.objectContaining({ released: true }))
    expect(session.withTransaction).toHaveBeenCalledTimes(3)
  })
})
