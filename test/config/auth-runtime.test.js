import { describe, expect, it } from 'vitest'
import { validateRuntimeConfiguration } from '../../server/config/runtime.js'

const validEnvironment = {
  PUBLIC_APP_ORIGINS: 'http://localhost:3000,https://techpulse.example',
  MONGODB_URI_ENV: 'MONGODB_URI',
  MONGODB_DATABASE: 'techpulse_app',
  QUOTA_HMAC_CURRENT_KEY_ENV: 'QUOTA_HMAC_CURRENT_KEY',
  QUOTA_HMAC_RETIRING_KEY_ENVS: 'QUOTA_HMAC_OLD_1,QUOTA_HMAC_OLD_2',
  QUOTA_HMAC_CURRENT_KEY_VERSION: '10',
  QUOTA_HMAC_RETIRING_KEY_VERSIONS: '8,9',
  GOVERNANCE_SIGNING_CURRENT_KEY_ENV: 'GOVERNANCE_SIGNING_CURRENT_KEY',
  GOVERNANCE_SIGNING_RETIRING_KEY_ENVS: 'GOVERNANCE_SIGNING_OLD',
  OFFLINE_CHECKPOINT_KEY_IDS: 'checkpoint-current,checkpoint-old',
  PROVIDER_ADMISSION_DOMAINS_JSON: '[]',
  INTERNAL_MACHINE_SECRET_ENV: 'CRON_SECRET',
}

describe('Step 2 runtime and keyring configuration', () => {
  it('accepts Mongo config and exposes exactly one current plus retiring key versions', () => {
    const config = validateRuntimeConfiguration(validEnvironment)
    expect(config.mongo).toEqual({ uriEnv: 'MONGODB_URI', database: 'techpulse_app' })
    expect(config.quotaKeyring.currentEnv).toBe('QUOTA_HMAC_CURRENT_KEY')
    expect(config.quotaKeyring.currentVersion).toBe(10)
    expect(config.quotaKeyring.acceptsVersion(8)).toBe(true)
    expect(config.quotaKeyring.acceptsVersion(9)).toBe(true)
    expect(config.quotaKeyring.acceptsVersion(4)).toBe(false)
  })

  it('rejects missing or unsafe Mongo settings without exposing secret values', () => {
    expect(() => validateRuntimeConfiguration({ ...validEnvironment, MONGODB_URI_ENV: undefined })).toThrow(/MongoDB URI env/)
    expect(() => validateRuntimeConfiguration({ ...validEnvironment, MONGODB_DATABASE: 'techpulse-app' })).toThrow(/database name/)
    expect(() => validateRuntimeConfiguration({ ...validEnvironment, MONGODB_DATABASE: 'local' })).toThrow(/database name/)
    expect(() => validateRuntimeConfiguration({ ...validEnvironment, QUOTA_HMAC_RETIRING_KEY_ENVS: 'OLD_A,OLD_B,OLD_C' })).toThrow(
      /at most 2/,
    )
    expect(() => validateRuntimeConfiguration({ ...validEnvironment, QUOTA_HMAC_RETIRING_KEY_ENVS: 'QUOTA_HMAC_CURRENT_KEY' })).toThrow(
      /duplicate\/current/,
    )
    expect(() => validateRuntimeConfiguration({ ...validEnvironment, QUOTA_HMAC_RETIRING_KEY_VERSIONS: '9,11' })).toThrow(/monotonic predecessors/)
  })

})
