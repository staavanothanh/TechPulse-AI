import { Router } from 'express'
import { MaintenanceError } from '../../../maintenance/runner.js'

function asyncRoute(handler) { return (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next) }
function unavailable() { throw new MaintenanceError(503, 'service_unavailable', 'Maintenance runner is not configured') }

export function createInternalMaintenanceRouter({ maintenanceRunner } = {}) {
  const router = Router()
  const run = maintenanceRunner?.run ? maintenanceRunner.run.bind(maintenanceRunner) : unavailable
  router.get('/api/internal/maintenance/:taskName', asyncRoute(async (req, res) => {
    const result = await run(req.params.taskName)
    res.set('Cache-Control', 'no-store, private')
    res.status(202).json({ data: { ...result, completedAt: result.completedAt instanceof Date ? result.completedAt.toISOString() : result.completedAt } })
  }))
  return router
}
