import express from 'express'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  ADMIN_DUE_WORK_PROFILE,
  CRON_DUE_WORK_PROFILE,
  createCronDueWorkRunner,
  createProfiledIndexingDrainRunner,
} from '../../../server/bootstrap/jobs.js'
import { createIndexingDrainRunner } from '../../../server/jobs/indexing-drain.js'
import { createInternalCronRouter } from '../../../server/http/internal/cron/router.js'

const STARTED_AT = new Date('2026-08-26T00:00:00.000Z')
const EMPTY_COUNTERS = Object.freeze({ claimed: 0, succeeded: 0, partial: 0, failed: 0, deferred: 0 })

function baseResult() {
  return {
    runId: 'worker-scheduling-run',
    startedAt: STARTED_AT,
    finishedAt: STARTED_AT,
    recovery: { inspected: 0, recovered: 0, retriesCreated: 0, failed: 0 },
    queues: {
      accountDeletion: { ...EMPTY_COUNTERS, succeeded: 1, claimed: 1 },
      indexing: { ...EMPTY_COUNTERS, succeeded: 1, claimed: 1 },
      ingestion: { ...EMPTY_COUNTERS, succeeded: 1, claimed: 1 },
    },
    nextAvailableAt: null,
  }
}

function queueFixture(jobs) {
  let pending = jobs.map((job) => ({ ...job }))
  return {
    selectDue: vi.fn(async ({ task }) => pending.find((job) => job.task === task) ?? null),
    claimAndExecute: vi.fn(async ({ candidate, deadline }) => {
      pending = pending.filter((job) => job.id !== candidate.id)
      return { status: 'succeeded', claimed: true, deadline }
    }),
    nextAvailableAt: vi.fn(async () => null),
  }
}

function registry(queue) {
  return {
    get: vi.fn((name) => name === 'indexing' ? queue : undefined),
    registered: vi.fn(() => [queue]),
  }
}

afterEach(() => vi.restoreAllMocks())

