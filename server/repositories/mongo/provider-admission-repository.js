import { ObjectId } from 'mongodb'

const COOLDOWN_MS = 60_000

function dateValue(value, label) {
  const date = value instanceof Date ? new Date(value) : new Date(value)
  if (Number.isNaN(date.getTime())) throw new Error(`${label} is invalid`)
  return date
}

function attemptId(value) {
  if (value instanceof ObjectId) return value
  if (typeof value === 'string' && ObjectId.isValid(value) && new ObjectId(value).toHexString() === value.toLowerCase()) return new ObjectId(value)
  throw new Error('Provider attempt identity is invalid')
}

function windowMs(window) {
  if (window === 'hour') return 60 * 60 * 1000
  if (window === 'day') return 24 * 60 * 60 * 1000
  if (window === 'month') return 30 * 24 * 60 * 60 * 1000
  throw new Error('Provider budget window is invalid')
}

function sameDomain(state, domain) {
  const providerId = domain?.providerId ?? domain?.provider
  const stateProviderId = state?.providerId ?? state?.provider
  return !state || state.admissionDomainId === domain.admissionDomainId
    && stateProviderId === providerId
    && state.maxConcurrency === domain.maxConcurrency
    && Number(state.budgetLimit) === Number(domain.budgetLimit)
}

function baseState(state, domain, now) {
  const providerId = domain?.providerId ?? domain?.provider
  const usesTargetIdentity = typeof domain?.providerId === 'string' || typeof state?.providerId === 'string'
  if (typeof providerId !== 'string' || providerId.length < 1 || providerId.length > 64) throw new Error('Provider admission identity is invalid')
  if (!sameDomain(state, domain)) throw new Error('Provider admission state does not match static configuration')
  const previousStart = state?.budgetWindowStart ? dateValue(state.budgetWindowStart, 'Provider budget window') : now
  const resetBudget = now.getTime() - previousStart.getTime() >= windowMs(domain.budgetWindow)
  const activeReservations = (state?.activeReservations ?? []).filter((reservation) => dateValue(reservation.expiresAt, 'Provider reservation expiry') > now)
  const routeCircuits = (state?.routeCircuits ?? []).map((circuit) => ({ ...circuit }))
  for (const circuit of routeCircuits) {
    if (circuit.state === 'half-open' && circuit.halfOpenProbeReservationId && !activeReservations.some((reservation) => reservation.reservationId === circuit.halfOpenProbeReservationId)) delete circuit.halfOpenProbeReservationId
  }
  const { provider: _legacyProvider, providerId: _targetProviderId, ...previous } = state ?? {}
  const next = {
    ...previous,
    admissionDomainId: domain.admissionDomainId,
    activeReservations,
    maxConcurrency: domain.maxConcurrency,
    budgetWindowStart: resetBudget ? now : previousStart,
    spentUnits: resetBudget ? 0 : Number(state?.spentUnits ?? 0),
    budgetLimit: domain.budgetLimit,
    routeCircuits,
    updatedAt: now,
  }
  return usesTargetIdentity ? { ...next, providerId } : { ...next, provider: providerId }
}

function circuitFor(state, routeId) {
  let circuit = state.routeCircuits.find((item) => item.routeId === routeId)
  if (!circuit) {
    circuit = { routeId, state: 'closed', consecutiveRetryableFailures: 0 }
    state.routeCircuits.push(circuit)
  }
  return circuit
}

export function applyProviderReservation(state, { domain, route, reservationId, attemptId: callAttemptId, kind, units = 1, now: nowInput, expiresAt: expiryInput } = {}) {
  const now = dateValue(nowInput, 'Provider reservation time')
  const expiresAt = dateValue(expiryInput, 'Provider reservation expiry')
  if (!domain || !route || route.admissionDomainId !== domain.admissionDomainId || typeof reservationId !== 'string' || reservationId.length < 8 || expiresAt <= now || !Number.isFinite(units) || units <= 0) throw new Error('Provider reservation input is invalid')
  const next = baseState(state, domain, now)
  if (next.activeReservations.some((reservation) => reservation.reservationId === reservationId)) return { allowed: true, reservationId, state: next, reused: true }
  const circuit = circuitFor(next, route.routeId)
  if (circuit.state === 'open') {
    if (!circuit.cooldownUntil || dateValue(circuit.cooldownUntil, 'Provider circuit cooldown') > now) {
      const seconds = circuit.cooldownUntil ? Math.max(1, Math.ceil((dateValue(circuit.cooldownUntil, 'Provider circuit cooldown').getTime() - now.getTime()) / 1000)) : 60
      return { allowed: false, reason: 'circuit-open', retryAfterSeconds: seconds, state: next }
    }
    circuit.state = 'half-open'
    delete circuit.cooldownUntil
  }
  if (circuit.state === 'half-open' && circuit.halfOpenProbeReservationId) return { allowed: false, reason: 'circuit-open', retryAfterSeconds: 60, state: next }
  if (next.activeReservations.length >= next.maxConcurrency) return { allowed: false, reason: 'concurrency-limit', retryAfterSeconds: 1, state: next }
  if (next.spentUnits + units > next.budgetLimit) return { allowed: false, reason: 'budget-limit', retryAfterSeconds: Math.max(1, Math.ceil((next.budgetWindowStart.getTime() + windowMs(domain.budgetWindow) - now.getTime()) / 1000)), state: next }
  next.activeReservations.push({ reservationId, routeId: route.routeId, attemptId: callAttemptId, kind, expiresAt })
  next.spentUnits += units
  if (circuit.state === 'half-open') circuit.halfOpenProbeReservationId = reservationId
  return { allowed: true, reservationId, state: next, reused: false }
}

