import { describe, expect, it, vi } from 'vitest'
import {
  RECONCILE_SOURCE_POLICY_USAGE,
  main,
  parseReconcileSourcePolicyArgs,
  runReconcileSourcePolicy,
} from '../../scripts/reconcile-source-policy.js'

const SOURCE_ID = '507f1f77bcf86cd799439011'

describe('source policy reconciliation CLI', () => {
  it('defaults to a bounded dry run and validates source and page bounds', () => {
    expect(parseReconcileSourcePolicyArgs([`--source-id=${SOURCE_ID}`])).toEqual({
      sourceId: SOURCE_ID,
      limit: 100,
      maxPages: 10,
      confirm: false,
      dryRun: true,
      confirmDatabase: null,
    })
    expect(parseReconcileSourcePolicyArgs(['--help'])).toEqual({ help: true })
    expect(() => parseReconcileSourcePolicyArgs([`--source-id=${SOURCE_ID}`, '--limit=0'])).toThrow(/limit is invalid/i)
    expect(() => parseReconcileSourcePolicyArgs([`--source-id=${SOURCE_ID}`, '--limit=101'])).toThrow(/limit is invalid/i)
    expect(() => parseReconcileSourcePolicyArgs([`--source-id=${SOURCE_ID}`, '--max-pages=0'])).toThrow(/max-pages is invalid/i)
    expect(() => parseReconcileSourcePolicyArgs([`--source-id=${SOURCE_ID}`, '--max-pages=11'])).toThrow(/max-pages is invalid/i)
    expect(() => parseReconcileSourcePolicyArgs([`--source-id=${SOURCE_ID}`, '--unknown'])).toThrow(/arguments are invalid/i)
  })

  it('requires database confirmation only for execution', () => {
    expect(parseReconcileSourcePolicyArgs([`--source-id=${SOURCE_ID}`, '--confirm', '--confirm-database=techpulse_app'])).toEqual(expect.objectContaining({ confirm: true, dryRun: false, confirmDatabase: 'techpulse_app' }))
    expect(() => parseReconcileSourcePolicyArgs([`--source-id=${SOURCE_ID}`, '--confirm'])).toThrow(/confirm-database/i)
    expect(() => parseReconcileSourcePolicyArgs([`--source-id=${SOURCE_ID}`, '--confirm-database=techpulse_app'])).toThrow(/requires confirm/i)
  })

  it('rejects a mismatched database before loading an execution runtime', async () => {
    const loadRuntime = vi.fn(async () => { throw new Error('runtime must not load') })
    await expect(runReconcileSourcePolicy({
      options: parseReconcileSourcePolicyArgs([`--source-id=${SOURCE_ID}`, '--confirm', '--confirm-database=other_db']),
      environment: { MONGODB_DATABASE: 'techpulse_app' },
      loadRuntime,
    })).rejects.toThrow(/does not match/i)
    expect(loadRuntime).not.toHaveBeenCalled()
  })

  it('prints help without connecting to MongoDB', async () => {
    const log = vi.fn()
    const errorLog = vi.fn()
    const result = await main(['--help'], { log, errorLog })
    expect(result).toEqual({ ok: true, help: true })
    expect(log).toHaveBeenCalledWith(RECONCILE_SOURCE_POLICY_USAGE)
    expect(errorLog).not.toHaveBeenCalled()
  })

  it('returns only safe summary fields from a configured worker', async () => {
    const worker = {
      run: vi.fn(async () => ({
        outcome: 'completed',
        sourceId: SOURCE_ID,
        policyVersion: 8,
        inspected: 3,
        wouldCreate: 1,
        created: 1,
        pages: 1,
        hasMore: false,
        jobs: [{ id: 'job-1', task: 'visibility-reconcile', articleId: SOURCE_ID }],
      })),
    }
    const result = await runReconcileSourcePolicy({
      options: parseReconcileSourcePolicyArgs([`--source-id=${SOURCE_ID}`]),
      environment: { MONGODB_DATABASE: 'techpulse_app' },
      runtime: { database: 'techpulse_app', worker },
    })
    expect(JSON.stringify(result)).not.toMatch(/providerPayload|rightsSnapshot|fullText|rawHtml|secret|api[_-]?key|token|https:\/\//i)
    expect(worker.run).toHaveBeenCalledWith({ sourceId: SOURCE_ID, dryRun: true, limit: 100, maxPages: 10 })
  })
})
