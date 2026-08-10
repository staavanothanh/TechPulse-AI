export const RECOVERY_STRATEGIES = Object.freeze({
  ingestion: 'terminal-parent-linked-retry',
  indexing: 'terminal-parent-linked-retry',
  'account-deletion': 'same-request-requeue',
})

export function assertRecoveryStrategy(queueName, strategy) {
  if (RECOVERY_STRATEGIES[queueName] !== strategy) throw new Error('Queue recovery strategy is invalid')
  return strategy
}
