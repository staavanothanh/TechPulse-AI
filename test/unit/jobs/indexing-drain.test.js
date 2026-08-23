import { describe, expect, it, vi } from 'vitest'
import { createIndexingDrainRunner } from '../../../server/jobs/indexing-drain.js'

const NOW = new Date('2026-08-10T00:00:00.000Z')
const NEXT_AVAILABLE_AT = new Date('2026-08-10T00:05:00.000Z')

function job(id, articleId, task, availableAt = NOW) {
  return { id, articleId, task, availableAt }
}

function queueFixture({ jobs, outcomes = {}, nextAvailableAt = NEXT_AVAILABLE_AT, onClaimStart, onClaimFinish, workDelayMs = 0 } = {}) {
  let pending = [...jobs]
  const reserved = new Set()
  const selectDue = vi.fn(async ({ task, now }) => {
    const candidate = pending.find((item) => item.task === task && item.availableAt <= now && !reserved.has(item.id))
    if (candidate) reserved.add(candidate.id)
    return candidate ?? null
  })
  const claimAndExecute = vi.fn(async ({ candidate }) => {
    pending = pending.filter((item) => item.id !== candidate.id)
    reserved.delete(candidate.id)
    onClaimStart?.(candidate)
    if (workDelayMs > 0) await new Promise((resolve) => setTimeout(resolve, workDelayMs))
    onClaimFinish?.(candidate)
    const outcome = outcomes[candidate.id] ?? { status: 'succeeded', claimed: true }
    return typeof outcome === 'function' ? outcome({ candidate }) : outcome
  })
  return {
    selectDue,
    claimAndExecute,
    nextAvailableAt: vi.fn(async () => nextAvailableAt),
  }
}

function runDrain(queue, options = {}) {
  return createIndexingDrainRunner({
    queue,
    now: () => NOW,
    ...options,
  })()
}

