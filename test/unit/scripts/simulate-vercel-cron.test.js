import { describe, expect, it } from 'vitest'
import {
  assertInitialBatch,
  buildVercelCronHeaders,
  parseSimulationArgs,
  summarizeJobs,
} from '../../../scripts/simulate-vercel-cron.js'

const JOBS = [
  ...Array.from({ length: 9 }, (_, index) => ({ id: `queued-${index}`, status: 'queued' })),
  { id: 'running-1', status: 'running' },
]

describe('simulate Vercel cron helpers', () => {
  it('uses the September 1 database period and expected ten-job starting state by default', () => {
    expect(parseSimulationArgs([])).toEqual({
      confirm: false,
      confirmDatabase: null,
      expectedQueued: 9,
      expectedRunning: 1,
      period: '2026-08-31',
      timeoutMs: 300_000,
    })
  })

  it('parses bounded execution options without accepting unsafe values', () => {
    expect(parseSimulationArgs([
      '--period=2026-08-30',
      '--expected-queued=3',
      '--expected-running=1',
      '--timeout-ms=10000',
      '--confirm',
      '--confirm-database=techpulse_app',
    ])).toEqual({
      confirm: true,
      confirmDatabase: 'techpulse_app',
      expectedQueued: 3,
      expectedRunning: 1,
      period: '2026-08-30',
      timeoutMs: 10_000,
    })
    expect(() => parseSimulationArgs(['--external'])).toThrow(/unknown option/i)
    expect(() => parseSimulationArgs(['--base-url=http://127.0.0.1:3010'])).toThrow(/unknown option/i)
    expect(() => parseSimulationArgs(['--expected-queued=201'])).toThrow(/safe bound/i)
  })

  it('summarizes only observable job state', () => {
    expect(summarizeJobs(JOBS)).toEqual({ total: 10, queued: 9, running: 1, terminal: 0 })
  })

  it('accepts exactly one running and nine queued jobs', () => {
    expect(assertInitialBatch(JOBS, { expectedQueued: 9, expectedRunning: 1 })).toEqual({
      ids: JOBS.map(({ id }) => id),
      total: 10,
      queued: 9,
      running: 1,
    })
    expect(() => assertInitialBatch(JOBS.slice(1), { expectedQueued: 9, expectedRunning: 1 })).toThrow(/starting state/i)
  })

  it('builds the same bearer and user-agent headers as Vercel Cron', () => {
    expect(buildVercelCronHeaders('machine-secret')).toEqual({
      Accept: 'application/json',
      Authorization: 'Bearer machine-secret',
      'User-Agent': 'vercel-cron/1.0',
    })
    expect(() => buildVercelCronHeaders('')).toThrow(/secret/i)
  })
})
