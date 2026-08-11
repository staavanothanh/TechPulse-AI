const TERMINAL = new Set(['succeeded', 'partial', 'failed', 'cancelled'])

export function shouldPollIndexingJob(job, { visible = true, online = true } = {}) {
  return Boolean(job && !TERMINAL.has(job.status) && ['queued', 'running'].includes(job.status) && visible && online)
}

export function nextIndexingPollDelay({ elapsedMs = 0, errorCount = 0, retryAfterSeconds } = {}) {
  const base = elapsedMs < 30_000 ? 2_000 : elapsedMs < 120_000 ? 5_000 : 10_000
  const backedOff = Math.min(60_000, base * 2 ** Math.max(0, Math.min(6, errorCount)))
  const retryAfter = Number.isFinite(retryAfterSeconds) && retryAfterSeconds > 0 ? retryAfterSeconds * 1000 : 0
  return Math.max(base, backedOff, retryAfter)
}

export const INDEXING_TERMINAL_STATUSES = TERMINAL
