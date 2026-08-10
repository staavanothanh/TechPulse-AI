import { assertRecoveryStrategy } from './recovery-strategies.js'

export const QUEUE_ORDER = Object.freeze(['account-deletion', 'indexing', 'ingestion'])

function assertAdapter(adapter) {
  if (!adapter || !QUEUE_ORDER.includes(adapter.queueName)) throw new Error('Queue adapter name is invalid')
  assertRecoveryStrategy(adapter.queueName, adapter.recoveryStrategy)
  for (const method of ['selectDue', 'claimAndExecute', 'recoverExpired', 'nextAvailableAt']) {
    if (typeof adapter[method] !== 'function') throw new Error(`Queue adapter ${method} is required`)
  }
}

export function createQueueRegistry() {
  const adapters = new Map()
  return Object.freeze({
    register(adapter) {
      assertAdapter(adapter)
      if (adapters.has(adapter.queueName)) throw new Error('Queue adapter is already registered')
      adapters.set(adapter.queueName, adapter)
      return adapter
    },
    get(queueName) { return adapters.get(queueName) },
    registered() { return QUEUE_ORDER.filter((name) => adapters.has(name)).map((name) => adapters.get(name)) },
    get size() { return adapters.size },
  })
}
