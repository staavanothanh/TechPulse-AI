import { describe, expect, it } from 'vitest'
import { validateProviderConfiguration } from '../../../server/ai/provider-registry.js'

const NOW = new Date('2026-08-10T00:00:00.000Z')

function graph() {
  return {
    providerFailureDomains: [
      { providerFailureDomainId: 'zen-control-plane', configVersion: 1, failureThreshold: 3, cooldownSeconds: 60 },
      { providerFailureDomainId: 'router-control-plane', configVersion: 1, failureThreshold: 3, cooldownSeconds: 60 },
    ],
    providers: [
      { providerId: 'zen', providerFailureDomainId: 'zen-control-plane', adapterId: 'openai-compatible', trustedEndpointProfileId: 'opencode-zen-v1' },
      { providerId: 'router', providerFailureDomainId: 'router-control-plane', adapterId: 'openai-compatible', trustedEndpointProfileId: 'openrouter-v1' },
    ],
    admissionDomains: [
      { admissionDomainId: 'zen-main', providerId: 'zen', credentialEnvName: 'ZEN_KEY_ENV', maxConcurrency: 2, budgetLimit: 1000, budgetWindow: 'day' },
      { admissionDomainId: 'router-main', providerId: 'router', credentialEnvName: 'ROUTER_KEY_ENV', maxConcurrency: 2, budgetLimit: 1000, budgetWindow: 'day' },
    ],
    routes: [
      route({ routeId: 'summary-primary', providerId: 'zen', admissionDomainId: 'zen-main', model: 'model-a', operations: ['summary'] }),
      route({ routeId: 'summary-model-fallback', providerId: 'zen', admissionDomainId: 'zen-main', model: 'model-b', operations: ['summary'] }),
      route({ routeId: 'summary-provider-fallback', providerId: 'router', admissionDomainId: 'router-main', model: 'model-c', operations: ['summary'] }),
      route({ routeId: 'qa-primary', providerId: 'zen', admissionDomainId: 'zen-main', model: 'qa-a', operations: ['answer'], capability: 'zdr-verified' }),
      route({ routeId: 'qa-provider-fallback', providerId: 'router', admissionDomainId: 'router-main', model: 'qa-b', operations: ['answer'], capability: 'zdr-verified' }),
      route({ routeId: 'embedding-primary', providerId: 'router', admissionDomainId: 'router-main', model: 'embed-a', operations: ['embedding'], artifactCompatibilityId: 'vi-embed-v1-1024', embeddingDimensions: 1024, embeddingVersion: 1 }),
    ],
    workloadPolicies: [
      { workloadId: 'summary', operation: 'summary', requiredCapability: 'nonconfidential', maxExternalAttempts: 2, primaryRouteId: 'summary-primary', modelFallbackRouteIds: ['summary-model-fallback'], providerFallbackRouteIds: ['summary-provider-fallback'] },
      { workloadId: 'qa-generation', operation: 'answer', requiredCapability: 'zdr-verified', maxExternalAttempts: 2, primaryRouteId: 'qa-primary', modelFallbackRouteIds: [], providerFallbackRouteIds: ['qa-provider-fallback'] },
      { workloadId: 'embedding', operation: 'embedding', requiredCapability: 'nonconfidential', maxExternalAttempts: 1, primaryRouteId: 'embedding-primary', modelFallbackRouteIds: [], providerFallbackRouteIds: [] },
    ],
  }
}

function route(overrides) {
  return {
    capability: 'nonconfidential', evidenceUrl: 'https://privacy.example/evidence',
    reviewedAt: '2026-08-01T00:00:00.000Z', evidenceExpiresAt: '2027-08-01T00:00:00.000Z',
    artifactCompatibilityId: null, enabled: true, routeFailureThreshold: 3, routeCooldownSeconds: 60,
    ...overrides,
  }
}

function replaceById(items, idKey, id, transform) {
  return items.map((item) => item[idKey] === id ? transform(item) : item)
}

