import { describe, expect, it, vi } from 'vitest'
import {
  createProductionJobRuntime,
  JOB_RUNTIME_UNAVAILABLE_MESSAGE,
  MAINTENANCE_CREDENTIAL_UNAVAILABLE_MESSAGE,
} from '../../../server/maintenance/job-runtime.js'

describe('production maintenance client ownership', () => {
  it('closes and clears the separate client when job bootstrap fails', async () => {
    const maintenanceContext = { client: { id: 'maintenance' }, db: {} }
    const closeMaintenanceContext = vi.fn(async () => undefined)
    const logError = vi.fn()
    const result = await createProductionJobRuntime({
      runtimeConfig: { maintenanceMongo: { uriEnv: 'MONGODB_MAINTENANCE_URI' } },
      jobOptions: { context: { client: { id: 'runtime' } } },
      createJobRuntime: vi.fn(async () => { throw new Error('mongodb://user:secret@private wrong role') }),
      getMaintenanceContext: vi.fn(async () => maintenanceContext),
      closeMaintenanceContext,
      logError,
    })
    expect(result).toEqual({ jobs: {}, maintenanceContext: null })
    expect(closeMaintenanceContext).toHaveBeenCalledWith(maintenanceContext)
    expect(logError).toHaveBeenCalledExactlyOnceWith(JOB_RUNTIME_UNAVAILABLE_MESSAGE)
    expect(JSON.stringify(logError.mock.calls)).not.toContain('secret')
    expect(JSON.stringify(logError.mock.calls)).not.toContain('mongodb://')
  })

  it('continues without audit cleanup when the maintenance credential has the wrong role', async () => {
    const jobs = { jobService: { ready: true } }
    const createJobRuntime = vi.fn(async () => jobs)
    const closeMaintenanceContext = vi.fn()
    const logError = vi.fn()
    const result = await createProductionJobRuntime({
      runtimeConfig: { maintenanceMongo: { uriEnv: 'MONGODB_MAINTENANCE_URI' } },
      jobOptions: { context: { client: { id: 'runtime' } } },
      createJobRuntime,
      getMaintenanceContext: vi.fn(async () => { throw new Error('not authorized: mongodb://user:secret@private') }),
      closeMaintenanceContext,
      logError,
    })
    expect(result).toEqual({ jobs, maintenanceContext: null })
    expect(createJobRuntime).toHaveBeenCalledWith(expect.objectContaining({ maintenanceContext: null }))
    expect(closeMaintenanceContext).not.toHaveBeenCalled()
    expect(logError).toHaveBeenCalledExactlyOnceWith(MAINTENANCE_CREDENTIAL_UNAVAILABLE_MESSAGE)
    expect(JSON.stringify(logError.mock.calls)).not.toContain('secret')
  })
})
