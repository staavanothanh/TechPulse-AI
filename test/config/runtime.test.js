import { describe, expect, it } from 'vitest'
import { validateRuntimeConfiguration } from '../../server/config/runtime.js'

const validEnvironment = {
  PUBLIC_APP_ORIGINS: 'http://localhost:3000,https://techpulse.example',
  MONGODB_URI_ENV: 'MONGODB_URI',
  MONGODB_DATABASE: 'techpulse_app',
  QUOTA_HMAC_CURRENT_KEY_ENV: 'QUOTA_HMAC_CURRENT_KEY',
  QUOTA_HMAC_RETIRING_KEY_ENVS: 'QUOTA_HMAC_OLD_1,QUOTA_HMAC_OLD_2',
  QUOTA_HMAC_CURRENT_KEY_VERSION: '3',
  QUOTA_HMAC_RETIRING_KEY_VERSIONS: '1,2',
  GOVERNANCE_SIGNING_CURRENT_KEY_ENV: 'GOVERNANCE_SIGNING_CURRENT_KEY',
  GOVERNANCE_SIGNING_RETIRING_KEY_ENVS: 'GOVERNANCE_SIGNING_OLD',
  OFFLINE_CHECKPOINT_KEY_IDS: 'checkpoint-current,checkpoint-old',
  PROVIDER_ADMISSION_DOMAINS_JSON: JSON.stringify({
    providerFailureDomains: [
      { providerFailureDomainId: 'provider-main', configVersion: 1, failureThreshold: 3, cooldownSeconds: 60 },
    ],
    providers: [
      { providerId: 'provider-main', providerFailureDomainId: 'provider-main', adapterId: 'openai-compatible', trustedEndpointProfileId: 'opencode-zen-v1' },
    ],
    admissionDomains: [
      { admissionDomainId: 'provider-main', providerId: 'provider-main', credentialEnvName: 'PROVIDER_MAIN_API_KEY', maxConcurrency: 4, budgetLimit: 1000, budgetWindow: 'day' },
    ],
    routes: [
      { routeId: 'summary-primary', providerId: 'provider-main', admissionDomainId: 'provider-main', model: 'model-a', operations: ['summary'], capability: 'nonconfidential', evidenceUrl: 'https://privacy.example/evidence', reviewedAt: '2026-01-01T00:00:00.000Z', evidenceExpiresAt: '2099-01-01T00:00:00.000Z', artifactCompatibilityId: null, enabled: true, routeFailureThreshold: 3, routeCooldownSeconds: 60 },
      { routeId: 'summary-model-fallback', providerId: 'provider-main', admissionDomainId: 'provider-main', model: 'model-b', operations: ['summary'], capability: 'nonconfidential', evidenceUrl: 'https://privacy.example/evidence', reviewedAt: '2026-01-01T00:00:00.000Z', evidenceExpiresAt: '2099-01-01T00:00:00.000Z', artifactCompatibilityId: null, enabled: true, routeFailureThreshold: 3, routeCooldownSeconds: 60 },
    ],
    workloadPolicies: [
      { workloadId: 'summary', operation: 'summary', requiredCapability: 'nonconfidential', maxExternalAttempts: 2, primaryRouteId: 'summary-primary', modelFallbackRouteIds: ['summary-model-fallback'], providerFallbackRouteIds: [] },
    ],
  }),
  PROVIDER_MAIN_API_KEY: 'test-only-secret',
  INTERNAL_MACHINE_SECRET_ENV: 'CRON_SECRET',
}

describe('Step 1 runtime configuration contract', () => {
  it('accepts provider metadata without returning credential values', () => {
    const runtime = validateRuntimeConfiguration(validEnvironment)
    expect(runtime.origins).toEqual([
      'http://localhost:3000',
      'https://techpulse.example',
    ])
    expect(runtime.providerRegistry.workloadPolicies[0]).toMatchObject({
      workloadId: 'summary',
      modelFallbackRouteIds: ['summary-model-fallback'],
    })
    expect(runtime).not.toHaveProperty('providerAdmissionDomains')
  })

  it('rejects a missing credential reference without exposing its value', () => {
    const environment = {
      ...validEnvironment,
    }
    delete environment.PROVIDER_MAIN_API_KEY
    expect(() => validateRuntimeConfiguration(environment)).toThrow(/credential.*missing/i)
  })

  it('rejects unsafe origins, keyrings, checkpoint ids and provider bounds', () => {
    expect(() => validateRuntimeConfiguration({ ...validEnvironment, PUBLIC_APP_ORIGINS: 'https://example.com/path' })).toThrow(/origins/)
    expect(() => validateRuntimeConfiguration({ ...validEnvironment, OFFLINE_CHECKPOINT_KEY_IDS: 'unsafe key' })).toThrow(/key IDs/)
    expect(() => validateRuntimeConfiguration({ ...validEnvironment, QUOTA_HMAC_RETIRING_KEY_ENVS: 'OLD_A,OLD_B,OLD_C' })).toThrow(/at most 2/)
    expect(() => validateRuntimeConfiguration({ ...validEnvironment, QUOTA_HMAC_RETIRING_KEY_ENVS: 'QUOTA_HMAC_CURRENT_KEY' })).toThrow(/duplicate\/current/)
    expect(() => validateRuntimeConfiguration({ ...validEnvironment, INTERNAL_MACHINE_SECRET_ENV: 'bad-name' })).toThrow(/environment variable name/)
    expect(() => validateRuntimeConfiguration({ ...validEnvironment, PROVIDER_ADMISSION_DOMAINS_JSON: '[{}]' })).toThrow(/legacy|graph/i)
  })
})
