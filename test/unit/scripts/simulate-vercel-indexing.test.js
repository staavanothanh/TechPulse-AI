import { describe, expect, it } from 'vitest'
import {
  assertInitialIndexingBatch,
  buildVercelCronHeaders,
  parseIndexingSimulationArgs,
  summarizeIndexingJobs,
  summarizeIndexingOutcome,
} from '../../../scripts/simulate-vercel-indexing.js'

const JOBS = [
  { id: 'summary-1', task: 'summary', status: 'queued' },
  { id: 'embedding-1', task: 'embedding', status: 'queued' },
  { id: 'summary-2', task: 'summary', status: 'succeeded' },
]

describe('simulate Vercel indexing helpers', () => {
  it('uses the current 345-job queued backlog as the default starting state', () => {
    expect(parseIndexingSimulationArgs([])).toEqual({
      confirm: false,
      confirmDatabase: null,
      expectedQueued: 345,
      expectedRunning: 0,
      maxClaims: 200,
      maxInvocations: 2,
      timeoutMs: 300_000,
    })
  })

  it('parses bounded drain options and rejects unsafe values', () => {
    expect(parseIndexingSimulationArgs([
      '--expected-queued=12',
      '--expected-running=1',
      '--max-claims=50',
      '--max-invocations=3',
      '--timeout-ms=270000',
      '--confirm',
      '--confirm-database=techpulse_app',
    ])).toEqual({
      confirm: true,
      confirmDatabase: 'techpulse_app',
      expectedQueued: 12,
      expectedRunning: 1,
      maxClaims: 50,
      maxInvocations: 3,
      timeoutMs: 270_000,
    })
    expect(() => parseIndexingSimulationArgs(['--max-claims=201'])).toThrow(/safe bound/i)
    expect(() => parseIndexingSimulationArgs(['--max-invocations=0'])).toThrow(/safe bound/i)
    expect(() => parseIndexingSimulationArgs([
      '--expected-queued=5000',
      '--expected-running=1',
    ])).toThrow(/expected indexing job count/i)
  })

  it('summarizes queued, running, and terminal indexing jobs', () => {
    expect(summarizeIndexingJobs(JOBS)).toEqual({ total: 3, queued: 2, running: 0, terminal: 1 })
  })

  it('requires the expected initial queue shape', () => {
    expect(assertInitialIndexingBatch(JOBS.slice(0, 2), { expectedQueued: 2, expectedRunning: 0 })).toEqual({
      ids: ['summary-1', 'embedding-1'],
      total: 2,
      queued: 2,
      running: 0,
    })
    expect(() => assertInitialIndexingBatch(JOBS, { expectedQueued: 2, expectedRunning: 0 })).toThrow(/starting state/i)
  })

  it('builds the Vercel Cron bearer headers', () => {
    expect(buildVercelCronHeaders('machine-secret')).toEqual({
      Accept: 'application/json',
      Authorization: 'Bearer machine-secret',
      'User-Agent': 'vercel-cron/1.0',
    })
    expect(() => buildVercelCronHeaders('')).toThrow(/secret/i)
  })

  it('does not mark terminal failures as a successful drain', () => {
    expect(summarizeIndexingOutcome({
      finalSummary: { succeeded: 2, failed: 1, partial: 0, cancelled: 0 },
      pendingTarget: [],
      nonTerminalBacklogAfter: 0,
    })).toEqual({ drained: true, terminalUnsuccessful: 1, ok: false })
    expect(summarizeIndexingOutcome({
      finalSummary: { succeeded: 3, failed: 0, partial: 0, cancelled: 0 },
      pendingTarget: [],
      nonTerminalBacklogAfter: 0,
    })).toEqual({ drained: true, terminalUnsuccessful: 0, ok: true })
  })
})
