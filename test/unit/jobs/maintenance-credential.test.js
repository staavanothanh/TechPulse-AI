import { describe, expect, it, vi } from 'vitest'
import { createMaintenanceMongoContext, getMaintenanceMongoContext } from '../../../server/maintenance/mongo-context.js'
import { validateRuntimeConfiguration } from '../../../server/config/runtime.js'

describe('audit HMAC maintenance credential boundary', () => {
  it('keeps maintenance URI configuration separate from the runtime URI configuration', () => {
    const environment = {
      PUBLIC_APP_ORIGINS: 'http://localhost:3000', MONGODB_URI_ENV: 'MONGODB_URI', MONGODB_DATABASE: 'techpulse_app',
      MONGODB_MAINTENANCE_URI_ENV: 'MONGODB_MAINTENANCE_URI', QUOTA_HMAC_CURRENT_KEY_ENV: 'QUOTA', QUOTA_HMAC_RETIRING_KEY_ENVS: '',
      GOVERNANCE_SIGNING_CURRENT_KEY_ENV: 'GOVERNANCE', GOVERNANCE_SIGNING_RETIRING_KEY_ENVS: '', OFFLINE_CHECKPOINT_KEY_IDS: 'checkpoint-current',
      PROVIDER_ADMISSION_DOMAINS_JSON: '[]', INTERNAL_MACHINE_SECRET_ENV: 'CRON_SECRET', CRON_SECRET: 'test-machine-secret-0123456789abcd',
    }
    expect(validateRuntimeConfiguration(environment).maintenanceMongo).toEqual({ uriEnv: 'MONGODB_MAINTENANCE_URI', database: 'techpulse_app' })
    expect(() => validateRuntimeConfiguration({ ...environment, MONGODB_MAINTENANCE_URI_ENV: 'MONGODB_URI' })).toThrow(/separate/i)
  })

  it('fails closed when the maintenance URI env is not configured', async () => {
    await expect(getMaintenanceMongoContext({
      runtimeConfig: { mongo: { uriEnv: 'MONGODB_URI', database: 'techpulse_app' }, maintenanceMongo: null },
      environment: { MONGODB_URI: 'mongodb://runtime-only' },
    })).resolves.toBeNull()
  })

  it('rejects reusing the runtime URI or runtime client', async () => {
    const runtimeClient = { db: () => ({}) }
    await expect(getMaintenanceMongoContext({
      runtimeConfig: { mongo: { uriEnv: 'MONGODB_URI', database: 'techpulse_app' }, maintenanceMongo: { uriEnv: 'MONGODB_MAINTENANCE_URI', database: 'techpulse_app' } },
      environment: { MONGODB_URI: 'mongodb://same', MONGODB_MAINTENANCE_URI: 'mongodb://same' },
      clientFactory: vi.fn(),
    })).rejects.toThrow(/separate/i)
    expect(() => createMaintenanceMongoContext({ client: runtimeClient, runtimeClient, database: 'techpulse_app' })).toThrow(/separate/i)
  })

  it('connects a separate client without exposing URI or secret values', async () => {
    const client = { connect: vi.fn(async () => undefined), close: vi.fn(async () => undefined), db: () => ({}) }
    const clientFactory = vi.fn(() => client)
    const result = await getMaintenanceMongoContext({
      runtimeConfig: { mongo: { uriEnv: 'MONGODB_URI', database: 'techpulse_app' }, maintenanceMongo: { uriEnv: 'MONGODB_MAINTENANCE_URI', database: 'techpulse_app' } },
      environment: { MONGODB_URI: 'mongodb://runtime', MONGODB_MAINTENANCE_URI: 'mongodb://maintenance' },
      clientFactory,
    })
    expect(clientFactory).toHaveBeenCalledWith('mongodb://maintenance')
    expect(client.connect).toHaveBeenCalledOnce()
    expect(result).toEqual(expect.objectContaining({ client, database: 'techpulse_app' }))
  })

  it('closes a maintenance client when connection setup fails', async () => {
    const client = { connect: vi.fn(async () => { throw new Error('connection failed') }), close: vi.fn(async () => undefined) }
    await expect(getMaintenanceMongoContext({
      runtimeConfig: { mongo: { uriEnv: 'MONGODB_URI', database: 'techpulse_app' }, maintenanceMongo: { uriEnv: 'MONGODB_MAINTENANCE_URI', database: 'techpulse_app' } },
      environment: { MONGODB_URI: 'mongodb://runtime', MONGODB_MAINTENANCE_URI: 'mongodb://maintenance' },
      clientFactory: () => client,
    })).rejects.toThrow('connection failed')
    expect(client.close).toHaveBeenCalledOnce()
  })
})
