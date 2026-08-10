import { describe, expect, it, vi } from 'vitest'
import { Readable } from 'node:stream'
import { createJobService } from '../../../server/application/jobs/service.js'
import { createSafeFetch } from '../../../server/infrastructure/http/safe-fetch.js'
import { createJobActions } from '../../../client/features/admin/jobs/job-actions.js'
import { DURABLE_JOB_INDEXES } from '../../../scripts/migrations/durable-jobs.js'
import { createSourceService } from '../../../server/application/sources/service.js'

const auth = {
  user: { id: '507f1f77bcf86cd799439011', role: 'admin', status: 'active' },
  session: { _id: '507f1f77bcf86cd799439012', userSessionVersion: 1 },
}
const source = {
  id: '507f1f77bcf86cd799439013', connectorType: 'rss', policyVersion: 1,
  connectorConfig: { kind: 'rss', feedUrl: 'https://example.com/feed.xml', batchSize: 20 },
  operationalStatus: 'active', licenseStatus: 'metadata-only', technicalCheck: { status: 'passed' },
}

describe('Step 4 final-gate RED regressions', () => {
  it('reserves the Mongo-backed admin-trigger quota before creating a manual job', async () => {
    const rateLimitAdmission = { reserve: vi.fn(async () => ({ allowed: false, retryAfterSeconds: 42 })) }
    const jobRepository = { createOrReuseIngestionJobWithAdmission: vi.fn(async ({ admission, rateLimitAdmission: limiter }) => {
      const result = await limiter.reserve(admission)
      if (!result.allowed) throw Object.assign(new Error('rate limited'), { status: 429, code: 'rate_limit_exceeded', retryAfter: result.retryAfterSeconds })
    }) }
    const service = createJobService({
      jobRepository,
      sourceRepository: { findSourceById: vi.fn(async () => source) },
      rateLimitAdmission,
      now: () => new Date('2026-08-10T00:00:00.000Z'),
    })
    await expect(service.createIngestionJob({ auth, input: { sourceId: source.id }, idempotencyKey: 'step4-final-red-key' })).rejects.toMatchObject({ status: 429, code: 'rate_limit_exceeded', retryAfter: 42 })
    expect(rateLimitAdmission.reserve).toHaveBeenCalledWith(expect.objectContaining({ scope: 'admin-trigger', subject: auth.user.id }))
    expect(jobRepository.createOrReuseIngestionJobWithAdmission).toHaveBeenCalledTimes(1)
  })

  it('honors the exact 20/21 admin-trigger boundary without persisting the rejected intent', async () => {
    let count = 0
    const rateLimitAdmission = { reserve: vi.fn(async () => ({ allowed: ++count <= 20, retryAfterSeconds: 60 })) }
    const jobRepository = { createOrReuseIngestionJobWithAdmission: vi.fn(async ({ job, admission, rateLimitAdmission }) => {
      const result = await rateLimitAdmission.reserve(admission)
      if (!result.allowed) throw Object.assign(new Error('rate limited'), { status: 429, code: 'rate_limit_exceeded', retryAfter: result.retryAfterSeconds })
      return job
    }) }
    const service = createJobService({ jobRepository, sourceRepository: { findSourceById: vi.fn(async () => source) }, rateLimitAdmission, now: () => new Date('2026-08-10T00:00:00.000Z') })
    const results = await Promise.allSettled(Array.from({ length: 21 }, (_, index) => service.createIngestionJob({ auth, input: { sourceId: source.id }, idempotencyKey: `step4-boundary-${String(index).padStart(3, '0')}` })))
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(20)
    expect(results.filter((result) => result.status === 'rejected').map((result) => result.reason.status)).toEqual([429])
    expect(jobRepository.createOrReuseIngestionJobWithAdmission).toHaveBeenCalledTimes(21)
  })

  it('honors the exact 10/11 source-test boundary before safe-fetch can run', async () => {
    let count = 0
    const sourceRepository = {
      findSourceById: vi.fn(async () => ({ ...source, updatedAt: new Date('2026-08-10T00:00:00.000Z') })),
      commitReplacement: vi.fn(async ({ source: next }) => next),
    }
    const technicalCheckAdapter = { run: vi.fn(async () => ({ status: 'passed', contentType: 'application/rss+xml', resolvedHost: 'example.com', sampleCount: 1 })) }
    const service = createSourceService({ repository: sourceRepository, technicalCheckAdapter, rateLimitAdmission: { reserve: vi.fn(async () => ({ allowed: ++count <= 10, retryAfterSeconds: 60 })) }, now: () => new Date('2026-08-10T00:00:01.000Z') })
    const results = await Promise.allSettled(Array.from({ length: 11 }, () => service.runTechnicalCheck({ auth, sourceId: source.id, request: { serverRequestId: 'source-test-boundary' } })))
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(10)
    expect(results.filter((result) => result.status === 'rejected').map((result) => result.reason.status)).toEqual([429])
    expect(technicalCheckAdapter.run).toHaveBeenCalledTimes(10)
  })

  it('accepts a real Node IncomingMessage-shaped response stream and reads its body', async () => {
    const stream = Readable.from([Buffer.from('<rss/>')])
    stream.statusCode = 200
    stream.headers = { 'content-type': 'application/rss+xml' }
    const safeFetch = createSafeFetch({ lookup: async () => [{ address: '93.184.216.34', family: 4 }], request: async () => stream })
    await expect(safeFetch('https://example.com/feed.xml', { allowedContentTypes: ['application/rss+xml'] })).resolves.toEqual(expect.objectContaining({ body: Buffer.from('<rss/>') }))
  })

  it('retains a key after an ambiguous network failure, then replaces only an exact idempotency mismatch', async () => {
    const api = {
      createIngestionJob: vi.fn()
        .mockRejectedValueOnce(new Error('network interrupted'))
        .mockRejectedValueOnce({ status: 409, code: 'idempotency_mismatch' })
        .mockResolvedValueOnce({ data: { id: '507f1f77bcf86cd799439021' } }),
    }
    const createIdempotencyKey = vi.fn()
      .mockReturnValueOnce('key-for-ambiguous-retry')
      .mockReturnValueOnce('key-after-mismatch')
    const actions = createJobActions({ api, csrfToken: 'csrf', mutate: async (action) => action(), createIdempotencyKey })
    const input = { sourceId: source.id, batchSize: 20 }
    await expect(actions.onCreate(input)).rejects.toThrow('network interrupted')
    await expect(actions.onCreate(input)).rejects.toMatchObject({ status: 409, code: 'idempotency_mismatch' })
    await actions.onCreate(input)
    expect(api.createIngestionJob.mock.calls.map(([request]) => request.headers['Idempotency-Key'])).toEqual([
      'key-for-ambiguous-retry',
      'key-for-ambiguous-retry',
      'key-after-mismatch',
    ])
    expect(createIdempotencyKey).toHaveBeenCalledTimes(2)
  })

  it('retains the intent key for a non-mismatch 409 conflict', async () => {
    const api = { createIngestionJob: vi.fn().mockRejectedValueOnce({ status: 409, code: 'conflict' }).mockResolvedValueOnce({ data: { id: '507f1f77bcf86cd799439022' } }) }
    const createIdempotencyKey = vi.fn(() => 'key-for-conflict-retry')
    const actions = createJobActions({ api, csrfToken: 'csrf', mutate: async (action) => action(), createIdempotencyKey })
    const input = { sourceId: source.id, batchSize: 20 }
    await expect(actions.onCreate(input)).rejects.toMatchObject({ status: 409, code: 'conflict' })
    await actions.onCreate(input)
    expect(api.createIngestionJob.mock.calls.map(([request]) => request.headers['Idempotency-Key'])).toEqual(['key-for-conflict-retry', 'key-for-conflict-retry'])
    expect(createIdempotencyKey).toHaveBeenCalledTimes(1)
  })

  it('locks linked retry identity independently of actor idempotency identity', () => {
    expect(DURABLE_JOB_INDEXES.ingestionJobs).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: 'ingestion_parent_attempt_unique', key: { parentJobId: 1, attempt: 1 }, options: expect.objectContaining({ unique: true }) }),
    ]))
  })
})