describe('ADR-0013 provider configuration graph', () => {
  it('normalizes and deeply freezes a valid protocol-driven graph', () => {
    const result = validateProviderConfiguration(graph(), { now: NOW })

    expect(result.providers[0]).toMatchObject({ adapterId: 'openai-compatible', trustedEndpointProfileId: 'opencode-zen-v1' })
    expect(result.routes[0]).toMatchObject({ providerFailureDomainId: 'zen-control-plane', adapterId: 'openai-compatible' })
    expect(result.domains).toBe(result.admissionDomains)
    expect(Object.isFrozen(result.workloadPolicies[0].modelFallbackRouteIds)).toBe(true)
    expect(Object.isFrozen(result)).toBe(true)
  })

  it('keeps only the explicit empty legacy array as a safe text-only compatibility input', () => {
    expect(validateProviderConfiguration([], { now: NOW })).toMatchObject({ routes: [], workloadPolicies: [] })
    expect(() => validateProviderConfiguration([{ admissionDomainId: 'legacy' }], { now: NOW })).toThrow(/legacy|graph/i)
  })

  it.each([
    ['duplicate', (value) => ({ ...value, providers: [...value.providers, value.providers[0]] })],
    ['dangling', (value) => ({ ...value, providers: replaceById(value.providers, 'providerId', 'zen', (item) => ({ ...item, providerFailureDomainId: 'missing-domain' })) })],
    ['cycle', (value) => ({ ...value, workloadPolicies: replaceById(value.workloadPolicies, 'workloadId', 'summary', (item) => ({ ...item, providerFallbackRouteIds: ['summary-primary'] })) })],
  ])('rejects %s graph references', (_label, mutate) => {
    expect(() => validateProviderConfiguration(mutate(graph()), { now: NOW })).toThrow(/duplicate|dangling|cycle|fallback/i)
  })

  it('rejects provider/admission mismatch and credential splits', () => {
    const mismatch = graph()
    mismatch.routes = replaceById(mismatch.routes, 'routeId', 'summary-primary', (item) => ({ ...item, providerId: 'router' }))
    expect(() => validateProviderConfiguration(mismatch, { now: NOW })).toThrow(/provider.*admission|mismatch/i)

    const split = graph()
    split.admissionDomains = replaceById(split.admissionDomains, 'admissionDomainId', 'router-main', (item) => ({ ...item, credentialEnvName: 'ZEN_KEY_ENV' }))
    expect(() => validateProviderConfiguration(split, { now: NOW })).toThrow(/credential/i)

    expect(() => validateProviderConfiguration(graph(), { now: NOW, credentialEnvNames: ['ZEN_KEY_ENV'] })).toThrow(/credential.*missing/i)
    expect(() => validateProviderConfiguration(graph(), { now: NOW, credentialEnvNames: 'ZEN_KEY_ENV' })).toThrow(/credential.*invalid/i)
  })

  it('rejects arbitrary endpoints, inline credentials, and unsafe trusted redirect profiles', () => {
    const endpoint = graph()
    endpoint.providers = replaceById(endpoint.providers, 'providerId', 'zen', (item) => ({ ...item, endpointUrl: 'https://attacker.example/v1' }))
    expect(() => validateProviderConfiguration(endpoint, { now: NOW })).toThrow(/endpoint|field/i)

    const credential = graph()
    credential.admissionDomains = replaceById(credential.admissionDomains, 'admissionDomainId', 'zen-main', (item) => ({ ...item, credential: 'secret' }))
    expect(() => validateProviderConfiguration(credential, { now: NOW })).toThrow(/credential|field/i)

    const unsafeProfiles = [{ trustedEndpointProfileId: 'opencode-zen-v1', adapterId: 'openai-compatible', operationEndpoints: { summary: 'https://opencode.ai/zen/v1/chat/completions', answer: 'https://opencode.ai/zen/v1/chat/completions' }, allowRedirects: true }]
    expect(() => validateProviderConfiguration(graph(), { now: NOW, trustedEndpointProfiles: unsafeProfiles })).toThrow(/redirect/i)

    const unsafeEndpointProfiles = [{ trustedEndpointProfileId: 'unsafe', adapterId: 'openai-compatible', operationEndpoints: { summary: 'http://provider.example/v1/chat' }, allowRedirects: false }]
    expect(() => validateProviderConfiguration({ providerFailureDomains: [], providers: [], admissionDomains: [], routes: [], workloadPolicies: [] }, { now: NOW, trustedEndpointProfiles: unsafeEndpointProfiles })).toThrow(/HTTPS/i)
  })

  it('rejects unsupported operations and expired route evidence', () => {
    const unsupported = graph()
    unsupported.routes = replaceById(unsupported.routes, 'routeId', 'summary-primary', (item) => ({ ...item, operations: ['embedding'] }))
    expect(() => validateProviderConfiguration(unsupported, { now: NOW })).toThrow(/operation/i)

    const expired = graph()
    expired.routes = replaceById(expired.routes, 'routeId', 'summary-primary', (item) => ({ ...item, evidenceExpiresAt: NOW.toISOString() }))
    expect(() => validateProviderConfiguration(expired, { now: NOW })).toThrow(/evidence/i)
  })

  it('rejects fallback topology mismatch, capability downgrade, and duplicate route membership', () => {
    const topology = graph()
    topology.workloadPolicies = replaceById(topology.workloadPolicies, 'workloadId', 'summary', (item) => ({ ...item, modelFallbackRouteIds: ['summary-provider-fallback'], providerFallbackRouteIds: [] }))
    expect(() => validateProviderConfiguration(topology, { now: NOW })).toThrow(/model fallback|failure domain/i)

    const downgrade = graph()
    downgrade.routes = replaceById(downgrade.routes, 'routeId', 'qa-provider-fallback', (item) => ({ ...item, capability: 'nonconfidential' }))
    expect(() => validateProviderConfiguration(downgrade, { now: NOW })).toThrow(/capability/i)

    const duplicate = graph()
    duplicate.workloadPolicies = replaceById(duplicate.workloadPolicies, 'workloadId', 'summary', (item) => ({ ...item, modelFallbackRouteIds: ['summary-model-fallback', 'summary-model-fallback'] }))
    expect(() => validateProviderConfiguration(duplicate, { now: NOW })).toThrow(/duplicate|cycle/i)
  })

  it('requires exactly two external attempts for summary and Q&A generation', () => {
    for (const workloadId of ['summary', 'qa-generation']) {
      const value = graph()
      value.workloadPolicies = replaceById(value.workloadPolicies, 'workloadId', workloadId, (item) => ({ ...item, maxExternalAttempts: 3 }))
      expect(() => validateProviderConfiguration(value, { now: NOW })).toThrow(/maxExternalAttempts|two/i)
    }
  })

  it('rejects embedding fallbacks from a different artifact compatibility space', () => {
    const value = graph()
    value.routes.push(route({ routeId: 'embedding-fallback', providerId: 'router', admissionDomainId: 'router-main', model: 'embed-b', operations: ['embedding'], artifactCompatibilityId: 'vi-embed-v2-768', embeddingDimensions: 768, embeddingVersion: 2 }))
    value.workloadPolicies = replaceById(value.workloadPolicies, 'workloadId', 'embedding', (item) => ({ ...item, modelFallbackRouteIds: ['embedding-fallback'] }))

    expect(() => validateProviderConfiguration(value, { now: NOW })).toThrow(/artifactCompatibilityId|compatibility/i)

    const inconsistent = graph()
    inconsistent.routes.push(route({ routeId: 'embedding-fallback', providerId: 'router', admissionDomainId: 'router-main', model: 'embed-b', operations: ['embedding'], artifactCompatibilityId: 'vi-embed-v1-1024', embeddingDimensions: 768, embeddingVersion: 1 }))
    inconsistent.workloadPolicies = replaceById(inconsistent.workloadPolicies, 'workloadId', 'embedding', (item) => ({ ...item, maxExternalAttempts: 2, modelFallbackRouteIds: ['embedding-fallback'] }))
    expect(() => validateProviderConfiguration(inconsistent, { now: NOW })).toThrow(/dimensions|compatibility/i)
  })

  it('requires bounded embedding dimensions/version only on embedding routes', () => {
    for (const patch of [{ embeddingDimensions: 0 }, { embeddingDimensions: 4097 }, { embeddingVersion: 0 }]) {
      const value = graph()
      value.routes = replaceById(value.routes, 'routeId', 'embedding-primary', (item) => ({ ...item, ...patch }))
      expect(() => validateProviderConfiguration(value, { now: NOW })).toThrow(/embedding.*dimensions|embedding.*version/i)
    }
    const missing = graph()
    missing.routes = replaceById(missing.routes, 'routeId', 'embedding-primary', ({ embeddingDimensions: _dimensions, ...item }) => item)
    expect(() => validateProviderConfiguration(missing, { now: NOW })).toThrow(/embedding.*dimensions/i)
    const nonEmbedding = graph()
    nonEmbedding.routes = replaceById(nonEmbedding.routes, 'routeId', 'summary-primary', (item) => ({ ...item, embeddingDimensions: 1024, embeddingVersion: 1 }))
    expect(() => validateProviderConfiguration(nonEmbedding, { now: NOW })).toThrow(/embedding|unsupported field/i)
  })
  it('accepts only a single no-fallback qa-intent planner attempt', () => {
    const value = graph()
    value.workloadPolicies.push({ workloadId: 'qa-intent', operation: 'summary', requiredCapability: 'nonconfidential', maxExternalAttempts: 1, primaryRouteId: 'summary-primary', modelFallbackRouteIds: [], providerFallbackRouteIds: [] })
    expect(validateProviderConfiguration(value, { now: NOW }).workloadPolicies).toEqual(expect.arrayContaining([expect.objectContaining({ workloadId: 'qa-intent', maxExternalAttempts: 1 })]))

    for (const patch of [
      { maxExternalAttempts: 2 },
      { modelFallbackRouteIds: ['summary-model-fallback'] },
      { providerFallbackRouteIds: ['summary-provider-fallback'] },
      { operation: 'answer' },
    ]) {
      const invalid = graph()
      invalid.workloadPolicies.push({ workloadId: 'qa-intent', operation: 'summary', requiredCapability: 'nonconfidential', maxExternalAttempts: 1, primaryRouteId: 'summary-primary', modelFallbackRouteIds: [], providerFallbackRouteIds: [], ...patch })
      expect(() => validateProviderConfiguration(invalid, { now: NOW })).toThrow(/qa-intent|attempt|fallback|operation/i)
    }
  })
})
