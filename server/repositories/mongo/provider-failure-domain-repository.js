import { ObjectId } from 'mongodb'

const ID = /^[a-z0-9][a-z0-9._-]{0,63}$/
const OUTCOMES = new Set([
  'succeeded',
  'model-retryable-failure',
  'provider-retryable-failure',
  'terminal-failure',
  'cancelled',
])

export class ProviderFailureDomainConfigError extends Error {
  constructor(message = 'Provider failure-domain state does not match static configuration') {
    super(message)
    this.name = 'ProviderFailureDomainConfigError'
    this.code = 'provider_failure_domain_config_stale'
    this.retryable = false
  }
}

function dateValue(value, label) {
  const date = value instanceof Date ? new Date(value) : new Date(value)
  if (Number.isNaN(date.getTime())) throw new Error(`${label} is invalid`)
  return date
}

function validateDomain(domain) {
  if (
    !domain ||
    !ID.test(domain.providerFailureDomainId) ||
    !Number.isInteger(domain.configVersion) ||
    domain.configVersion < 1 ||
    domain.failureThreshold !== 3 ||
    domain.cooldownSeconds !== 60
  ) throw new Error('Provider failure-domain configuration is invalid')
}

function validateReservationId(reservationId) {
  if (typeof reservationId !== 'string' || reservationId.length < 8 || reservationId.length > 128) {
    throw new Error('Provider failure-domain reservation identity is invalid')
  }
}

function baseState(state, domain, now) {
  validateDomain(domain)
  if (
    state &&
    (state.providerFailureDomainId !== domain.providerFailureDomainId ||
      state.configVersion !== domain.configVersion)
  ) throw new ProviderFailureDomainConfigError()
  return state ?? {
    providerFailureDomainId: domain.providerFailureDomainId,
    configVersion: domain.configVersion,
    state: 'closed',
    consecutiveRetryableFailures: 0,
    updatedAt: now,
  }
}

function retryAfterSeconds(cooldownUntil, now) {
  return Math.max(1, Math.ceil((cooldownUntil.getTime() - now.getTime()) / 1000))
}

function transitionState(current, updates) {
  const next = { ...current, ...updates }
  for (const key of ['cooldownUntil', 'halfOpenProbeReservationId']) {
    if (next[key] === undefined) delete next[key]
  }
  return next
}

export function applyProviderFailureDomainAdmission(
  state,
  { domain, reservationId, now: nowInput } = {},
) {
  const now = dateValue(nowInput, 'Provider failure-domain admission time')
  validateReservationId(reservationId)
  let current = baseState(state, domain, now)
  if (current.state === 'half-open' && current.halfOpenProbeReservationId) {
    const probeExpiresAt = new Date(dateValue(current.updatedAt, 'Provider failure-domain update time').getTime() + domain.cooldownSeconds * 1000)
    if (probeExpiresAt <= now) current = transitionState(current, { halfOpenProbeReservationId: undefined, updatedAt: now })
  }
  if (current.state === 'closed') {
    return { allowed: true, reservationId, probe: false, state: current }
  }
  if (current.state === 'open') {
    const cooldownUntil = dateValue(current.cooldownUntil, 'Provider failure-domain cooldown')
    if (cooldownUntil > now) {
      return {
        allowed: false,
        reason: 'provider-domain-open',
        retryAfterSeconds: retryAfterSeconds(cooldownUntil, now),
        probe: false,
        state: current,
      }
    }
    return {
      allowed: true,
      reservationId,
      probe: true,
      state: transitionState(current, {
        state: 'half-open',
        halfOpenProbeReservationId: reservationId,
        cooldownUntil: undefined,
        updatedAt: now,
      }),
    }
  }
  if (current.state !== 'half-open') throw new ProviderFailureDomainConfigError()
  if (current.halfOpenProbeReservationId === reservationId) {
    return { allowed: true, reservationId, probe: true, reused: true, state: current }
  }
  if (current.halfOpenProbeReservationId) {
    return {
      allowed: false,
      reason: 'provider-domain-open',
      retryAfterSeconds: domain.cooldownSeconds,
      probe: false,
      state: current,
    }
  }
  return {
    allowed: true,
    reservationId,
    probe: true,
    state: transitionState(current, {
      halfOpenProbeReservationId: reservationId,
      updatedAt: now,
    }),
  }
}