describe('worker scheduling', () => {
  it('gives admin due-work 150 seconds while cron remains below the 300-second function ceiling', () => {
    expect(ADMIN_DUE_WORK_PROFILE.budgetMs).toBe(150_000)
    expect(CRON_DUE_WORK_PROFILE.budgetMs).toBe(240_000)
    expect(CRON_DUE_WORK_PROFILE.budgetMs).toBeLessThan(300_000)
  })

  it('runs summary and embedding in task-scoped slices with independent deadlines and counters', async () => {
    const queue = queueFixture([
      { id: 'summary-1', articleId: 'article-1', task: 'summary' },
      { id: 'embedding-1', articleId: 'article-2', task: 'embedding' },
    ])
    const profile = {
      maxJobs: 5,
      budgetMs: 100_000,
      taskProfiles: [
        { task: 'summary', maxClaims: 1, budgetMs: 60_000 },
        { task: 'embedding', maxClaims: 1, budgetMs: 40_000 },
      ],
    }
    const runner = createProfiledIndexingDrainRunner({ queueRegistry: registry(queue), profile, now: () => STARTED_AT })

    const result = await runner(baseResult())

    expect(queue.selectDue.mock.calls.map(([input]) => input.task)).toEqual(['summary', 'embedding'])
    expect(queue.claimAndExecute.mock.calls.map(([input]) => [input.candidate.task, input.deadline.toISOString()])).toEqual([
      ['summary', '2026-08-26T00:01:00.000Z'],
      ['embedding', '2026-08-26T00:00:40.000Z'],
    ])
    expect(result.taskCounters).toMatchObject({
      summary: { claimed: 1, succeeded: 1 },
      embedding: { claimed: 1, succeeded: 1 },
      'visibility-reconcile': EMPTY_COUNTERS,
    })
    expect(result.queues.indexing).toEqual({ claimed: 3, succeeded: 3, partial: 0, failed: 0, deferred: 0 })
  })

  it('does not let a task-scoped drain select another task', async () => {
    const queue = queueFixture([
      { id: 'summary-1', articleId: 'article-1', task: 'summary' },
      { id: 'embedding-1', articleId: 'article-2', task: 'embedding' },
    ])
    const drain = createIndexingDrainRunner({
      queue,
      tasks: ['summary'],
      maxClaims: 2,
      deadline: new Date(STARTED_AT.getTime() + 60_000),
      now: () => STARTED_AT,
    })

    const result = await drain()

    expect(queue.claimAndExecute).toHaveBeenCalledTimes(1)
    expect(queue.claimAndExecute.mock.calls[0][0].candidate.task).toBe('summary')
    expect(queue.selectDue.mock.calls.every(([input]) => input.task === 'summary')).toBe(true)
    expect(result.taskCounters.embedding).toEqual(EMPTY_COUNTERS)
  })

  it('can invoke the same bounded runner repeatedly after article-lease contention', async () => {
    let pending = [
      { id: 'summary-1', articleId: 'article-1', task: 'summary' },
      { id: 'embedding-1', articleId: 'article-1', task: 'embedding' },
    ]
    const activeArticles = new Set()
    const providerRuns = []
    const queue = {
      selectDue: vi.fn(async ({ task }) => pending.find((job) => job.task === task) ?? null),
      claimAndExecute: vi.fn(async ({ candidate }) => {
        if (activeArticles.has(candidate.articleId)) return { status: 'deferred', claimed: false, articleId: candidate.articleId }
        activeArticles.add(candidate.articleId)
        providerRuns.push(candidate.id)
        await new Promise((resolve) => setTimeout(resolve, 5))
        activeArticles.delete(candidate.articleId)
        pending = pending.filter((job) => job.id !== candidate.id)
        return { status: 'succeeded', claimed: true }
      }),
      nextAvailableAt: vi.fn(async () => pending.length > 0 ? STARTED_AT : null),
    }
    const profile = {
      maxJobs: 5,
      budgetMs: 100_000,
      taskProfiles: [
        { task: 'summary', maxClaims: 1, budgetMs: 60_000 },
        { task: 'embedding', maxClaims: 1, budgetMs: 40_000 },
      ],
    }
    const runner = createProfiledIndexingDrainRunner({ queueRegistry: registry(queue), profile, now: () => STARTED_AT })

    const first = await runner(baseResult())
    const second = await runner(baseResult())

    expect(providerRuns).toEqual(['summary-1', 'embedding-1'])
    expect(first.taskCounters.summary).toMatchObject({ claimed: 1, succeeded: 1 })
    expect(first.taskCounters.embedding).toMatchObject({ claimed: 0, deferred: 1 })
    expect(first.nextAvailableAt).toEqual(STARTED_AT)
    expect(second.taskCounters).toEqual({
      summary: EMPTY_COUNTERS,
      embedding: { ...EMPTY_COUNTERS, claimed: 1, succeeded: 1 },
      'visibility-reconcile': EMPTY_COUNTERS,
    })
    expect(second.nextAvailableAt).toBeNull()
  })

  it('serializes materialization and invocation origin while excluding internal diagnostics', async () => {
    const dueWorkRunner = vi.fn(async () => ({
      ...baseResult(),
      invocationOrigin: 'vercel-cron',
      materialization: {
        period: '2026-09-08', periodTimezone: 'UTC', materializationReason: 'materialized', outcome: 'completed', alreadyMaterialized: false,
        completedAt: '2026-09-08T00:00:00.000Z', eligibleSourceCount: 1, inspected: 1, created: 1, updated: 1,
      },
      taskCounters: { summary: { ...EMPTY_COUNTERS, claimed: 1, succeeded: 1 } },
      privateDiagnostic: 'must-not-leak',
    }))
    const app = express()
    app.use(createInternalCronRouter({ dueWorkRunner }))
    const server = await new Promise((resolve) => {
      const listener = app.listen(0, () => resolve(listener))
    })

    try {
      const response = await fetch(`http://127.0.0.1:${server.address().port}/api/internal/cron/due-work`)
      const payload = await response.json()
      expect(response.status).toBe(202)
      expect(payload.data).not.toHaveProperty('taskCounters')
      expect(payload.data).not.toHaveProperty('privateDiagnostic')
      expect(payload.data).toEqual(expect.objectContaining({ invocationOrigin: 'vercel-cron', materialization: expect.objectContaining({ period: '2026-09-08', periodTimezone: 'UTC', materializationReason: 'materialized', outcome: 'completed', alreadyMaterialized: false, completedAt: '2026-09-08T00:00:00.000Z', eligibleSourceCount: 1, inspected: 1, created: 1, updated: 1 }) }))
      expect(Object.keys(payload.data)).toEqual(['runId', 'startedAt', 'finishedAt', 'recovery', 'queues', 'nextAvailableAt', 'invocationOrigin', 'materialization'])
    } finally {
      await new Promise((resolve) => server.close(resolve))
    }
  })

  it('returns a deferred materialization summary and never replays on deadline control', async () => {
    const trace = vi.fn()
    const coordinatorRunner = vi.fn()
    const runner = createCronDueWorkRunner({
      jobRepository: { materializeDailyIngestion: vi.fn(async () => { throw Object.assign(new Error('deadline'), { code: 'runtime_deadline_exceeded' }) }) },
      coordinatorRunner,
      trace,
      runIdFactory: () => 'deferred-run',
      now: () => STARTED_AT,
    })

    const result = await runner()
    expect(result.materialization).toEqual(expect.objectContaining({ period: '2026-08-26', periodTimezone: 'UTC', materializationReason: 'deferred', outcome: 'deferred', alreadyMaterialized: false, completedAt: null, eligibleSourceCount: null, inspected: 0, created: 0, updated: 0 }))
    expect(coordinatorRunner).not.toHaveBeenCalled()
    expect(trace.mock.calls.map(([event]) => event)).toEqual(expect.arrayContaining([
      expect.objectContaining({ runId: 'deferred-run', stage: 'cron.materialization.daily', materializationReason: 'deferred', outcome: 'deferred', alreadyMaterialized: false }),
    ]))
    expect(trace.mock.calls.map(([event]) => event).every((event) => event.materializationReason !== 'already_materialized')).toBe(true)
  })

  it('traces ordinary materialization failures as failed without changing rejection semantics', async () => {
    const trace = vi.fn()
    const failure = new Error('materialization database failure')
    const runner = createCronDueWorkRunner({
      jobRepository: { materializeDailyIngestion: vi.fn(async () => { throw failure }) },
      coordinatorRunner: vi.fn(),
      trace,
      now: () => STARTED_AT,
    })

    await expect(runner()).rejects.toBe(failure)
    expect(trace.mock.calls.map(([event]) => event)).toEqual(expect.arrayContaining([
      expect.objectContaining({ stage: 'cron.materialization.daily', status: 'failed', materializationReason: 'failed', outcome: 'failed', alreadyMaterialized: false }),
    ]))
    expect(trace.mock.calls.map(([event]) => event).every((event) => event.materializationReason !== 'already_materialized')).toBe(true)
  })

  it('configures cron due-work runner to invoke coordinator with CRON_DUE_WORK_PROFILE budget and claims', async () => {
    const { createCronDueWorkRunner } = await import('../../../server/bootstrap/jobs.js')
    const jobRepository = { materializeDailyIngestion: vi.fn(async () => ({ hasMore: false })) }
    const coordinatorRunner = vi.fn(async (options) => ({ ...baseResult(), coordinatorOptions: options }))
    const indexingDrainRunner = vi.fn(async (res) => res)
    const runner = createCronDueWorkRunner({
      jobRepository,
      coordinatorRunner,
      indexingDrainRunner,
      now: () => STARTED_AT,
    })

    const result = await runner()
    expect(coordinatorRunner).toHaveBeenCalledWith(
      expect.objectContaining({
        maxJobs: CRON_DUE_WORK_PROFILE.maxJobs,
        budgetMs: CRON_DUE_WORK_PROFILE.budgetMs,
      }),
    )
    expect(result.coordinatorOptions.maxJobs).toBe(200)
    expect(result.coordinatorOptions.budgetMs).toBe(240_000)
  })

  it('clamps task drain deadline to the global profile deadline', async () => {
    const queue = queueFixture([
      { id: 'summary-1', articleId: 'article-1', task: 'summary' },
    ])
    const profile = {
      maxJobs: 5,
      budgetMs: 100_000,
      taskProfiles: [
        { task: 'summary', maxClaims: 1, budgetMs: 100_000 },
      ],
    }
    const runner = createProfiledIndexingDrainRunner({
      queueRegistry: registry(queue),
      profile,
      now: () => new Date(STARTED_AT.getTime() + 20_000),
    })

    await runner(baseResult())
    // StartedAt was STARTED_AT. Global deadline is STARTED_AT + 100_000 (100s from start).
    // Drain started 20s in, so drainStartedAt + 150s = 170s, but clamped to 100s!
    expect(queue.claimAndExecute).toHaveBeenCalledWith(
      expect.objectContaining({
        deadline: new Date(STARTED_AT.getTime() + 100_000),
      }),
    )
  })

  it('threads the cron invocation absolute deadline across materialization, coordinator, and indexing drain', async () => {
    let currentMs = STARTED_AT.getTime()
    const now = () => new Date(currentMs)

    const jobRepository = {
      materializeDailyIngestion: vi.fn(async () => {
        currentMs += 3_000
        return { hasMore: false }
      }),
    }

    const coordinatorRunner = vi.fn(async (options) => {
      currentMs += 40_000
      return {
        ...baseResult(),
        startedAt: new Date(STARTED_AT.getTime() + 3_000),
        coordinatorOptions: options,
      }
    })

    const queue = queueFixture([
      { id: 'summary-1', articleId: 'article-1', task: 'summary' },
    ])
    const indexingDrainRunner = createProfiledIndexingDrainRunner({
      queueRegistry: registry(queue),
      profile: CRON_DUE_WORK_PROFILE,
      now,
    })

    const runner = createCronDueWorkRunner({
      jobRepository,
      coordinatorRunner,
      indexingDrainRunner,
      now,
    })

    await runner()

    expect(coordinatorRunner).toHaveBeenCalledWith(
      expect.objectContaining({
        maxJobs: 200,
        budgetMs: 237_000,
      }),
    )

    expect(queue.claimAndExecute).toHaveBeenCalledWith(
      expect.objectContaining({
        deadline: new Date(STARTED_AT.getTime() + 240_000),
      }),
    )
  })

  it('skips coordinator and indexing drain entirely when prework exceeds the global deadline', async () => {
    let currentMs = STARTED_AT.getTime()
    const now = () => new Date(currentMs)

    const slowMaterializer = vi.fn()

    const jobRepository = {
      materializeDailyIngestion: vi.fn(async () => {
        currentMs += 241_000
        return { hasMore: false }
      }),
    }

    const coordinatorRunner = vi.fn(async () => baseResult())
    const indexingDrainRunner = vi.fn(async (res) => res)

    const runner = createCronDueWorkRunner({
      jobRepository,
      coordinatorRunner,
      indexingDrainRunner,
      materializers: [slowMaterializer],
      now,
    })

    const result = await runner()
    expect(slowMaterializer).not.toHaveBeenCalled()
    expect(jobRepository.materializeDailyIngestion).toHaveBeenCalledTimes(1)
    expect(coordinatorRunner).not.toHaveBeenCalled()
    expect(indexingDrainRunner).not.toHaveBeenCalled()
    expect(result.queues.ingestion.claimed).toBe(0)
    expect(result.nextAvailableAt).toBeNull()
  })
  it('traces daily materialization timeout and blocks downstream phases', async () => {
    vi.useFakeTimers()
    try {
      vi.setSystemTime(STARTED_AT)
      const trace = vi.fn()
      const daily = vi.fn(({ signal }) => new Promise((resolve) => {
        signal.addEventListener('abort', () => globalThis.setTimeout(() => resolve({ hasMore: false }), 1), { once: true })
      }))
      const materializer = vi.fn()
      const coordinatorRunner = vi.fn()
      const indexingDrainRunner = vi.fn()
      const runner = createCronDueWorkRunner({
        jobRepository: { materializeDailyIngestion: daily },
        coordinatorRunner,
        indexingDrainRunner,
        materializers: [{ name: 'source-policy-reconciliation', run: materializer }],
        trace,
        runIdFactory: () => 'daily-timeout-run',
        now: () => new Date(),
        materializationBudgetMs: 2_000,
      })

      const pending = runner()
      const outcome = pending.then((value) => ({ ok: true, value }), (error) => ({ ok: false, error }))
      await vi.advanceTimersByTimeAsync(2_000)
      expect(coordinatorRunner).not.toHaveBeenCalled()
      expect(indexingDrainRunner).not.toHaveBeenCalled()
      expect(materializer).not.toHaveBeenCalled()
      await vi.advanceTimersByTimeAsync(1)
      expect((await outcome).ok).toBe(true)

      const events = trace.mock.calls.map(([event]) => event)
      expect(events).toEqual(expect.arrayContaining([
        expect.objectContaining({ runId: 'daily-timeout-run', stage: 'cron.materialization.daily', status: 'started' }),
        expect.objectContaining({ runId: 'daily-timeout-run', stage: 'cron.materialization.daily', status: 'timeout', counters: { deferred: 1, updated: 0 } }),
        expect.objectContaining({ runId: 'daily-timeout-run', stage: 'cron.materialization', status: 'timeout', counters: { deferred: 1 } }),
      ]))
    } finally {
      vi.useRealTimers()
    }
  })
  it('waits for timed-out materialization settlement and fails closed before coordination', async () => {
    vi.useFakeTimers()
    try {
      vi.setSystemTime(STARTED_AT)
      const materializationBudgetMs = 2_000
      const order = []
      let materializerSignal
      let materializerDeadline
      const materializer = vi.fn(({ signal, deadline }) => {
        order.push('materializer')
        materializerSignal = signal
        materializerDeadline = deadline
        return new Promise((resolve) => {
          signal.addEventListener('abort', () => globalThis.setTimeout(() => resolve({ hasMore: false }), 1), { once: true })
        })
      })
      const coordinatorRunner = vi.fn(async () => { order.push('coordinator'); return baseResult() })
      const indexingDrainRunner = vi.fn(async (coordinated) => { order.push('indexing'); return coordinated })
      const trace = vi.fn()
      const runner = createCronDueWorkRunner({
        jobRepository: { materializeDailyIngestion: vi.fn(async () => ({ hasMore: false })) },
        coordinatorRunner,
        indexingDrainRunner,
        materializers: [materializer],
        trace,
        runIdFactory: () => 'cron-timeout-run',
        now: () => new Date(),
        materializationBudgetMs,
      })

      const pending = runner()
      const settlement = pending.then(
        (value) => ({ ok: true, value }),
        (error) => ({ ok: false, error }),
      )
      await vi.advanceTimersByTimeAsync(materializationBudgetMs)
      expect(coordinatorRunner).not.toHaveBeenCalled()
      expect(indexingDrainRunner).not.toHaveBeenCalled()
      await vi.advanceTimersByTimeAsync(1)
      const outcome = await settlement

      expect(outcome.ok).toBe(true)
      expect(materializerDeadline).toEqual(new Date(STARTED_AT.getTime() + materializationBudgetMs))
      expect(materializerSignal?.aborted).toBe(true)
      expect(order).toEqual(['materializer'])
      const events = trace.mock.calls.map(([event]) => event)
      const materializationTerminals = events.filter(
        (event) => event.stage === 'cron.materialization' && event.status !== 'started',
      )
      expect(materializationTerminals.length).toBeGreaterThan(0)
      const terminal = materializationTerminals.at(-1)
      expect(['timeout', 'deferred']).toContain(terminal.status)
      expect(terminal.counters?.deferred ?? 0).toBeGreaterThanOrEqual(1)
      const cronTerminals = events.filter((event) => event.stage === 'cron' && event.status !== 'started')
      expect(cronTerminals.length).toBeGreaterThan(0)
      for (const event of cronTerminals) expect(event.status).not.toBe('failed')
    } finally {
      vi.useRealTimers()
    }
  })
  it('correlates cron phases and forwards the same run id to the coordinator', async () => {
    const trace = vi.fn()
    const coordinatorRunner = vi.fn(async ({ runId }) => ({ ...baseResult(), runId }))
    const indexingDrainRunner = vi.fn(async (result) => result)
    const runner = createCronDueWorkRunner({
      jobRepository: { materializeDailyIngestion: vi.fn(async () => ({ hasMore: false, inspected: 1, created: 1 })) },
      coordinatorRunner,
      indexingDrainRunner,
      trace,
      runIdFactory: () => 'cron-run-1',
      now: () => STARTED_AT,
    })

    await runner()

    expect(coordinatorRunner).toHaveBeenCalledWith(expect.objectContaining({ runId: 'cron-run-1' }))
    expect(trace.mock.calls.map(([event]) => [event.stage, event.status])).toEqual(expect.arrayContaining([
      ['cron', 'started'],
      ['cron.materialization', 'succeeded'],
      ['cron.coordinator', 'succeeded'],
      ['cron.indexing', 'succeeded'],
      ['cron', 'succeeded'],
    ]))
    expect(trace.mock.calls.map(([event]) => [event.stage, event.status])).toEqual(expect.arrayContaining([
      ['cron.materialization.daily', 'succeeded'],
    ]))
    expect(trace.mock.calls.map(([event]) => event).find((event) => event.stage === 'cron.materialization.daily' && event.status === 'succeeded')).toMatchObject({
      counters: { inspected: 1, created: 1, updated: 1 },
    })
  })
})
