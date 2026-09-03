import { closeMaintenanceMongoContext, getMaintenanceMongoContext } from './mongo-context.js'
import { probeCronObservabilityMaintenanceRoleCapabilities } from '../../scripts/mongo-role-probe.js'
export const MAINTENANCE_CREDENTIAL_UNAVAILABLE_MESSAGE = 'Cron lifecycle and audit IP-HMAC maintenance are unavailable until a separate maintenance credential is configured'
export const JOB_RUNTIME_UNAVAILABLE_MESSAGE = 'Durable job service is unavailable'

export async function createProductionJobRuntime({
  runtimeConfig,
  jobOptions,
  createJobRuntime,
  getMaintenanceContext = getMaintenanceMongoContext,
  closeMaintenanceContext = closeMaintenanceMongoContext,
  verifyMaintenanceRole = probeCronObservabilityMaintenanceRoleCapabilities,
  environment = process.env,
  logError = console.error,
} = {}) {
  if (typeof createJobRuntime !== 'function') throw new Error('Job runtime factory is required')
  let maintenanceContext = null
  try {
    maintenanceContext = await getMaintenanceContext({ runtimeConfig, runtimeClient: jobOptions?.context?.client, environment })
    if (maintenanceContext) {
      const capability = await verifyMaintenanceRole({
        environment,
        database: runtimeConfig?.maintenanceMongo?.database ?? runtimeConfig?.mongo?.database,
        runtimeUriEnv: runtimeConfig?.mongo?.uriEnv,
        runtimeDb: jobOptions?.context?.db,
        maintenanceClient: maintenanceContext.client,
        closeClient: false,
      })
      if (!Object.values(capability ?? {}).every(Boolean)) {
        await closeMaintenanceContext(maintenanceContext)
        maintenanceContext = null
        logError(MAINTENANCE_CREDENTIAL_UNAVAILABLE_MESSAGE)
      }
    } else logError(MAINTENANCE_CREDENTIAL_UNAVAILABLE_MESSAGE)
  } catch {
    if (maintenanceContext) {
      try { await closeMaintenanceContext(maintenanceContext) } catch { /* cleanup is best effort */ }
    }
    maintenanceContext = null
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
