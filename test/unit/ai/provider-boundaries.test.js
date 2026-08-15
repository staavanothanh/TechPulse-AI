import { describe, expect, it } from 'vitest'
import { validateProviderConfiguration } from '../../../server/ai/provider-registry.js'

const now = new Date('2026-08-10T00:00:00.000Z')

function configuration() {
  return {
    providerFailureDomains: [{ providerFailureDomainId: 'router-control-plane', configVersion: 1, failureThreshold: 3, cooldownSeconds: 60 }],
    providers: [{ providerId: 'router', providerFailureDomainId: 'router-control-plane', adapterId: 'openai-compatible', trustedEndpointProfileId: 'openrouter-v1' }],
    admissionDomains: [{ admissionDomainId: 'router-main', providerId: 'router', credentialEnvName: 'ROUTER_KEY_ENV', maxConcurrency: 2, budgetLimit: 1000, budgetWindow: 'day' }],
    routes: [{
      routeId: 'summary-primary', providerId: 'router', admissionDomainId: 'router-main', model: 'summary/model', operations: ['summary'],
      capability: 'nonconfidential', evidenceUrl: 'https://privacy.example/evidence', reviewedAt: '2026-08-01T00:00:00.000Z',
      evidenceExpiresAt: '2027-08-01T00:00:00.000Z', artifactCompatibilityId: null, enabled: true,
      routeFailureThreshold: 3, routeCooldownSeconds: 60,
    }],
    workloadPolicies: [{ workloadId: 'summary', operation: 'summary', requiredCapability: 'nonconfidential', maxExternalAttempts: 2, primaryRouteId: 'summary-primary', modelFallbackRouteIds: [], providerFallbackRouteIds: [] }],
  }
}

describe('Step 9 provider configuration boundaries', () => {
  it('accepts reviewed exact routes and freezes normalized admission tables', () => {
    const result = validateProviderConfiguration(configuration(), { now })

    expect(result.domains[0]).toEqual(expect.objectContaining({ maxConcurrency: 2, budgetLimit: 1000, providerId: 'router' }))
    expect(result.routes[0]).toEqual(expect.objectContaining({ capability: 'nonconfidential', providerFailureDomainId: 'router-control-plane' }))
    expect(Object.isFrozen(result.routes)).toBe(true)
  })

  it('rejects a credential split across admission domains', () => {
    const value = configuration()
    value.admissionDomains.push({ ...value.admissionDomains[0], admissionDomainId: 'router-secondary' })

    expect(() => validateProviderConfiguration(value, { now })).toThrow(/credential/i)
  })

  it('rejects expired evidence and arbitrary circuit or concurrency settings', () => {
    const expired = configuration()
    expired.routes[0] = { ...expired.routes[0], evidenceExpiresAt: now.toISOString() }
    expect(() => validateProviderConfiguration(expired, { now })).toThrow(/evidence/i)

    const cooldown = configuration()
    cooldown.routes[0] = { ...cooldown.routes[0], routeCooldownSeconds: 30 }
    expect(() => validateProviderConfiguration(cooldown, { now })).toThrow(/cooldown/i)

    const concurrency = configuration()
    concurrency.admissionDomains[0] = { ...concurrency.admissionDomains[0], maxConcurrency: 9 }
    expect(() => validateProviderConfiguration(concurrency, { now })).toThrow(/concurrency/i)
  })
})