export function applyProviderFailureDomainOutcome(
  state,
  { domain, reservationId, outcome, now: nowInput } = {},
) {
  const now = dateValue(nowInput, 'Provider failure-domain outcome time')
  validateReservationId(reservationId)
  if (!OUTCOMES.has(outcome)) throw new Error('Provider failure-domain outcome is invalid')
  const current = baseState(state, domain, now)
  const ownsProbe = current.halfOpenProbeReservationId === reservationId
  if (current.state === 'half-open' && current.halfOpenProbeReservationId && !ownsProbe) {
    return { recorded: false, state: current }
  }
  if (outcome === 'provider-retryable-failure') {
    const failures = Math.min(domain.failureThreshold, current.consecutiveRetryableFailures + 1)
    const shouldOpen = current.state === 'half-open' || failures >= domain.failureThreshold
    return {
      recorded: true,
      state: transitionState(current, {
        state: shouldOpen ? 'open' : 'closed',
        consecutiveRetryableFailures: failures,
        cooldownUntil: shouldOpen
          ? new Date(now.getTime() + domain.cooldownSeconds * 1000)
          : undefined,
        halfOpenProbeReservationId: undefined,
        updatedAt: now,
      }),
    }
  }
  if (outcome === 'succeeded') {
    return {
      recorded: true,
      state: transitionState(current, {
        state: 'closed',
        consecutiveRetryableFailures: 0,
        cooldownUntil: undefined,
        halfOpenProbeReservationId: undefined,
        updatedAt: now,
      }),
    }
  }
  if (!ownsProbe) return { recorded: true, state: current }
  return {
    recorded: true,
    state: transitionState(current, {
      halfOpenProbeReservationId: undefined,
      updatedAt: now,
    }),
  }
}

function mongoState(state) {
  return {
    ...state,
    _id: state._id instanceof ObjectId ? state._id : new ObjectId(),
  }
}

export class MongoProviderFailureDomainRepository {
  constructor(context) {
    if (!context?.db || !context?.client) throw new Error('Mongo context is required')
    this.db = context.db
    this.client = context.client
  }

  collection() {
    return this.db.collection('providerFailureDomainStates')
  }

  async withTransaction(work) {
    const session = this.client.startSession()
    try {
      let result
      await session.withTransaction(
        async () => { result = await work(session) },
        { readConcern: { level: 'snapshot' }, writeConcern: { w: 'majority' } },
      )
      return result
    } finally {
      await session.endSession()
    }
  }

  async mutate(domain, transform) {
    validateDomain(domain)
    for (let attempt = 0; attempt < 4; attempt += 1) {
      try {
        return await this.withTransaction(async (session) => {
          const current = await this.collection().findOne(
            { providerFailureDomainId: domain.providerFailureDomainId },
            { session },
          )
          const outcome = transform(current)
          if (outcome.state === current) return outcome
          const next = mongoState(outcome.state)
          if (!current) {
            await this.collection().insertOne(next, { session })
          } else {
            const replaced = await this.collection().replaceOne(
              {
                _id: current._id,
                configVersion: domain.configVersion,
                state: current.state,
                consecutiveRetryableFailures: current.consecutiveRetryableFailures,
                updatedAt: current.updatedAt,
              },
              next,
              { session },
            )
            if (replaced.matchedCount !== 1) {
              throw Object.assign(new Error('Provider failure-domain state changed concurrently'), {
                code: 'provider_failure_domain_conflict',
              })
            }
          }
          return outcome
        })
      } catch (error) {
        const retryable =
          error?.code === 11000 ||
          error?.code === 'provider_failure_domain_conflict' ||
          error?.hasErrorLabel?.('TransientTransactionError')
        if (!retryable) throw error
      }
    }
    throw Object.assign(new Error('Provider failure-domain state could not advance safely'), {
      code: 'provider_failure_domain_conflict',
      retryable: false,
    })
  }

  admitProviderCall(input) {
    return this.mutate(input.domain, (state) => applyProviderFailureDomainAdmission(state, input))
  }

  recordProviderCallOutcome(input) {
    return this.mutate(input.domain, (state) => applyProviderFailureDomainOutcome(state, input))
  }

  admitProviderDomain(input) {
    return this.admitProviderCall(input)
  }

  reportProviderDomain(input) {
    return this.recordProviderCallOutcome(input)
  }
}
