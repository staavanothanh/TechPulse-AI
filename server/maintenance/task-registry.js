export const MAINTENANCE_TASK_NAMES = Object.freeze([
  'purge-ingestion-jobs',
  'purge-indexing-jobs',
  'purge-answer-attempts',
  'purge-takedown-pii',
  'purge-takedown-workflows',
  'purge-account-deletion-workflows',
  'purge-audit-ip-hmac',
])

const TASK_SET = new Set(MAINTENANCE_TASK_NAMES)

export function createMaintenanceRegistry() {
  const handlers = new Map()
  return Object.freeze({
    register(taskName, handler) {
      if (!TASK_SET.has(taskName) || typeof handler !== 'function') throw new Error('Maintenance task name and handler are invalid')
      if (handlers.has(taskName)) throw new Error('Maintenance task is already registered')
      handlers.set(taskName, handler)
      return handler
    },
    get(taskName) { return handlers.get(taskName) },
    has(taskName) { return handlers.has(taskName) },
  })
}
