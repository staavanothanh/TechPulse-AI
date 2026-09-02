import { describe, expect, it, vi } from 'vitest'
import {
  EMPTY_COUNTERS,
  MAX_BUDGET_MS,
  MAX_CLAIMS,
  parseArgs,
  runForceDrain,
} from '../../scripts/force-drain-overdue.js'

const NOW = new Date('2026-08-26T00:00:00.000Z')

function candidate(id, articleId, task, availableAt = NOW) {
  return { id, articleId, task, status: 'queued', availableAt }
}

function queueFixture({ jobs, outcomes = {}, nextAvailableAt = null } = {}) {
  let pending = [...jobs]
  const selectDue = vi.fn(async ({ task, now, excludeArticleIds = [] } = {}) => {
    const excluded = new Set(excludeArticleIds.map(String))
    return pending.find((job) => job.task === task && job.availableAt <= now && !excluded.has(String(job.articleId))) ?? null
  })
  const claimAndExecute = vi.fn(async ({ candidate: job } = {}) => {
    pending = pending.filter(({ id }) => id !== job.id)
    const result = outcomes[job.id] ?? { status: 'succeeded', claimed: true }
    return typeof result === 'function' ? result({ candidate: job }) : result
  })
  return {
    queue: { selectDue, claimAndExecute, nextAvailableAt: vi.fn(async () => nextAvailableAt) },
    selectDue,
    claimAndExecute,
  }
}

