import { MAINTENANCE_TASK_NAMES } from './task-registry.js'

const TASK_SET = new Set(MAINTENANCE_TASK_NAMES)
const MAX_BATCH = 100

export class MaintenanceError extends Error {
  constructor(status, code, message) {
    super(message)
    this.name = 'MaintenanceError'
    this.status = status
    this.code = code
  }
}

function boundedCount(value, label) {
  if (!Number.isInteger(value) || value < 0 || value > MAX_BATCH) throw new Error(`Maintenance ${label} is invalid`)
  return value
}

export function createMaintenanceRunner({ registry, now = () => new Date() } = {}) {
  if (!registry || typeof registry.get !== 'function') throw new Error('Maintenance registry is required')
  return Object.freeze({
    async run(taskName) {
      if (!TASK_SET.has(taskName)) throw new MaintenanceError(400, 'bad_request', 'Maintenance task name is invalid')
      const handler = registry.get(taskName)
      if (!handler) throw new MaintenanceError(409, 'conflict', 'Maintenance task is not registered in this step')
      const cutoff = now()
      if (!(cutoff instanceof Date) || Number.isNaN(cutoff.getTime())) throw new Error('Maintenance clock is invalid')
      const result = await handler({ cutoff, limit: MAX_BATCH })
      return {
        taskName,
        inspected: boundedCount(result?.inspected ?? 0, 'inspected count'),
        affected: boundedCount(result?.affected ?? 0, 'affected count'),
        hasMore: Boolean(result?.hasMore),
        completedAt: now(),
      }
    },
  })
}

export const MAINTENANCE_MAX_BATCH = MAX_BATCH
