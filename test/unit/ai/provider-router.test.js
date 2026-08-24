import { describe, expect, it, vi } from 'vitest'
import { ProviderAdapterError } from '../../../server/ai/provider-error-taxonomy.js'
import { createProviderAdmission } from '../../../server/ai/provider-admission.js'
import { createProviderRouter, ProviderRoutingError } from '../../../server/ai/provider-router.js'

const routes = Object.freeze([
  Object.freeze({ routeId: 'primary', providerId: 'provider-a', providerFailureDomainId: 'domain-a', admissionDomainId: 'admission-a', model: 'model-a1', operations: Object.freeze(['answer']), capability: 'zdr-verified', enabled: true, evidenceExpiresAt: '2099-01-01T00:00:00.000Z' }),
  Object.freeze({ routeId: 'model-fallback', providerId: 'provider-a', providerFailureDomainId: 'domain-a', admissionDomainId: 'admission-a', model: 'model-a2', operations: Object.freeze(['answer']), capability: 'zdr-verified', enabled: true, evidenceExpiresAt: '2099-01-01T00:00:00.000Z' }),
  Object.freeze({ routeId: 'provider-fallback', providerId: 'provider-b', providerFailureDomainId: 'domain-b', admissionDomainId: 'admission-b', model: 'model-b1', operations: Object.freeze(['answer']), capability: 'zdr-verified', enabled: true, evidenceExpiresAt: '2099-01-01T00:00:00.000Z' }),
])

const workloads = Object.freeze([Object.freeze({
  workloadId: 'qa-generation',
  operation: 'answer',
  requiredCapability: 'zdr-verified',
  maxExternalAttempts: 2,
  primaryRouteId: 'primary',
  modelFallbackRouteIds: Object.freeze(['model-fallback']),
  providerFallbackRouteIds: Object.freeze(['provider-fallback']),
})])

function admission({ unavailableDomains = [] } = {}) {
  const byId = new Map(routes.map((route) => [route.routeId, route]))
  return {
    getRoute: vi.fn((routeId) => byId.get(routeId) ?? null),
    admitProviderDomain: vi.fn(async ({ routeId }) => unavailableDomains.includes(byId.get(routeId)?.providerFailureDomainId)
      ? { allowed: false, reason: 'provider-domain-open', retryAfterSeconds: 30 }
      : { allowed: true, reservationId: `domain-${routeId}` }),
    reportProviderDomain: vi.fn(async () => true),
    run: vi.fn(async ({ routeId, invoke }) => invoke(byId.get(routeId))),
  }
}

function execute(router, invoke, overrides = {}) {
  return router.execute({
    workloadId: 'qa-generation',
    admittedInput: { prompt: 'safe admitted input', nested: { policyVersion: 4 } },
    attemptId: 'attempt-1',
    invoke,
    validateOutput: ({ output }) => output,
    ...overrides,
  })
}

