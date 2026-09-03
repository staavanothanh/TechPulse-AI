import { describe, expect, it, vi } from 'vitest'
import {
  CRON_DUE_WORK_PROFILE,
  createProfiledIndexingDrainRunner,
} from '../../../server/bootstrap/jobs.js'

describe('profiled indexing drain instrumentation', () => {
  it('emits indexing drain trace event with task allocations and remaining claims', async () => {
    const trace = vi.fn()
    const queue = {
      selectDue: vi.fn().mockResolvedValue(null),
      claimAndExecute: vi.fn(),
      nextAvailableAt: vi.fn().mockResolvedValue(null),
    }
    const queueRegistry = {
      get: vi.fn(() => queue),
      registered: vi.fn(() => [queue]),
    }

    const runner = createProfiledIndexingDrainRunner({
      queueRegistry,
      profile: CRON_DUE_WORK_PROFILE,
      now: () => new Date('2026-09-03T10:00:00.000Z'),
      trace,
    })

    const baseResult = {
      runId: 'cron-run-drain-1',
      startedAt: new Date('2026-09-03T10:00:00.000Z'),
      finishedAt: new Date('2026-09-03T10:00:01.000Z'),
      queues: {
        ingestion: { claimed: 5, succeeded: 5, partial: 0, failed: 0, deferred: 0 },
        indexing: { claimed: 0, succeeded: 0, partial: 0, failed: 0, deferred: 0 },
        accountDeletion: { claimed: 0, succeeded: 0, partial: 0, failed: 0, deferred: 0 },
      },
    }

    const result = await runner(baseResult, { runId: 'cron-run-drain-1' })
    expect(result.taskCounters).toBeDefined()
    const traceCalls = trace.mock.calls.map(([e]) => e)
    expect(traceCalls.some((e) => e.stage === 'indexing.drain' && e.runId === 'cron-run-drain-1')).toBe(true)
  })
  it('emits deferred instead of succeeded when every indexing claim is deferred', async () => {
    const trace = vi.fn()
    let selected = false
    const queue = {
      selectDue: vi.fn(async () => {
        if (selected) return null
        selected = true
        return { id: 'job-deferred', articleId: 'article-deferred', task: 'summary' }
      }),
      claimAndExecute: vi.fn().mockResolvedValue({ status: 'deferred', claimed: true }),
      nextAvailableAt: vi.fn().mockResolvedValue(null),
    }
    const queueRegistry = {
      get: vi.fn(() => queue),
      registered: vi.fn(() => [queue]),
    }
    const baseTime = new Date('2026-09-03T10:00:00.000Z')
    const runner = createProfiledIndexingDrainRunner({
      queueRegistry,
      profile: { maxJobs: 3, budgetMs: 60_000, taskProfiles: [{ task: 'summary', maxClaims: 1, budgetMs: 60_000 }] },
      now: () => baseTime,
      trace,
    })
    const baseResult = {
      runId: 'cron-run-drain-deferred',
      startedAt: baseTime,
      queues: {
        ingestion: { claimed: 0, succeeded: 0, partial: 0, failed: 0, deferred: 0 },
        indexing: { claimed: 0, succeeded: 0, partial: 0, failed: 0, deferred: 0 },
        accountDeletion: { claimed: 0, succeeded: 0, partial: 0, failed: 0, deferred: 0 },
      },
    }

    const result = await runner(baseResult, { runId: baseResult.runId, deadline: new Date(baseTime.getTime() + 60_000) })
    const terminal = trace.mock.calls.map(([event]) => event).find((event) => event.stage === 'indexing.drain' && event.status !== 'started')

    expect(result.queues.indexing.deferred).toBe(1)
    expect(terminal.status).toBe('deferred')
  })
})
