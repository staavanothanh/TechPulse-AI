import { Router } from 'express'
import { JobError } from '../../../application/jobs/service.js'

function iso(value) { return value instanceof Date ? value.toISOString() : value }
function asyncRoute(handler) { return (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next) }
function unavailable() { throw new JobError(503, 'service_unavailable', 'Due-work runner is not configured') }

export function createInternalCronRouter({ dueWorkRunner } = {}) {
  const router = Router()
  const run = typeof dueWorkRunner === 'function' ? dueWorkRunner : unavailable
  router.get('/api/internal/cron/due-work', asyncRoute(async (_req, res) => {
    const result = await run()
    res.set('Cache-Control', 'no-store, private')
    res.status(202).json({ data: {
      ...result,
      startedAt: iso(result.startedAt), finishedAt: iso(result.finishedAt), nextAvailableAt: result.nextAvailableAt ? iso(result.nextAvailableAt) : null,
    } })
  }))
  return router
}