describe('config-driven provider router', () => {
  it('rejects unsupported operation or capability policy values at construction', () => {
    expect(() => createProviderRouter({
      workloadPolicies: [{ ...workloads[0], operation: 'unknown' }], admission: admission(),
    })).toThrow(expect.objectContaining({ failureClass: 'config' }))
    expect(() => createProviderRouter({
      workloadPolicies: [{ ...workloads[0], requiredCapability: 'lower-trust' }], admission: admission(),
    })).toThrow(expect.objectContaining({ failureClass: 'config' }))
  })

  it('uses one same-domain different-model fallback only for model-retryable', async () => {
    const boundary = admission()
    const router = createProviderRouter({ workloadPolicies: workloads, admission: boundary, now: () => new Date('2026-08-15T00:00:00.000Z') })
    const seenInputs = []
    const invoke = vi.fn(async ({ route, admittedInput }) => {
      seenInputs.push(admittedInput)
      expect(Object.isFrozen(admittedInput)).toBe(true)
      expect(Object.isFrozen(admittedInput.nested)).toBe(true)
      if (route.routeId === 'primary') throw new ProviderAdapterError('model-retryable')
      return { answer: 'ok' }
    })

    await expect(execute(router, invoke)).resolves.toEqual({
      output: { answer: 'ok' },
      metadata: {
        workloadId: 'qa-generation', operation: 'answer', routeId: 'model-fallback', providerId: 'provider-a',
        providerFailureDomainId: 'domain-a', model: 'model-a2', externalAttempts: 2, fallback: 'model',
      },
    })
    expect(seenInputs).toHaveLength(2)
    expect(seenInputs[1]).toBe(seenInputs[0])
    expect(boundary.run.mock.calls.map(([call]) => call.routeId)).toEqual(['primary', 'model-fallback'])
  })

  it('uses one different-domain fallback only for provider-retryable', async () => {
    const boundary = admission()
    const router = createProviderRouter({ workloadPolicies: workloads, admission: boundary })
    const invoke = vi.fn(async ({ route }) => {
      if (route.routeId === 'primary') throw new ProviderAdapterError('provider-retryable')
      return { answer: 'ok' }
    })

    const result = await execute(router, invoke)
    expect(result.metadata).toEqual(expect.objectContaining({ routeId: 'provider-fallback', providerFailureDomainId: 'domain-b', externalAttempts: 2, fallback: 'provider' }))
    expect(boundary.run.mock.calls.map(([call]) => call.routeId)).toEqual(['primary', 'provider-fallback'])
    expect(boundary.reportProviderDomain).toHaveBeenCalledWith(expect.objectContaining({ routeId: 'primary', outcome: 'provider-retryable-failure' }))
  })

  it('does not poison provider-domain state or fall back for a local control interruption', async () => {
    const boundary = admission()
    const router = createProviderRouter({ workloadPolicies: workloads, admission: boundary })
    const localControl = Object.assign(new ProviderAdapterError('policy'), { providerLocalControl: true })
    const invoke = vi.fn(async () => { throw localControl })

    await expect(execute(router, invoke)).rejects.toBe(localControl)
    expect(invoke).toHaveBeenCalledTimes(1)
    expect(boundary.run).toHaveBeenCalledTimes(1)
    expect(boundary.reportProviderDomain).toHaveBeenCalledWith(expect.objectContaining({
      routeId: 'primary', outcome: 'cancelled',
    }))
  })

  it('uses a cross-provider fallback when primary route admission is denied before invoke', async () => {
    const domains = [
      { admissionDomainId: 'admission-a', providerId: 'provider-a', maxConcurrency: 1, budgetLimit: 10, budgetWindow: 'day' },
      { admissionDomainId: 'admission-b', providerId: 'provider-b', maxConcurrency: 1, budgetLimit: 10, budgetWindow: 'day' },
    ]
    const providerFailureDomains = [
      { providerFailureDomainId: 'domain-a', configVersion: 1, failureThreshold: 3, cooldownSeconds: 60 },
      { providerFailureDomainId: 'domain-b', configVersion: 1, failureThreshold: 3, cooldownSeconds: 60 },
    ]
    const repository = {
      reserveProviderCall: vi.fn(async ({ domain }) => domain.admissionDomainId === 'admission-a'
        ? { allowed: false, reason: 'budget-limit', retryAfterSeconds: 30 }
        : { allowed: true }),
      releaseProviderCall: vi.fn(async () => true),
    }
    let domainReservation = 0
    const failureDomainRepository = {
      admitProviderDomain: vi.fn(async () => ({ allowed: true })),
      reportProviderDomain: vi.fn(async () => true),
    }
    const providerAdmission = createProviderAdmission({
      repository,
      failureDomainRepository,
      registry: { domains, routes, providerFailureDomains },
      reservationId: () => 'route-reservation',
      providerDomainReservationId: () => `domain-reservation-${domainReservation += 1}`,
    })
    const router = createProviderRouter({ workloadPolicies: workloads, admission: providerAdmission })
    const invoke = vi.fn(async ({ route }) => ({ routeId: route.routeId }))

    await expect(execute(router, invoke)).resolves.toEqual({
      output: { routeId: 'provider-fallback' },
      metadata: expect.objectContaining({ routeId: 'provider-fallback', fallback: 'provider', externalAttempts: 1 }),
    })
    expect(invoke).toHaveBeenCalledTimes(1)
    expect(repository.reserveProviderCall.mock.calls.map(([call]) => call.route.routeId)).toEqual(['primary', 'provider-fallback'])
    expect(failureDomainRepository.reportProviderDomain.mock.calls.map(([call]) => [call.domain.providerFailureDomainId, call.outcome])).toEqual([
      ['domain-a', 'terminal-failure'], ['domain-b', 'succeeded'],
    ])
    expect(providerAdmission).toBeDefined()
  })

  it('skips a pre-call unavailable primary provider domain and calls only a different domain', async () => {
    const boundary = admission({ unavailableDomains: ['domain-a'] })
    const router = createProviderRouter({ workloadPolicies: workloads, admission: boundary })
    const invoke = vi.fn(async () => ({ answer: 'ok' }))

    const result = await execute(router, invoke)
    expect(result.metadata).toEqual(expect.objectContaining({ routeId: 'provider-fallback', externalAttempts: 1, fallback: 'provider' }))
    expect(boundary.run).toHaveBeenCalledTimes(1)
    expect(boundary.run).toHaveBeenCalledWith(expect.objectContaining({ routeId: 'provider-fallback' }))
  })

  it('exposes zero external attempts and the retry hint when admission denies before invoke', async () => {
    const boundary = admission({ unavailableDomains: ['domain-a'] })
    const router = createProviderRouter({
      workloadPolicies: [{ ...workloads[0], maxExternalAttempts: 1, modelFallbackRouteIds: [], providerFallbackRouteIds: [] }],
      admission: boundary,
    })
    const invoke = vi.fn()

    let failure
    try { await execute(router, invoke) } catch (error) { failure = error }

    expect(failure).toMatchObject({
      name: 'ProviderRoutingError', failureClass: 'provider-retryable', retryable: true, retryAfterSeconds: 30,
    })
    expect(failure.externalAttempts ?? failure.metadata?.externalAttempts).toBe(0)
    expect(invoke).not.toHaveBeenCalled()
    expect(boundary.run).not.toHaveBeenCalled()
  })

  it.each(['policy', 'privacy', 'sensitive-input', 'config', 'schema', 'support', 'ambiguous'])(
    'treats %s as terminal and never calls a fallback',
    async (failureClass) => {
      const boundary = admission()
      const router = createProviderRouter({ workloadPolicies: workloads, admission: boundary })
      const invoke = vi.fn(async () => { throw new ProviderAdapterError(failureClass) })

      await expect(execute(router, invoke)).rejects.toMatchObject({
        name: 'ProviderRoutingError', code: expect.any(String), failureClass, retryable: false,
      })
      expect(boundary.run).toHaveBeenCalledTimes(1)
      expect(invoke).toHaveBeenCalledTimes(1)
    },
  )

  it('never exceeds two external calls or changes fallback family after the first failure', async () => {
    const boundary = admission()
    const router = createProviderRouter({ workloadPolicies: workloads, admission: boundary })
    const invoke = vi.fn(async ({ route }) => {
      throw new ProviderAdapterError(route.routeId === 'primary' ? 'model-retryable' : 'provider-retryable')
    })

    await expect(execute(router, invoke)).rejects.toBeInstanceOf(ProviderRoutingError)
    expect(boundary.run.mock.calls.map(([call]) => call.routeId)).toEqual(['primary', 'model-fallback'])
    expect(invoke).toHaveBeenCalledTimes(2)
  })

  it('never exposes a retry hint after an ambiguous outcome', async () => {
    const router = createProviderRouter({ workloadPolicies: workloads, admission: admission() })
    let failure
    try {
      await execute(router, async () => { throw new ProviderAdapterError('ambiguous', { retryAfterSeconds: 90 }) })
    } catch (error) {
      failure = error
    }
    expect(failure).toMatchObject({ failureClass: 'ambiguous', retryable: false })
    expect(failure).not.toHaveProperty('retryAfterSeconds')
  })

  it('validates each output inside admission and treats invalid schema as terminal', async () => {
    const boundary = admission()
    const router = createProviderRouter({ workloadPolicies: workloads, admission: boundary })
    const validateOutput = vi.fn(() => { throw new ProviderAdapterError('schema') })

    await expect(execute(router, vi.fn(async () => ({ untrusted: true })), { validateOutput })).rejects.toMatchObject({
      failureClass: 'schema', retryable: false,
    })
    expect(validateOutput).toHaveBeenCalledTimes(1)
    expect(boundary.run).toHaveBeenCalledTimes(1)
  })

  it('rechecks candidate capability, evidence, operation and admission before every call', async () => {
    const boundary = admission()
    const expired = { ...routes[1], evidenceExpiresAt: '2026-08-14T00:00:00.000Z' }
    boundary.getRoute.mockImplementation((routeId) => routeId === 'model-fallback' ? expired : routes.find((route) => route.routeId === routeId))
    const router = createProviderRouter({ workloadPolicies: workloads, admission: boundary, now: () => new Date('2026-08-15T00:00:00.000Z') })
    const invoke = vi.fn(async () => { throw new ProviderAdapterError('model-retryable') })

    await expect(execute(router, invoke)).rejects.toMatchObject({ failureClass: 'config', retryable: false })
    expect(boundary.getRoute).toHaveBeenCalledWith('primary')
    expect(boundary.getRoute).toHaveBeenCalledWith('model-fallback')
    expect(boundary.admitProviderDomain).toHaveBeenCalledTimes(1)
    expect(boundary.run).toHaveBeenCalledTimes(1)
  })

  it('rejects invalid fallback topology before making another external call', async () => {
    const boundary = admission()
    const invalidRoute = { ...routes[1], providerFailureDomainId: 'domain-b' }
    boundary.getRoute.mockImplementation((routeId) => routeId === 'model-fallback' ? invalidRoute : routes.find((route) => route.routeId === routeId))
    const router = createProviderRouter({ workloadPolicies: workloads, admission: boundary })
    const invoke = vi.fn(async () => { throw new ProviderAdapterError('model-retryable') })

    await expect(execute(router, invoke)).rejects.toMatchObject({ failureClass: 'config' })
    expect(invoke).toHaveBeenCalledTimes(1)
  })

  it('rejects an embedding fallback whose vector dimensions or version differ at runtime', async () => {
    const embeddingRoutes = [
      {
        ...routes[0], routeId: 'embedding-primary', operations: ['embedding'], artifactCompatibilityId: 'bge-m3-v1',
        embeddingDimensions: 1024, embeddingVersion: 1,
      },
      {
        ...routes[2], routeId: 'embedding-provider-fallback', operations: ['embedding'], artifactCompatibilityId: 'bge-m3-v1',
        embeddingDimensions: 768, embeddingVersion: 1,
      },
    ]
    const byId = new Map(embeddingRoutes.map((route) => [route.routeId, route]))
    const boundary = admission()
    boundary.getRoute.mockImplementation((routeId) => byId.get(routeId))
    boundary.run.mockImplementation(async ({ routeId, invoke }) => invoke(byId.get(routeId)))
    const router = createProviderRouter({
      workloadPolicies: [{
        workloadId: 'document-embedding', operation: 'embedding', requiredCapability: 'nonconfidential', maxExternalAttempts: 2,
        primaryRouteId: 'embedding-primary', modelFallbackRouteIds: [], providerFallbackRouteIds: ['embedding-provider-fallback'],
      }],
      admission: boundary,
    })
    const invoke = vi.fn(async () => { throw new ProviderAdapterError('provider-retryable') })

    await expect(router.execute({
      workloadId: 'document-embedding', admittedInput: ['safe'], attemptId: 'attempt-1', invoke,
      validateOutput: ({ output }) => output,
    })).rejects.toMatchObject({ failureClass: 'config', retryable: false })
    expect(invoke).toHaveBeenCalledTimes(1)
  })

  it('uses the dedicated support admission kind for support workloads', async () => {
    const boundary = admission()
    const supportRoute = { ...routes[0], operations: ['support'] }
    boundary.getRoute.mockReturnValue(supportRoute)
    const router = createProviderRouter({
      workloadPolicies: [{ ...workloads[0], operation: 'support', maxExternalAttempts: 1, modelFallbackRouteIds: [], providerFallbackRouteIds: [] }],
      admission: boundary,
    })

    await router.execute({
      workloadId: 'qa-generation', admittedInput: 'safe support input', attemptId: 'attempt-1',
      invoke: async () => ({ verdict: 'supported' }), validateOutput: ({ output }) => output,
    })
    expect(boundary.run).toHaveBeenCalledWith(expect.objectContaining({ kind: 'answer-support' }))
  })

  it('fails closed with safe terminal errors when provider-domain state cannot advance', async () => {
    const beforeCall = admission()
    beforeCall.admitProviderDomain.mockRejectedValue(new Error('mongodb://secret@private/config'))
    const beforeRouter = createProviderRouter({ workloadPolicies: workloads, admission: beforeCall })
    const invoke = vi.fn()

    await expect(execute(beforeRouter, invoke)).rejects.toMatchObject({ failureClass: 'config', retryable: false })
    expect(invoke).not.toHaveBeenCalled()

    const afterCall = admission()
    afterCall.reportProviderDomain.mockRejectedValue(new Error('mongodb://secret@private/state'))
    const afterRouter = createProviderRouter({ workloadPolicies: workloads, admission: afterCall })
    const reported = execute(afterRouter, async () => ({ answer: 'ok' }))
    await expect(reported).rejects.toMatchObject({ failureClass: 'ambiguous', retryable: false })
    await expect(reported).rejects.not.toThrow(/mongodb|secret|private/)
    expect(afterCall.run).toHaveBeenCalledTimes(1)
  })
})