describe('indexing drain runner', () => {
  it('drains more than the shared three-job turn while enforcing server-owned summary and embedding caps', async () => {
    const active = { summary: 0, embedding: 0 }
    const peak = { summary: 0, embedding: 0 }
    const queue = queueFixture({
      jobs: [
        job('summary-a', 'article-a', 'summary'),
        job('summary-b', 'article-b', 'summary'),
        job('summary-c', 'article-c', 'summary'),
        job('summary-d', 'article-d', 'summary'),
        job('embedding-a', 'article-a', 'embedding'),
        job('embedding-b', 'article-b', 'embedding'),
        job('embedding-c', 'article-c', 'embedding'),
      ],
      workDelayMs: 5,
      onClaimStart: ({ task }) => {
        active[task] += 1
        peak[task] = Math.max(peak[task], active[task])
      },
      onClaimFinish: ({ task }) => { active[task] -= 1 },
    })

    const result = await runDrain(queue, { maxClaims: 10 })

    expect(queue.claimAndExecute).toHaveBeenCalledTimes(7)
    expect(queue.claimAndExecute.mock.calls.filter(([input]) => input.candidate.task === 'summary')).toHaveLength(4)
    expect(queue.claimAndExecute.mock.calls.filter(([input]) => input.candidate.task === 'embedding')).toHaveLength(3)
    expect(peak.summary).toBeLessThanOrEqual(3)
    expect(peak.embedding).toBeLessThanOrEqual(2)
    expect(result).toEqual(expect.objectContaining({
      counters: { claimed: 7, succeeded: 7, partial: 0, failed: 0, deferred: 0 },
      nextAvailableAt: NEXT_AVAILABLE_AT,
    }))
  })

  it('does not run two tasks for one article in parallel while another article makes progress', async () => {
    let pending = [
      job('summary-a', 'article-a', 'summary'),
      job('embedding-a', 'article-a', 'embedding'),
      job('summary-b', 'article-b', 'summary'),
      job('embedding-b', 'article-b', 'embedding'),
    ]
    const runningArticles = new Set()
    const completed = new Set()
    const started = []
    const parallelViolations = []
    let releaseFirstArticle
    const firstArticleGate = new Promise((resolve) => { releaseFirstArticle = resolve })
    let firstArticleStarted = false
    const selectDue = vi.fn(async ({ task, now }) => pending.find((candidate) => (
      candidate.task === task
      && candidate.availableAt <= now
      && !completed.has(candidate.id)
      && !started.includes(candidate.id)
    )) ?? null)
    const claimAndExecute = vi.fn(async ({ candidate }) => {
      started.push(candidate.id)
      if (runningArticles.has(candidate.articleId)) parallelViolations.push(candidate.articleId)
      runningArticles.add(candidate.articleId)
      const finish = () => {
        runningArticles.delete(candidate.articleId)
        completed.add(candidate.id)
        pending = pending.filter((item) => item.id !== candidate.id)
        return { status: 'succeeded', claimed: true }
      }
      if (candidate.articleId === 'article-a' && !firstArticleStarted) {
        firstArticleStarted = true
        await firstArticleGate
      }
      return finish()
    })
    const queue = { selectDue, claimAndExecute, nextAvailableAt: vi.fn(async () => null) }
    const run = runDrain(queue, { maxClaims: 4 })

    try {
      await vi.waitFor(() => expect(started.some((id) => id.endsWith('-b'))).toBe(true), { timeout: 500 })
      expect(started.filter((id) => id.endsWith('-a'))).toHaveLength(1)
    } finally {
      releaseFirstArticle()
    }

    await expect(run).resolves.toEqual(expect.objectContaining({
      counters: { claimed: 4, succeeded: 4, partial: 0, failed: 0, deferred: 0 },
    }))
    expect(started.filter((id) => id.endsWith('-a'))).toHaveLength(2)
    expect(parallelViolations).toEqual([])
  })

  it('continues with a different article after a lease conflict', async () => {
    const queue = queueFixture({
      jobs: [
        job('conflicted', 'article-a', 'summary'),
        job('other-article', 'article-b', 'summary'),
      ],
      outcomes: {
        conflicted: ({ candidate }) => ({ status: 'deferred', claimed: false, articleId: candidate.articleId }),
      },
    })

    const result = await runDrain(queue, { maxClaims: 2 })

    expect(queue.claimAndExecute.mock.calls.map(([input]) => input.candidate.id)).toEqual(['conflicted', 'other-article'])
    expect(result).toEqual(expect.objectContaining({
      counters: { claimed: 1, succeeded: 1, partial: 0, failed: 0, deferred: 1 },
    }))
  })

  it('settles an early claim rejection before awaiting a later candidate selection', async () => {
    const infrastructureError = new Error('claim failed')
    let selectCalls = 0
    const delayedSelection = new Promise((resolve) => setTimeout(() => resolve(null), 25))
    const queue = {
      selectDue: vi.fn(async ({ task }) => {
        if (selectCalls++ === 0) return job('failing', 'article-a', task)
        await delayedSelection
        return null
      }),
      claimAndExecute: vi.fn(() => Promise.reject(infrastructureError)),
      nextAvailableAt: vi.fn(async () => null),
    }
    const unhandledReasons = []
    const onUnhandledRejection = (reason) => { unhandledReasons.push(reason) }
    process.prependListener('unhandledRejection', onUnhandledRejection)

    try {
      await expect(runDrain(queue, { maxClaims: 2 })).rejects.toBe(infrastructureError)
    } finally {
      process.removeListener('unhandledRejection', onUnhandledRejection)
    }

    expect(unhandledReasons).toEqual([])
  })

  it('throws the first infrastructure error before querying next availability', async () => {
    const infrastructureError = new Error('claim failed')
    const availabilityError = new Error('availability failed')
    const queue = {
      selectDue: vi.fn(async ({ task }) => job('failing', 'article-a', task)),
      claimAndExecute: vi.fn(() => Promise.reject(infrastructureError)),
      nextAvailableAt: vi.fn(async () => { throw availabilityError }),
    }

    await expect(runDrain(queue, { maxClaims: 1 })).rejects.toBe(infrastructureError)
    expect(queue.nextAvailableAt).not.toHaveBeenCalled()
  })

  it('honors maxClaims and stops before the absolute deadline', async () => {
    const deadline = new Date(NOW.getTime() + 60_000)
    const queue = queueFixture({
      jobs: [
        job('one', 'article-a', 'summary', NOW),
        job('two', 'article-b', 'summary', NOW),
        job('three', 'article-c', 'summary', NOW),
        job('four', 'article-d', 'embedding', NOW),
        job('after-deadline', 'article-e', 'summary', new Date(NOW.getTime() + 1)),
      ],
    })
    let clock = NOW
    const started = []
    let releaseGate
    const gate = new Promise((resolve) => { releaseGate = resolve })
    const claimAndExecute = queue.claimAndExecute
    queue.claimAndExecute = vi.fn(async (input) => {
      started.push(input.candidate.id)
      if (started.length <= 4) {
        if (started.length === 4) {
          clock = new Date(deadline.getTime() + 1)
          releaseGate()
        }
        await gate
      }
      return claimAndExecute(input)
    })
    const run = runDrain(queue, { maxClaims: 10, deadline, now: () => clock })

    try {
      await vi.waitFor(() => expect(started).toHaveLength(4), { timeout: 500 })
    } finally {
      releaseGate()
    }

    await expect(run).resolves.toEqual(expect.objectContaining({
      counters: { claimed: 4, succeeded: 4, partial: 0, failed: 0, deferred: 0 },
    }))
    expect(queue.claimAndExecute).toHaveBeenCalledTimes(4)
  })

  it('honors maxClaims as a hard upper bound when the backlog is larger', async () => {
    const queue = queueFixture({
      jobs: [
        job('one', 'article-a', 'summary'),
        job('two', 'article-b', 'summary'),
        job('three', 'article-c', 'summary'),
        job('four', 'article-d', 'embedding'),
      ],
    })

    await expect(runDrain(queue, { maxClaims: 2 })).resolves.toEqual(expect.objectContaining({
      counters: { claimed: 2, succeeded: 2, partial: 0, failed: 0, deferred: 0 },
    }))
    expect(queue.claimAndExecute).toHaveBeenCalledTimes(2)
  })

  it('uses server-owned task profiles when the caller provides only a work budget', async () => {
    const active = { summary: 0, embedding: 0 }
    const peak = { summary: 0, embedding: 0 }
    const queue = queueFixture({
      jobs: [
        job('summary-a', 'article-a', 'summary'),
        job('summary-b', 'article-b', 'summary'),
        job('summary-c', 'article-c', 'summary'),
        job('summary-d', 'article-d', 'summary'),
        job('embedding-a', 'article-a', 'embedding'),
        job('embedding-b', 'article-b', 'embedding'),
        job('embedding-c', 'article-c', 'embedding'),
      ],
      workDelayMs: 5,
      onClaimStart: ({ task }) => {
        active[task] += 1
        peak[task] = Math.max(peak[task], active[task])
      },
      onClaimFinish: ({ task }) => { active[task] -= 1 },
    })

    await runDrain(queue, { maxClaims: 10 })

    expect(queue.claimAndExecute).toHaveBeenCalledTimes(7)
    expect(peak.summary).toBeLessThanOrEqual(3)
    expect(peak.embedding).toBeLessThanOrEqual(2)
  })
})
