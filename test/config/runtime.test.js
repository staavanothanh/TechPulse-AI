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
  PROVIDER_ADMISSION_DOMAINS_JSON: JSON.stringify([
    {
      admissionDomainId: 'open-code-zen',
      credentialEnvName: 'OPENCODE_ZEN_API_KEY',
      maxConcurrency: 4,
      routes: [{ routeId: 'zen-summary', admissionDomainId: 'open-code-zen', model: 'deepseek-v4-flash-free', capability: 'nonconfidential' }],
    },
  ]),
  INTERNAL_MACHINE_SECRET_ENV: 'CRON_SECRET',
}

describe('Step 1 runtime configuration contract', () => {
  it('accepts names and non-secret provider metadata without reading secret values', () => {
    expect(validateRuntimeConfiguration(validEnvironment).origins).toEqual([
      'http://localhost:3000',
      'https://techpulse.example',
    ])
  })

  it('rejects a credential split across provider admission domains', () => {
    const environment = {
      ...validEnvironment,
      PROVIDER_ADMISSION_DOMAINS_JSON: JSON.stringify([
        {
          admissionDomainId: 'one',
          credentialEnvName: 'SAME_KEY',
          maxConcurrency: 1,
          routes: [{ routeId: 'one-route', admissionDomainId: 'one', model: 'model', capability: 'nonconfidential' }],
        },
        {
          admissionDomainId: 'two',
          credentialEnvName: 'SAME_KEY',
          maxConcurrency: 1,
          routes: [{ routeId: 'two-route', admissionDomainId: 'two', model: 'model', capability: 'nonconfidential' }],
        },
      ]),
    }
    expect(() => validateRuntimeConfiguration(environment)).toThrow(/credential split/)
  })

  it('rejects unsafe origins, keyrings, checkpoint ids and provider bounds', () => {
    expect(() => validateRuntimeConfiguration({ ...validEnvironment, PUBLIC_APP_ORIGINS: 'https://example.com/path' })).toThrow(/origins/)
    expect(() => validateRuntimeConfiguration({ ...validEnvironment, OFFLINE_CHECKPOINT_KEY_IDS: 'unsafe key' })).toThrow(/key IDs/)
    expect(() => validateRuntimeConfiguration({ ...validEnvironment, QUOTA_HMAC_RETIRING_KEY_ENVS: 'OLD_A,OLD_B,OLD_C' })).toThrow(/at most 2/)
    expect(() => validateRuntimeConfiguration({ ...validEnvironment, QUOTA_HMAC_RETIRING_KEY_ENVS: 'QUOTA_HMAC_CURRENT_KEY' })).toThrow(/duplicate\/current/)
    expect(() => validateRuntimeConfiguration({ ...validEnvironment, INTERNAL_MACHINE_SECRET_ENV: 'bad-name' })).toThrow(/environment variable name/)
    expect(() => validateRuntimeConfiguration({ ...validEnvironment, PROVIDER_ADMISSION_DOMAINS_JSON: '{}' })).toThrow(/must be an array/)
    expect(() => validateRuntimeConfiguration({
      ...validEnvironment,
      PROVIDER_ADMISSION_DOMAINS_JSON: JSON.stringify([{
        admissionDomainId: 'bad',
        credentialEnvName: 'KEY',
        maxConcurrency: 9,
        routes: [{ routeId: 'route', admissionDomainId: 'bad', model: 'model', capability: 'nonconfidential' }],
      }]),
    })).toThrow(/maxConcurrency/)
  })
})