describe('force indexing drain script', () => {
  it('defaults to a dry run and exposes the bounded production profile', () => {
    expect(parseArgs([])).toEqual({
      confirm: false,
      dryRun: true,
      maxClaims: MAX_CLAIMS,
      budgetMs: MAX_BUDGET_MS,
      confirmDatabase: null,
      help: false,
    })
  })

  it('requires an explicit confirmation and validates claim and budget bounds', async () => {
    expect(parseArgs(['--confirm', '--confirm-database=test_db', '--max-claims=7', '--budget-ms=12000'])).toEqual({
      confirm: true,
      dryRun: false,
      maxClaims: 7,
      budgetMs: 12000,
      confirmDatabase: 'test_db',
      help: false,
    })
    expect(() => parseArgs(['--confirm', '--dry-run'])).toThrow(/mutually exclusive/i)
    expect(() => parseArgs(['--confirm'])).toThrow(/confirm-database/i)
    expect(() => parseArgs(['--confirm-database=test_db'])).toThrow(/requires confirm/i)
    expect(() => parseArgs(['--confirm', '--confirm-database=bad-name'])).toThrow(/confirm-database/i)
    expect(() => parseArgs([`--max-claims=${MAX_CLAIMS + 1}`])).toThrow(/max-claims/i)
    expect(() => parseArgs([`--budget-ms=${MAX_BUDGET_MS + 1}`])).toThrow(/budget-ms/i)
    expect(() => parseArgs(['--unknown'])).toThrow(/unknown argument/i)
    await expect(runForceDrain({ options: { dryRun: false }, runtime: { queue: {} } })).rejects.toThrow(/confirm/i)
  })

  it('previews only due summary and embedding jobs without claiming or mutating', async () => {
    const fixture = queueFixture({
      jobs: [
        candidate('summary-due', 'article-summary', 'summary'),
        candidate('embedding-due', 'article-embedding', 'embedding'),
        candidate('summary-future', 'article-future', 'summary', new Date(NOW.getTime() + 60_000)),
        candidate('visibility-due', 'article-visibility', 'visibility-reconcile'),
      ],
    })

    const result = await runForceDrain({
      options: parseArgs([]),
      runtime: { queue: fixture.queue },
      now: () => NOW,
    })

    expect(result).toEqual(expect.objectContaining({
      ok: true,
      mode: 'dry-run',
      dryRun: true,
      candidates: { due: 2, summary: 1, embedding: 1 },
      counters: EMPTY_COUNTERS,
    }))
    expect(fixture.claimAndExecute).not.toHaveBeenCalled()
    expect(fixture.selectDue.mock.calls.map(([input]) => input.task)).not.toContain('visibility-reconcile')
  })

  it('uses the existing indexing queue runner after confirmation and leaves failed outcomes for retry', async () => {
    const fixture = queueFixture({
      jobs: [
        candidate('summary-failed', 'article-a', 'summary'),
        candidate('embedding-ok', 'article-b', 'embedding'),
        candidate('visibility-ignored', 'article-c', 'visibility-reconcile'),
      ],
      outcomes: {
        'summary-failed': { status: 'failed', claimed: true },
      },
    })
    const retry = vi.fn()
    const result = await runForceDrain({
      options: parseArgs(['--confirm', '--confirm-database=test_db', '--max-claims=2']),
      environment: { MONGODB_DATABASE: 'test_db' },
      runtime: { database: 'test_db', queue: { ...fixture.queue, retry } },
      now: () => NOW,
    })

    expect(result).toEqual(expect.objectContaining({
      ok: true,
      mode: 'execute',
      dryRun: false,
      counters: { claimed: 2, succeeded: 1, partial: 0, failed: 1, deferred: 0 },
    }))
    expect(fixture.claimAndExecute).toHaveBeenCalledTimes(2)
    expect(fixture.claimAndExecute.mock.calls.map(([input]) => input.candidate.task)).toEqual(['summary', 'embedding'])
    expect(retry).not.toHaveBeenCalled()
  })

  it('rejects execution when the confirmed database identity does not match the runtime', async () => {
    const fixture = queueFixture({ jobs: [candidate('summary-due', 'article-a', 'summary')] })
    await expect(runForceDrain({
      options: parseArgs(['--confirm', '--confirm-database=other_db']),
      runtime: { database: 'test_db', queue: fixture.queue },
      now: () => NOW,
    })).rejects.toThrow(/does not match/i)
    expect(fixture.claimAndExecute).not.toHaveBeenCalled()
  })

  it('forwards exact job scope and rejects an out-of-scope candidate', async () => {
    const allowedId = 'a'.repeat(24)
    const allowedFixture = queueFixture({ jobs: [candidate(allowedId, 'article-a', 'summary')] })
    const allowedResult = await runForceDrain({
      options: parseArgs(['--confirm', '--confirm-database=test_db', '--max-claims=1']),
      environment: { MONGODB_DATABASE: 'test_db' },
      runtime: { database: 'test_db', queue: allowedFixture.queue },
      scope: { jobIds: [allowedId] },
      now: () => NOW,
    })
    expect(allowedResult.counters).toEqual({ claimed: 1, succeeded: 1, partial: 0, failed: 0, deferred: 0 })
    expect(allowedFixture.selectDue).toHaveBeenCalledWith(expect.objectContaining({ jobIds: [allowedId] }))

    const blockedFixture = queueFixture({ jobs: [candidate('b'.repeat(24), 'article-b', 'summary')] })
    await expect(runForceDrain({
      options: parseArgs(['--confirm', '--confirm-database=test_db', '--max-claims=1']),
      environment: { MONGODB_DATABASE: 'test_db' },
      runtime: { database: 'test_db', queue: blockedFixture.queue },
      scope: { jobIds: [allowedId] },
      now: () => NOW,
    })).rejects.toThrow(/out-of-scope/i)
    expect(blockedFixture.claimAndExecute).not.toHaveBeenCalled()
  })

  it('rejects a mismatched database before loading a mutating runtime', async () => {
    const loadRuntime = vi.fn(async () => { throw new Error('runtime must not load') })
    await expect(runForceDrain({
      options: parseArgs(['--confirm', '--confirm-database=other_db']),
      environment: { MONGODB_DATABASE: 'test_db' },
      loadRuntime,
      now: () => NOW,
    })).rejects.toThrow(/does not match/i)
    expect(loadRuntime).not.toHaveBeenCalled()
  })

  it('uses the read-only loader for dry-run instead of bootstrapping mutating capabilities', async () => {
    const fixture = queueFixture({ jobs: [candidate('summary-due', 'article-a', 'summary')] })
    const loadReadOnlyRuntime = vi.fn(async () => ({ queue: fixture.queue }))
    const loadRuntime = vi.fn(async () => { throw new Error('mutating runtime must not load during dry-run') })

    const result = await runForceDrain({
      options: parseArgs([]),
      loadReadOnlyRuntime,
      loadRuntime,
      now: () => NOW,
    })

    expect(result.candidates.due).toBe(1)
    expect(loadReadOnlyRuntime).toHaveBeenCalledOnce()
    expect(loadRuntime).not.toHaveBeenCalled()
  })

  it('loads common, jobs and indexing capabilities for confirmed execution', async () => {
    const fixture = queueFixture({ jobs: [candidate('summary-due', 'article-a', 'summary')] })
    const common = { context: { marker: 'common', database: 'test_db' } }
    const jobs = { queueRegistry: { get: vi.fn(() => fixture.queue) } }
    const indexing = { providerAdapters: { marker: 'indexing' } }
    const factories = {
      common: vi.fn(async () => common),
      jobs: vi.fn(async (input) => { expect(input).toEqual({ common }); return jobs }),
      indexing: vi.fn(async (input) => { expect(input).toEqual({ common, jobs }); return indexing }),
    }

    const result = await runForceDrain({
      options: parseArgs(['--confirm', '--confirm-database=test_db']),
      environment: { MONGODB_DATABASE: 'test_db' },
      factories,
      now: () => NOW,
    })

    expect(result.counters.succeeded).toBe(1)
    expect(factories.common).toHaveBeenCalledOnce()
    expect(factories.jobs).toHaveBeenCalledOnce()
    expect(factories.indexing).toHaveBeenCalledOnce()
  })
})
