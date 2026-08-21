import { describe, expect, it } from 'vitest'
import { validateProviderConfiguration } from '../../../server/ai/provider-registry.js'

const NOW = new Date('2026-08-21T00:00:00.000Z')

function route({ routeId, providerId = 'gemini', admissionDomainId = 'gemini-main', model, operations, capability = 'nonconfidential', artifactCompatibilityId = null, embeddingDimensions, embeddingVersion }) {
  return {
    routeId, providerId, admissionDomainId, model, operations, capability,
    evidenceUrl: capability === 'zdr-verified' ? 'https://ai.google.dev/gemini-api/docs/zdr' : 'https://ai.google.dev/gemini-api/docs/openai',
    reviewedAt: NOW.toISOString(), evidenceExpiresAt: '2026-11-19T00:00:00.000Z', artifactCompatibilityId,
    ...(embeddingDimensions === undefined ? {} : { embeddingDimensions, embeddingVersion }),
    enabled: true, routeFailureThreshold: 3, routeCooldownSeconds: 60,
  }
}

function graph() {
  return {
    providerFailureDomains: [
      { providerFailureDomainId: 'gemini-control-plane', configVersion: 1, failureThreshold: 3, cooldownSeconds: 60 },
      { providerFailureDomainId: 'openrouter-control-plane', configVersion: 1, failureThreshold: 3, cooldownSeconds: 60 },
    ],
    providers: [
      { providerId: 'gemini', providerFailureDomainId: 'gemini-control-plane', adapterId: 'openai-compatible', trustedEndpointProfileId: 'gemini-ai-studio-openai-v1' },
      { providerId: 'openrouter', providerFailureDomainId: 'openrouter-control-plane', adapterId: 'openai-compatible', trustedEndpointProfileId: 'openrouter-v1' },
    ],
    admissionDomains: [
      { admissionDomainId: 'gemini-main', providerId: 'gemini', credentialEnvName: 'GEMINI_API_KEY', maxConcurrency: 2, budgetLimit: 1000, budgetWindow: 'day' },
      { admissionDomainId: 'openrouter-main', providerId: 'openrouter', credentialEnvName: 'EMBEDDING_API_KEY', maxConcurrency: 2, budgetLimit: 1000, budgetWindow: 'day' },
    ],
    routes: [
      route({ routeId: 'summary-primary', model: 'gemini-2.5-flash', operations: ['summary'] }),
      route({ routeId: 'summary-model-fallback', model: 'gemini-2.5-flash-lite', operations: ['summary'] }),
      route({ routeId: 'qa-primary', model: 'gemini-2.5-flash', operations: ['answer'], capability: 'zdr-verified' }),
      route({ routeId: 'qa-support', model: 'gemini-2.5-flash', operations: ['support'], capability: 'zdr-verified' }),
      route({ routeId: 'embedding-primary', providerId: 'openrouter', admissionDomainId: 'openrouter-main', model: 'baai/bge-m3', operations: ['embedding'], artifactCompatibilityId: 'bge-m3-v1-1024', embeddingDimensions: 1024, embeddingVersion: 1 }),
    ],
    workloadPolicies: [
      { workloadId: 'summary', operation: 'summary', requiredCapability: 'nonconfidential', maxExternalAttempts: 2, primaryRouteId: 'summary-primary', modelFallbackRouteIds: ['summary-model-fallback'], providerFallbackRouteIds: [] },
      { workloadId: 'qa-generation', operation: 'answer', requiredCapability: 'zdr-verified', maxExternalAttempts: 2, primaryRouteId: 'qa-primary', modelFallbackRouteIds: [], providerFallbackRouteIds: [] },
      { workloadId: 'qa-support', operation: 'support', requiredCapability: 'zdr-verified', maxExternalAttempts: 1, primaryRouteId: 'qa-support', modelFallbackRouteIds: [], providerFallbackRouteIds: [] },
      { workloadId: 'embedding', operation: 'embedding', requiredCapability: 'nonconfidential', maxExternalAttempts: 1, primaryRouteId: 'embedding-primary', modelFallbackRouteIds: [], providerFallbackRouteIds: [] },
    ],
  }
}

describe('Gemini LLM provider graph', () => {
  it('routes all LLM workloads to Gemini while retaining OpenRouter BGE-M3 embedding', () => {
    const result = validateProviderConfiguration(graph(), { now: NOW, credentialEnvNames: ['GEMINI_API_KEY', 'EMBEDDING_API_KEY'] })
    expect(result.routes.filter((route) => ['summary', 'answer', 'support'].some((operation) => route.operations.includes(operation)))).toEqual(expect.arrayContaining([
      expect.objectContaining({ providerId: 'gemini', routeId: 'summary-primary' }),
      expect.objectContaining({ providerId: 'gemini', routeId: 'qa-primary' }),
      expect.objectContaining({ providerId: 'gemini', routeId: 'qa-support' }),
    ]))
    expect(result.routes.find((route) => route.routeId === 'embedding-primary')).toMatchObject({ providerId: 'openrouter', model: 'baai/bge-m3', embeddingDimensions: 1024, embeddingVersion: 1 })
    expect(result.workloadPolicies.find((policy) => policy.workloadId === 'summary')).toMatchObject({ providerFallbackRouteIds: [] })
  })

  it('rejects a Q&A route that falsely downgrades the required privacy capability', () => {
    const value = graph()
    value.routes = value.routes.map((route) => route.routeId === 'qa-primary' ? { ...route, capability: 'nonconfidential' } : route)
    expect(() => validateProviderConfiguration(value, { now: NOW, credentialEnvNames: ['GEMINI_API_KEY', 'EMBEDDING_API_KEY'] })).toThrow(/Q&A workload capability|capability/i)
  })
})
