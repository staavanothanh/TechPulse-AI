const DEFAULT_SAVED_MUTATION_COOLDOWN_SECONDS = 60
const MAX_SAVED_MUTATION_COOLDOWN_SECONDS = 300

export function savedMutationCooldownSeconds(error) {
  if (error?.status !== 429) return 0
  const retryAfter = Number(error.retryAfter)
  const seconds = Number.isInteger(retryAfter) && retryAfter > 0 ? retryAfter : DEFAULT_SAVED_MUTATION_COOLDOWN_SECONDS
  return Math.min(seconds, MAX_SAVED_MUTATION_COOLDOWN_SECONDS)
}

export function focusSavedListStatus(statusRef) {
  statusRef?.current?.focus?.()
}
