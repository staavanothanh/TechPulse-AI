import { Router } from 'express'
import { JobError } from '../../../application/jobs/service.js'

function iso(value) { return value instanceof Date ? value.toISOString() : value }
function asyncRoute(handler) { return (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next) }
function unavailable() { throw new JobError(503, 'service_unavailable', 'Due-work runner is not configured') }
function counters(value = {}) { return Object.fromEntries(['claimed', 'succeeded', 'partial', 'failed', 'deferred'].map((key) => [key, Number(value[key] ?? 0)])) }
function materialization(value) {
  if (!value || typeof value !== 'object') return null
  return {
    period: typeof value.period === 'string' ? value.period : null,
    periodTimezone: value.periodTimezone === 'UTC' ? 'UTC' : null,
    materializationReason: typeof value.materializationReason === 'string' ? value.materializationReason : null,
    outcome: typeof value.outcome === 'string' ? value.outcome : null,
    alreadyMaterialized: typeof value.alreadyMaterialized === 'boolean' ? value.alreadyMaterialized : null,
    completedAt: value.completedAt === null ? null : (value.completedAt ? iso(value.completedAt) : null),
    eligibleSourceCount: Number.isSafeInteger(value.eligibleSourceCount) && value.eligibleSourceCount >= 0 ? value.eligibleSourceCount : null,
    inspected: Number(value.inspected ?? 0),
    created: Number(value.created ?? 0),
    updated: Number(value.updated ?? 0),
  }
}
function serializeDueWorkRun(result) {
  return {
    runId: String(result.runId),
    startedAt: iso(result.startedAt),
    finishedAt: iso(result.finishedAt),
    recovery: Object.fromEntries(['inspected', 'recovered', 'retriesCreated', 'failed'].map((key) => [key, Number(result.recovery?.[key] ?? 0)])),
    queues: {
      ingestion: counters(result.queues?.ingestion),
      indexing: counters(result.queues?.indexing),
      accountDeletion: counters(result.queues?.accountDeletion),
    },
    nextAvailableAt: result.nextAvailableAt ? iso(result.nextAvailableAt) : null,
    invocationOrigin: 'vercel-cron',
    materialization: materialization(result.materialization),
  }
}

export function createInternalCronRouter({ dueWorkRunner } = {}) {
  const router = Router()
  const run = typeof dueWorkRunner === 'function' ? dueWorkRunner : unavailable
  router.get('/api/internal/cron/due-work', asyncRoute(async (_req, res) => {
    const result = await run({ invocationOrigin: 'vercel-cron' })
    res.set('Cache-Control', 'no-store, private')
    res.status(202).json({ data: serializeDueWorkRun(result) })
  }))
  return router
}
