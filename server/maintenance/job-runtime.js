import { closeMaintenanceMongoContext, getMaintenanceMongoContext } from './mongo-context.js'

export const MAINTENANCE_CREDENTIAL_UNAVAILABLE_MESSAGE = 'Audit IP-HMAC maintenance is unavailable until a separate maintenance credential is configured'
export const JOB_RUNTIME_UNAVAILABLE_MESSAGE = 'Durable job service is unavailable'

export async function createProductionJobRuntime({
  runtimeConfig,
  jobOptions,
  createJobRuntime,
  getMaintenanceContext = getMaintenanceMongoContext,
  closeMaintenanceContext = closeMaintenanceMongoContext,
  logError = console.error,
} = {}) {
  if (typeof createJobRuntime !== 'function') throw new Error('Job runtime factory is required')
  let maintenanceContext = null
  try {
    maintenanceContext = await getMaintenanceContext({ runtimeConfig, runtimeClient: jobOptions?.context?.client })
    if (!maintenanceContext) logError(MAINTENANCE_CREDENTIAL_UNAVAILABLE_MESSAGE)
  } catch {
    logError(MAINTENANCE_CREDENTIAL_UNAVAILABLE_MESSAGE)
  }
  try {
    const jobs = await createJobRuntime({ ...jobOptions, maintenanceContext })
    return { jobs, maintenanceContext: jobs?.maintenanceContext ?? maintenanceContext }
  } catch {
    try { await closeMaintenanceContext(maintenanceContext) } catch { /* cleanup is best effort */ }
    logError(JOB_RUNTIME_UNAVAILABLE_MESSAGE)
    return { jobs: {}, maintenanceContext: null }
  }
}
