import { describe, expect, it } from 'vitest'
import { nextIndexingPollDelay, shouldPollIndexingJob } from '../../client/features/admin/jobs/indexing/polling.js'

describe('Step 9 adaptive indexing polling policy', () => {
  it('uses the exact owner-approved cadence boundaries', () => {
    expect(nextIndexingPollDelay({ elapsedMs: 0 })).toBe(2000)
    expect(nextIndexingPollDelay({ elapsedMs: 29_999 })).toBe(2000)
    expect(nextIndexingPollDelay({ elapsedMs: 30_000 })).toBe(5000)
    expect(nextIndexingPollDelay({ elapsedMs: 119_999 })).toBe(5000)
    expect(nextIndexingPollDelay({ elapsedMs: 120_000 })).toBe(10_000)
  })

  it('honors Retry-After and bounded error backoff without accelerating base cadence', () => {
    expect(nextIndexingPollDelay({ elapsedMs: 0, errorCount: 1 })).toBe(4000)
    expect(nextIndexingPollDelay({ elapsedMs: 40_000, errorCount: 2 })).toBe(20_000)
    expect(nextIndexingPollDelay({ elapsedMs: 0, retryAfterSeconds: 30 })).toBe(30_000)
    expect(nextIndexingPollDelay({ elapsedMs: 200_000, errorCount: 9 })).toBe(60_000)
  })

  it('polls only queued/running while visible and online', () => {
    expect(shouldPollIndexingJob({ status: 'queued' }, { visible: true, online: true })).toBe(true)
    expect(shouldPollIndexingJob({ status: 'running' }, { visible: true, online: true })).toBe(true)
    expect(shouldPollIndexingJob({ status: 'running' }, { visible: false, online: true })).toBe(false)
    expect(shouldPollIndexingJob({ status: 'running' }, { visible: true, online: false })).toBe(false)
    for (const status of ['succeeded', 'partial', 'failed', 'cancelled']) expect(shouldPollIndexingJob({ status }, { visible: true, online: true })).toBe(false)
  })
})