export function applyProviderRelease(state, { routeId, reservationId, outcome, now: nowInput } = {}) {
  const now = dateValue(nowInput, 'Provider release time')
  if (!state) return { released: true, state }
  const index = state.activeReservations.findIndex((reservation) => reservation.reservationId === reservationId && reservation.routeId === routeId)
  if (index < 0) return { released: true, state }
  const next = {
    ...state,
    activeReservations: state.activeReservations.filter((_reservation, reservationIndex) => reservationIndex !== index),
    routeCircuits: state.routeCircuits.map((circuit) => ({ ...circuit })),
    updatedAt: now,
  }
  const circuit = circuitFor(next, routeId)
  if (circuit.halfOpenProbeReservationId === reservationId) delete circuit.halfOpenProbeReservationId
  if (outcome === 'retryable-failure') {
    circuit.consecutiveRetryableFailures = Math.min(3, circuit.consecutiveRetryableFailures + 1)
    if (circuit.state === 'half-open' || circuit.consecutiveRetryableFailures >= 3) {
      circuit.state = 'open'
      circuit.consecutiveRetryableFailures = 3
      circuit.cooldownUntil = new Date(now.getTime() + COOLDOWN_MS)
    } else circuit.state = 'closed'
  } else if (outcome === 'succeeded') {
    circuit.state = 'closed'
    circuit.consecutiveRetryableFailures = 0
    delete circuit.cooldownUntil
  }
  return { released: true, state: next }
}

function mongoState(state) {
  return {
    ...state,
    _id: state._id instanceof ObjectId ? state._id : state._id ? attemptId(state._id) : new ObjectId(),
    activeReservations: state.activeReservations.map((reservation) => ({ ...reservation, attemptId: attemptId(reservation.attemptId) })),
  }
}

export class MongoProviderAdmissionRepository {
  constructor(context) {
    if (!context?.db || !context?.client) throw new Error('Mongo context is required')
    this.db = context.db
    this.client = context.client
  }

  collection() { return this.db.collection('providerAdmissionStates') }

  async withTransaction(work) {
    const session = this.client.startSession()
    try {
      let result
      await session.withTransaction(async () => { result = await work(session) }, { readConcern: { level: 'snapshot' }, writeConcern: { w: 'majority' } })
      return result
    } finally { await session.endSession() }
  }

  async mutate(admissionDomainId, transform) {
    for (let attempt = 0; attempt < 4; attempt += 1) {
      try {
        return await this.withTransaction(async (session) => {
          const current = await this.collection().findOne({ admissionDomainId }, { session })
          const outcome = transform(current)
          if (!outcome.state || outcome.allowed === false) return outcome
          const next = mongoState(outcome.state)
          if (!current) await this.collection().insertOne(next, { session })
          else {
            const replaced = await this.collection().replaceOne({
              _id: current._id, updatedAt: current.updatedAt, activeReservations: current.activeReservations,
              routeCircuits: current.routeCircuits, spentUnits: current.spentUnits,
            }, next, { session })
            if (replaced.matchedCount !== 1) throw Object.assign(new Error('Provider admission changed concurrently'), { code: 'provider_admission_conflict' })
          }
          return outcome
        })
      } catch (error) {
        if (error?.code !== 11000 && error?.code !== 'provider_admission_conflict' && !error?.hasErrorLabel?.('TransientTransactionError')) throw error
      }
    }
    throw new Error('Provider admission could not advance safely')
  }

  reserveProviderCall(input) {
    return this.mutate(input.domain.admissionDomainId, (state) => applyProviderReservation(state, input))
  }

  releaseProviderCall(input) {
    return this.mutate(input.admissionDomainId, (state) => applyProviderRelease(state, input))
  }
}

export { COOLDOWN_MS }
