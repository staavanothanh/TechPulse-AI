import { Router } from 'express'
import { JobError } from '../../../application/jobs/service.js'
import { requireRole } from '../../middleware/require-role.js'
import { serializeLifecycleEventResponse } from './serializer.js'
function asyncRoute(handler) {
  return (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next)
}

function noStore(res) {
  res.set('Cache-Control', 'no-store, private')
}

function unavailable() { throw new JobError(503, 'service_unavailable', 'Cron lifecycle event repository is not configured') }

export function createAdminLifecycleEventsRouter({ cronEventRepository, authService } = {}) {
  const router = Router()
  const service = cronEventRepository ?? { listLifecycleEvents: unavailable }
  const admin = requireRole('admin')

  router.get('/api/v1/admin/cron-lifecycle-events', admin, asyncRoute(async (req, res) => {
    const result = await service.listLifecycleEvents(req.query)
    noStore(res)
    res.status(200).json({
      data: (result.events ?? []).map(serializeLifecycleEventResponse),
      meta: {
        hasNext: Boolean(result.hasNext),
        nextCursor: result.nextCursor ?? null,
      },
    })
  }))

  return router
}
