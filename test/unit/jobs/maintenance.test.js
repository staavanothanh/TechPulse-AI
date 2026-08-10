import { describe, expect, it, vi } from 'vitest'
import { createMaintenanceRegistry, MAINTENANCE_TASK_NAMES } from '../../../server/maintenance/task-registry.js'
import { createMaintenanceRunner, MaintenanceError } from '../../../server/maintenance/runner.js'

describe('fixed-scope maintenance registry', () => {
  it('registers only fixed OpenAPI task names and rejects duplicates', () => {
    const registry = createMaintenanceRegistry()
    const handler = vi.fn()
    expect(MAINTENANCE_TASK_NAMES).toContain('purge-ingestion-jobs')
    registry.register('purge-ingestion-jobs', handler)
    expect(() => registry.register('purge-ingestion-jobs', handler)).toThrow(/already registered/i)
    expect(() => registry.register('caller-collection-delete', handler)).toThrow(/task name/i)
  })

  it('derives now and limit server-side and returns only a safe aggregate', async () => {
    const now = new Date('2026-08-10T02:00:00.000Z')
    const purge = vi.fn(async ({ cutoff, limit }) => {
      expect(cutoff).toEqual(now)
      expect(limit).toBe(100)
      return { inspected: 3, affected: 2, hasMore: true, secretCursor: 'must-not-leak' }
    })
    const registry = createMaintenanceRegistry()
    registry.register('purge-ingestion-jobs', purge)
    const runner = createMaintenanceRunner({ registry, now: () => now })
    await expect(runner.run('purge-ingestion-jobs')).resolves.toEqual({
      taskName: 'purge-ingestion-jobs', inspected: 3, affected: 2, hasMore: true, completedAt: now,
    })
    expect(purge).toHaveBeenCalledWith({ cutoff: now, limit: 100 })
  })

  it('fails closed for fixed but unregistered future tasks', async () => {
    const runner = createMaintenanceRunner({ registry: createMaintenanceRegistry() })
    await expect(runner.run('purge-indexing-jobs')).rejects.toEqual(expect.objectContaining({ status: 409, code: 'conflict' }))
    await expect(runner.run('unknown-task')).rejects.toBeInstanceOf(MaintenanceError)
  })

  it('rejects invalid clocks and out-of-bound handler aggregates', async () => {
    const registry = createMaintenanceRegistry()
    registry.register('purge-ingestion-jobs', async () => ({ inspected: 101, affected: 0, hasMore: false }))
    await expect(createMaintenanceRunner({ registry, now: () => new Date('invalid') }).run('purge-ingestion-jobs')).rejects.toThrow(/clock/i)
    await expect(createMaintenanceRunner({ registry, now: () => new Date('2026-08-10T00:00:00.000Z') }).run('purge-ingestion-jobs')).rejects.toThrow(/inspected/i)
  })
})
