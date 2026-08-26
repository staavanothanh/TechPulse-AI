import express from 'express'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  ADMIN_DUE_WORK_PROFILE,
  CRON_DUE_WORK_PROFILE,
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

  it('keeps internal per-task counters out of the fixed cron HTTP contract', async () => {
    const dueWorkRunner = vi.fn(async () => ({
      ...baseResult(),
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
      expect(Object.keys(payload.data)).toEqual(['runId', 'startedAt', 'finishedAt', 'recovery', 'queues', 'nextAvailableAt'])
    } finally {
      await new Promise((resolve) => server.close(resolve))
    }
  })
})
