import { randomUUID } from 'node:crypto'
import { QUEUE_ORDER } from './queue-registry.js'

const EMPTY_COUNTERS = Object.freeze({ claimed: 0, succeeded: 0, partial: 0, failed: 0, deferred: 0 })
const RESPONSE_KEY = Object.freeze({ ingestion: 'ingestion', indexing: 'indexing', 'account-deletion': 'accountDeletion' })
const RESERVED_ATTEMPT_MS = 250
const SAFETY_MARGIN_MS = 250

function counters() { return { ...EMPTY_COUNTERS } }

function record(result, queueCounters) {
  if (result?.claimed !== false) queueCounters.claimed += 1
  const status = ['succeeded', 'partial', 'failed', 'deferred'].includes(result?.status) ? result.status : 'failed'
  queueCounters[status] += 1
  return status
}

function candidateTime(candidate) {
  const value = candidate?.availableAt instanceof Date ? candidate.availableAt : new Date(candidate?.availableAt ?? 0)
  return Number.isNaN(value.getTime()) ? Number.MAX_SAFE_INTEGER : value.getTime()
}

export async function runDueWork({ registry, maxJobs = 3, maxRecoveries = 3, budgetMs = 8000, now = () => new Date(), runId = randomUUID() } = {}) {
  if (!registry || typeof registry.registered !== 'function') throw new Error('Queue registry is required')
  const adapters = registry.registered()
  if (!Number.isInteger(maxJobs) || maxJobs < adapters.length) throw new Error('maxJobs must cover every registered queue')
  if (!Number.isInteger(maxRecoveries) || maxRecoveries < 0) throw new Error('maxRecoveries is invalid')
  if (!Number.isFinite(budgetMs) || budgetMs < adapters.length * RESERVED_ATTEMPT_MS + SAFETY_MARGIN_MS) throw new Error('Due-work budget cannot cover reserved queue attempts')

  const startedAt = now()
  if (!(startedAt instanceof Date) || Number.isNaN(startedAt.getTime())) throw new Error('Due-work clock is invalid')
  const workDeadline = startedAt.getTime() + budgetMs - SAFETY_MARGIN_MS
  const canStart = (reservedAttempts = 0) => {
    const current = now()
    if (!(current instanceof Date) || Number.isNaN(current.getTime())) throw new Error('Due-work clock is invalid')
    return current.getTime() + reservedAttempts * RESERVED_ATTEMPT_MS <= workDeadline
  }
  const queueCounters = Object.fromEntries(QUEUE_ORDER.map((name) => [name, counters()]))
  const recovery = { inspected: 0, recovered: 0, retriesCreated: 0, failed: 0 }
  if (maxRecoveries > 0 && adapters.length > 0) {
    let remaining = maxRecoveries
    let progressed = true
    while (remaining > 0 && progressed) {
      progressed = false
      for (const adapter of adapters) {
        if (remaining <= 0 || !canStart(adapters.length)) break
        const result = await adapter.recoverExpired({ limit: 1, now: startedAt })
        for (const key of Object.keys(recovery)) recovery[key] += Number(result?.[key] ?? 0)
        const inspected = Math.max(0, Math.min(remaining, Number(result?.inspected ?? 0)))
        remaining -= inspected
        if (inspected > 0) progressed = true
      }
    }
  }

  let slots = maxJobs
  const blockedSourceIds = new Set()
  const blockedArticleIds = new Set()
  const exhaustedQueues = new Set()

  const getSelectOptions = (queueName) => {
    if (queueName === 'ingestion') return { now: startedAt, excludeSourceIds: [...blockedSourceIds] }
    if (queueName === 'indexing') return { now: startedAt, excludeArticleIds: [...blockedArticleIds] }
    return { now: startedAt }
  }
  const handleResult = (result, queueName, candidate) => {
    const status = record(result, queueCounters[queueName])
    if (result?.claimed !== false) {
      if (queueName === 'ingestion') {
        exhaustedQueues.delete('indexing')
      }
    } else {
      if (queueName === 'ingestion' && (result?.sourceId || candidate?.sourceId)) {
        blockedSourceIds.add(String(result?.sourceId || candidate?.sourceId))
      } else if (queueName === 'indexing' && (result?.articleId || candidate?.articleId)) {
        blockedArticleIds.add(String(result?.articleId || candidate?.articleId))
      } else {
        exhaustedQueues.add(queueName)
      }
    }
    return status
  }
  for (let index = 0; index < adapters.length; index += 1) {
    const adapter = adapters[index]
    if (slots <= 0) break
    if (!canStart(adapters.length - index)) break
    const candidate = await adapter.selectDue(getSelectOptions(adapter.queueName))
    if (!candidate) {
      exhaustedQueues.add(adapter.queueName)
      continue
    }
    handleResult(await adapter.claimAndExecute({ candidate, now: startedAt }), adapter.queueName, candidate)
    slots -= 1
  }

  while (slots > 0 && adapters.length > 0) {
    if (!canStart()) break
    const eligibleAdapters = adapters.filter((adapter) => !exhaustedQueues.has(adapter.queueName))
    if (eligibleAdapters.length === 0) break
    const heads = (await Promise.all(
      eligibleAdapters.map(async (adapter) => {
        const candidate = await adapter.selectDue(getSelectOptions(adapter.queueName))
        if (!candidate) exhaustedQueues.add(adapter.queueName)
        return { adapter, candidate }
      }),
    )).filter(({ candidate }) => candidate)
    if (heads.length === 0) break
    heads.sort((left, right) => candidateTime(left.candidate) - candidateTime(right.candidate) || QUEUE_ORDER.indexOf(left.adapter.queueName) - QUEUE_ORDER.indexOf(right.adapter.queueName))
    const selected = heads[0]
    handleResult(await selected.adapter.claimAndExecute({ candidate: selected.candidate, now: startedAt }), selected.adapter.queueName, selected.candidate)
    slots -= 1
  }

  const availability = await Promise.all(adapters.map((adapter) => adapter.nextAvailableAt({ now: startedAt })))
  const nextDates = availability.filter(Boolean).map((value) => value instanceof Date ? value : new Date(value)).filter((value) => !Number.isNaN(value.getTime()))
  const finishedAt = now()
  return {
    runId,
    startedAt,
    finishedAt,
    recovery,
    queues: Object.fromEntries(QUEUE_ORDER.map((name) => [RESPONSE_KEY[name], queueCounters[name]])),
    nextAvailableAt: nextDates.length > 0 ? new Date(Math.min(...nextDates.map((value) => value.getTime()))) : null,
  }
}

export { EMPTY_COUNTERS }
