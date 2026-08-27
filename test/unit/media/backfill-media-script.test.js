import { describe, expect, it, vi } from 'vitest'
import { main, parseMediaBackfillArgs, runMediaBackfill } from '../../../scripts/backfill-media.js'

describe('media backfill operation script', () => {
  it('requires a source key, rejects arbitrary feed URLs, and defaults to dry-run mode', () => {
    expect(() => parseMediaBackfillArgs([])).toThrow('source-key is required')
    expect(() => parseMediaBackfillArgs(['--source-key=rss:example', '--feed-url=https://untrusted.example/feed.xml'])).toThrow('arguments are invalid')
    expect(parseMediaBackfillArgs(['--source-key=rss:example'])).toMatchObject({ sourceKey: 'rss:example', confirm: false, dryRun: true, limit: 100 })
  })

  it('requires both confirmation flags for a write and bounds its batch size', () => {
    expect(() => parseMediaBackfillArgs(['--source-key=rss:example', '--confirm'])).toThrow('confirm-database is required with confirm')
    expect(() => parseMediaBackfillArgs(['--source-key=rss:example', '--confirm-database=techpulse_app'])).toThrow('confirm-database requires confirm')
    expect(() => parseMediaBackfillArgs(['--source-key=rss:example', '--limit=101'])).toThrow('limit is invalid')
    expect(parseMediaBackfillArgs(['--source-key=rss:example', '--confirm', '--confirm-database=techpulse_app', '--limit=1'])).toMatchObject({ confirm: true, dryRun: false, confirmDatabase: 'techpulse_app', limit: 1 })
  })

  it('requires exact database confirmation for writes and reports the worker result without source payloads', async () => {
    const worker = { run: vi.fn(async () => ({ outcome: 'completed', fetched: 1, inspected: 1, updated: 1, wouldUpdate: 0, skipped: 0, failed: 0, skippedReasons: {}, failedReasons: {} })) }
    await expect(runMediaBackfill({
      options: parseMediaBackfillArgs(['--source-key=rss:example', '--confirm', '--confirm-database=other_db']),
      environment: { MONGODB_DATABASE: 'techpulse_app' },
      runtime: { database: 'techpulse_app', worker },
    })).rejects.toThrow('confirm-database does not match the configured runtime database')

    const result = await runMediaBackfill({
      options: parseMediaBackfillArgs(['--source-key=rss:example']),
      environment: { MONGODB_DATABASE: 'techpulse_app' },
      runtime: { database: 'techpulse_app', worker },
    })

    expect(worker.run).toHaveBeenCalledWith({ sourceKey: 'rss:example', dryRun: true, limit: 100 })
    expect(result).toEqual(expect.objectContaining({ ok: true, mode: 'dry-run', fetched: 1, updated: 1 }))
    expect(JSON.stringify(result)).not.toContain('https://')
  })

  it('exposes a direct executable help path without opening a database connection', async () => {
    const log = vi.fn()
    const errorLog = vi.fn()

    await expect(main(['--help'], { log, errorLog })).resolves.toEqual({ ok: true, help: true })

    expect(log).toHaveBeenCalledWith(expect.stringContaining('node scripts/backfill-media.js'))
    expect(errorLog).not.toHaveBeenCalled()
  })

  it('returns a failed operation result when the bounded worker cannot fetch the reviewed feed', async () => {
    const worker = { run: vi.fn(async () => ({ outcome: 'failed', fetched: 0, inspected: 0, updated: 0, wouldUpdate: 0, skipped: 0, failed: 1, skippedReasons: {}, failedReasons: { source_fetch_timeout: 1 } })) }

    const result = await runMediaBackfill({
      options: parseMediaBackfillArgs(['--source-key=rss:example']),
      environment: { MONGODB_DATABASE: 'techpulse_app' },
      runtime: { database: 'techpulse_app', worker },
    })

    expect(result).toMatchObject({ ok: false, outcome: 'failed', failed: 1, failedReasons: { source_fetch_timeout: 1 } })
  })
})
