const TASK_ORDER = Object.freeze(['summary', 'embedding', 'visibility-reconcile'])
const TASK_CONCURRENCY = Object.freeze({ summary: 3, embedding: 2, 'visibility-reconcile': 1 })
const TASK_START_GUARD_MS = Object.freeze({ summary: 35_000, embedding: 25_000, 'visibility-reconcile': 5_000 })
const EMPTY_COUNTERS = Object.freeze({ claimed: 0, succeeded: 0, partial: 0, failed: 0, deferred: 0 })

function validDate(value, label) {
  if (!(value instanceof Date) || Number.isNaN(value.getTime())) throw new Error(`${label} is invalid`)
  return value
}

function recordOutcome(result, counters, blockedArticleIds) {
  if (result?.claimed === false) {
    const articleId = result?.articleId
    if (articleId !== undefined && articleId !== null && String(articleId)) blockedArticleIds.add(String(articleId))
  } else counters.claimed += 1
  const status = ['succeeded', 'partial', 'failed', 'deferred'].includes(result?.status) ? result.status : 'failed'
  counters[status] += 1
}

function candidateArticleId(candidate) {
  if (candidate?.articleId === undefined || candidate?.articleId === null || String(candidate.articleId).length === 0) throw new Error('Indexing candidate article id is invalid')
  if (candidate?.id === undefined || candidate?.id === null || String(candidate.id).length === 0) throw new Error('Indexing candidate id is invalid')
  return String(candidate.articleId)
}

function taskCandidate(candidate, task) {
  if (candidate?.task !== task) throw new Error('Indexing candidate task is invalid')
  return candidate
}

function isDueStartAllowed(task, now, deadline) {
  const remaining = deadline.getTime() - now.getTime()
  return remaining >= (TASK_START_GUARD_MS[task] ?? 5_000)
}

function scheduleCandidate({ candidate, task, queue, wave, waveArticleIds, blockedArticleIds, counters, now, deadline, onInfrastructureError }) {
  const articleId = candidateArticleId(taskCandidate(candidate, task))
  if (blockedArticleIds.has(articleId) || waveArticleIds.has(articleId)) return false
  waveArticleIds.add(articleId)
  let taskRun
  try {
    taskRun = Promise.resolve(queue.claimAndExecute({ candidate, now: now(), deadline }))
  } catch (error) {
    taskRun = Promise.reject(error)
  }
  const guardedRun = taskRun
    .then((result) => {
      recordOutcome({ ...result, articleId: result?.articleId ?? candidate.articleId }, counters, blockedArticleIds)
      return result
    })
    .catch((error) => {
      onInfrastructureError(error)
      throw error
    })
  guardedRun.catch(() => {})
  wave.push({ task, promise: guardedRun })
  return true
}

export function createIndexingDrainRunner({ queue, maxClaims, deadline, now = () => new Date() } = {}) {
  if (!queue || typeof queue.selectDue !== 'function' || typeof queue.claimAndExecute !== 'function' || typeof queue.nextAvailableAt !== 'function') throw new Error('Indexing drain queue is required')
  if (!Number.isInteger(maxClaims) || maxClaims < 0) throw new Error('Indexing drain max claims is invalid')
  const configuredDeadline = deadline === undefined ? new Date(8640000000000000) : deadline
  validDate(configuredDeadline, 'Indexing drain deadline')
  if (typeof now !== 'function') throw new Error('Indexing drain clock is invalid')

  return async () => {
    const startedAt = validDate(now(), 'Indexing drain start time')
    const counters = { ...EMPTY_COUNTERS }
    const blockedArticleIds = new Set()
    const heldCandidates = new Map(TASK_ORDER.map((task) => [task, []]))
    let scheduled = 0
    let cursor = 0
    let firstInfrastructureError
    const currentTime = () => validDate(now(), 'Indexing drain clock')
    const noteInfrastructureError = (error) => { firstInfrastructureError ??= error }

    while (scheduled < maxClaims && currentTime().getTime() < configuredDeadline.getTime()) {
      const wave = []
      const waveArticleIds = new Set()
      const waveTasks = TASK_ORDER.map((_, index) => TASK_ORDER[(cursor + index) % TASK_ORDER.length])

      for (const task of waveTasks) {
        const cap = TASK_CONCURRENCY[task] ?? 1
        const seenCandidates = new Set()
        while (wave.filter((item) => item.task === task).length < cap && scheduled < maxClaims) {
          const tick = currentTime()
          if (!isDueStartAllowed(task, tick, configuredDeadline)) break

          const held = heldCandidates.get(task)?.shift()
          if (held) {
            const heldArticleId = candidateArticleId(taskCandidate(held, task))
            if (blockedArticleIds.has(heldArticleId)) continue
            if (waveArticleIds.has(heldArticleId)) {
              heldCandidates.get(task).unshift(held)
              break
            }
            if (scheduleCandidate({ candidate: held, task, queue, wave, waveArticleIds, blockedArticleIds, counters, now: currentTime, deadline: configuredDeadline, onInfrastructureError: noteInfrastructureError })) scheduled += 1
            continue
          }

          let candidate
          try {
            candidate = await queue.selectDue({ now: tick, task, excludeArticleIds: [...new Set([...blockedArticleIds, ...waveArticleIds])] })
          } catch (error) {
            noteInfrastructureError(error)
            break
          }
          if (!candidate) break
          taskCandidate(candidate, task)
          const articleId = candidateArticleId(candidate)
          const candidateId = String(candidate.id)
          if (seenCandidates.has(candidateId)) break
          seenCandidates.add(candidateId)
          if (blockedArticleIds.has(articleId)) continue
          if (waveArticleIds.has(articleId)) {
            const pending = heldCandidates.get(task)
            if (!pending.some((item) => String(item.id) === candidateId)) pending.push(candidate)
            break
          }
          if (scheduleCandidate({ candidate, task, queue, wave, waveArticleIds, blockedArticleIds, counters, now: currentTime, deadline: configuredDeadline, onInfrastructureError: noteInfrastructureError })) scheduled += 1
        }
      }

      cursor = (cursor + 1) % TASK_ORDER.length
      if (wave.length === 0) break
      await Promise.allSettled(wave.map(({ promise }) => promise))
      if (firstInfrastructureError) break
    }

    if (firstInfrastructureError) throw firstInfrastructureError
    const nextAvailableAt = await queue.nextAvailableAt({ now: currentTime() })
    return { startedAt, finishedAt: currentTime(), counters, nextAvailableAt }
  }
}

export { TASK_CONCURRENCY, TASK_ORDER, TASK_START_GUARD_MS }
