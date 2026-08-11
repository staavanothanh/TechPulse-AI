import { describe, expect, it } from 'vitest'
import { validateProviderConfiguration } from '../../../server/ai/provider-registry.js'

const future = '2027-08-10T00:00:00.000Z'
const reviewed = '2026-08-01T00:00:00.000Z'
const evidence = 'https://privacy.example.com/evidence'

function domain(overrides = {}) {
  return {
    admissionDomainId: 'openrouter-main',
    provider: 'openrouter',
    credentialEnvName: 'OPENROUTER_KEY_ENV',
    maxConcurrency: 2,
    budgetLimit: 1000,
    budgetWindow: 'day',
    routes: [{
      routeId: 'summary-primary', admissionDomainId: 'openrouter-main', model: 'deepseek/chat',
      capability: 'nonconfidential', evidenceUrl: evidence, reviewedAt: reviewed,
      evidenceExpiresAt: future, enabled: true, retryableFailureThreshold: 3, cooldownSeconds: 60,
    }],
    ...overrides,
  }
}

describe('Step 9 static provider capability registry', () => {
  it('accepts reviewed exact routes and freezes the normalized tables', () => {
    const result = validateProviderConfiguration([domain()], { now: new Date('2026-08-10T00:00:00.000Z') })
    expect(result.domains[0]).toEqual(expect.objectContaining({ maxConcurrency: 2, budgetLimit: 1000 }))
    expect(result.routes[0]).toEqual(expect.objectContaining({ capability: 'nonconfidential', retryableFailureThreshold: 3, cooldownSeconds: 60 }))
    expect(Object.isFrozen(result.routes)).toBe(true)
  })

  it('rejects a credential split across admission domains', () => {
    const split = domain({
      admissionDomainId: 'second-domain',
      routes: [{ ...domain().routes[0], routeId: 'summary-fallback', admissionDomainId: 'second-domain', model: 'fallback/chat' }],
    })
    expect(() => validateProviderConfiguration([domain(), split], { now: new Date('2026-08-10T00:00:00.000Z') })).toThrow(/credential/i)
  })

  it('rejects expired evidence, arbitrary circuit settings and concurrency above eight', () => {
    expect(() => validateProviderConfiguration([domain({ routes: [{ ...domain().routes[0], evidenceExpiresAt: reviewed }] })], { now: new Date('2026-08-10T00:00:00.000Z') })).toThrow(/evidence/i)
    expect(() => validateProviderConfiguration([domain({ routes: [{ ...domain().routes[0], cooldownSeconds: 30 }] })])).toThrow(/cooldown/i)
    expect(() => validateProviderConfiguration([domain({ maxConcurrency: 9 })])).toThrow(/concurrency/i)
  })
})
