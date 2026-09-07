import { describe, expect, it, vi } from 'vitest'
import { ObjectId } from 'mongodb'
import { createJobService } from '../../../server/application/jobs/service.js'
const NOW = new Date('2026-08-10T00:00:00.000Z')
const auth = {
  user: { id: '507f1f77bcf86cd799439011', role: 'admin', status: 'active' },
  session: { _id: '507f1f77bcf86cd799439012', userSessionVersion: 2 },
}
const source = {
  id: '507f1f77bcf86cd799439013', connectorType: 'rss', connectorConfig: { kind: 'rss', feedUrl: 'https://example.com/feed.xml', batchSize: 20 },
  operationalStatus: 'active', licenseStatus: 'metadata-only', policyVersion: 4,
  technicalCheck: { status: 'passed' },
}


function fixture(overrides = {}) {
  const jobRepository = {
    createOrReuseIngestionJobWithAdmission: vi.fn(async ({ job }) => job),
    listIngestionJobs: vi.fn(async () => ({ jobs: [], hasNext: false, nextCursor: null })),
    findIngestionJobById: vi.fn(async () => null),
    cancelIngestionJob: vi.fn(async ({ jobId }) => ({ id: jobId, status: 'cancelled' })),
    ...overrides.jobRepository,
  }
  const sourceRepository = { findSourceById: vi.fn(async () => source), ...overrides.sourceRepository }
  const rateLimitAdmission = overrides.rateLimitAdmission ?? { reserve: vi.fn(async () => ({ allowed: true })) }
  return { jobRepository, sourceRepository, rateLimitAdmission, service: createJobService({ jobRepository, sourceRepository, rateLimitAdmission, runDueWork: overrides.runDueWork, trace: overrides.trace, now: () => new Date(NOW) }) }
}

describe('ingestion job service', () => {
  it('creates an eligible durable job with a 14-day idempotency floor', async () => {
    const { service, jobRepository } = fixture()
    const job = await service.createIngestionJob({ auth, input: { sourceId: source.id, batchSize: 10 }, idempotencyKey: 'manual-ingest-0001', request: { serverRequestId: 'request-1' } })
    expect(job.status).toBe('queued')
    expect(job.expectedSourcePolicyVersion).toBe(4)
    expect(job.connectorType).toBe('rss')
    expect(job.idempotencyExpiresAt.getTime() - job.createdAt.getTime()).toBeGreaterThanOrEqual(14 * 24 * 60 * 60 * 1000)
    expect(job.agingEligibleAt.getTime() - job.createdAt.getTime()).toBe(30 * 60 * 1000)
    expect(jobRepository.createOrReuseIngestionJobWithAdmission).toHaveBeenCalledWith(expect.objectContaining({ actorFence: expect.objectContaining({ sessionVersion: 2 }), audit: expect.objectContaining({ reasonCode: 'ingestion_trigger_requested' }), admission: { scope: 'admin-trigger', subject: auth.user.id } }))
  })

  it('returns the committed queued job without invoking an injected coordinator', async () => {
    const coordinator = vi.fn(async () => {
      throw new Error('coordinator must not run during job creation')
    })
    const trace = vi.fn()
    const { service, jobRepository } = fixture({ runDueWork: coordinator, trace })

    const job = await service.createIngestionJob({
      auth,
      input: { sourceId: source.id },
      idempotencyKey: 'enqueue-only-create-1',
    })

    expect(job).toMatchObject({ status: 'queued', sourceId: source.id, connectorType: source.connectorType })
    expect(jobRepository.createOrReuseIngestionJobWithAdmission).toHaveBeenCalledOnce()
    expect(coordinator).not.toHaveBeenCalled()
    expect(trace).not.toHaveBeenCalled()
  })

  it('normalizes a Mongo admin identifier before rate-limit admission', async () => {
    const { service, jobRepository } = fixture()
    const mongoAuth = {
      user: { _id: new ObjectId('507f1f77bcf86cd799439011'), role: 'admin', status: 'active' },
      session: { _id: new ObjectId('507f1f77bcf86cd799439012'), userSessionVersion: 2 },
    }

    await service.createIngestionJob({
      auth: mongoAuth,
      input: { sourceId: source.id },
      idempotencyKey: 'mongo-admin-admission-1',
    })

    expect(jobRepository.createOrReuseIngestionJobWithAdmission).toHaveBeenCalledWith(
      expect.objectContaining({ admission: { scope: 'admin-trigger', subject: '507f1f77bcf86cd799439011' } }),
    )
  })

  it.each([
    [{ operationalStatus: 'paused' }, 'active'],
    [{ licenseStatus: 'review-needed' }, 'policy'],
    [{ licenseStatus: 'blocked' }, 'policy'],
    [{ technicalCheck: { status: 'failed' } }, 'technical'],
  ])('rejects ineligible source before job persistence', async (patch, message) => {
    const { service, jobRepository } = fixture({ sourceRepository: { findSourceById: vi.fn(async () => ({ ...source, ...patch })) } })
    await expect(service.createIngestionJob({ auth, input: { sourceId: source.id }, idempotencyKey: 'manual-ingest-0001' })).rejects.toThrow(new RegExp(message, 'i'))
    expect(jobRepository.createOrReuseIngestionJobWithAdmission).not.toHaveBeenCalled()
  })
  it('propagates source lookup failures before job persistence', async () => {
    const sourceError = new Error('source lookup failed')
    const coordinator = vi.fn(async () => {
      throw new Error('coordinator must not run')
    })
    const { service, jobRepository } = fixture({
      runDueWork: coordinator,
      sourceRepository: { findSourceById: vi.fn(async () => { throw sourceError }) },
    })

    await expect(service.createIngestionJob({ auth, input: { sourceId: source.id }, idempotencyKey: 'source-failure-1' })).rejects.toBe(sourceError)
    expect(jobRepository.createOrReuseIngestionJobWithAdmission).not.toHaveBeenCalled()
    expect(coordinator).not.toHaveBeenCalled()
  })

  it('propagates admission failures before returning a committed job', async () => {
    const admissionError = new Error('admission unavailable')
    const coordinator = vi.fn(async () => {
      throw new Error('coordinator must not run')
    })
    const rateLimitAdmission = { reserve: vi.fn(async () => { throw admissionError }) }
    const jobRepository = {
      createOrReuseIngestionJobWithAdmission: vi.fn(async ({ rateLimitAdmission: admission }) => admission.reserve()),
    }
    const { service } = fixture({ runDueWork: coordinator, rateLimitAdmission, jobRepository })

    await expect(service.createIngestionJob({ auth, input: { sourceId: source.id }, idempotencyKey: 'admission-failure-1' })).rejects.toBe(admissionError)
    expect(rateLimitAdmission.reserve).toHaveBeenCalledOnce()
    expect(coordinator).not.toHaveBeenCalled()
  })

  it('propagates repository failures before returning a committed job', async () => {
    const repositoryError = new Error('repository write failed')
    const coordinator = vi.fn(async () => {
      throw new Error('coordinator must not run')
    })
    const jobRepository = {
      createOrReuseIngestionJobWithAdmission: vi.fn(async () => { throw repositoryError }),
    }
    const { service } = fixture({ runDueWork: coordinator, jobRepository })

    await expect(service.createIngestionJob({ auth, input: { sourceId: source.id }, idempotencyKey: 'repository-failure-1' })).rejects.toBe(repositoryError)
    expect(coordinator).not.toHaveBeenCalled()
  })

  it('returns the same committed job for an idempotent replay without executing a coordinator', async () => {
    const committed = { id: '507f1f77bcf86cd799439015', sourceId: source.id, status: 'queued', trigger: 'admin' }
    const coordinator = vi.fn(async () => {
      throw new Error('coordinator must not run')
    })
    const jobRepository = { createOrReuseIngestionJobWithAdmission: vi.fn(async () => committed) }
    const { service } = fixture({ runDueWork: coordinator, jobRepository })

    const first = await service.createIngestionJob({ auth, input: { sourceId: source.id }, idempotencyKey: 'replay-stable-1' })
    const replay = await service.createIngestionJob({ auth, input: { sourceId: source.id }, idempotencyKey: 'replay-stable-1' })

    expect(first).toBe(committed)
    expect(replay).toBe(committed)
    expect(replay).toEqual(first)
    expect(jobRepository.createOrReuseIngestionJobWithAdmission).toHaveBeenCalledTimes(2)
    expect(coordinator).not.toHaveBeenCalled()
  })

  it('creates a bounded linked retry and preserves its explicit kick semantics', async () => {
    const parent = { id: '507f1f77bcf86cd799439014', sourceId: source.id, status: 'failed', error: { retryable: true }, attempt: 1, batchSize: 20 }
    const coordinator = vi.fn(async () => {
      throw Object.assign(new Error('retry upstream details must not escape'), { code: 'source_fetch_failed', retryable: true })
    })
    const trace = vi.fn()
    const { service, jobRepository } = fixture({
      runDueWork: coordinator,
      trace,
      jobRepository: { findIngestionJobById: vi.fn(async () => parent) },
    })

    const retry = await service.retryIngestionJob({ auth, jobId: parent.id, idempotencyKey: 'retry-ingest-0001', reasonCode: 'job_retry_requested', request: { serverRequestId: 'request-2' } })

    expect(retry.parentJobId).toBe(parent.id)
    expect(retry.attempt).toBe(2)
    expect(retry.trigger).toBe('retry')
    expect(jobRepository.createOrReuseIngestionJobWithAdmission).toHaveBeenCalledWith(expect.objectContaining({ audit: expect.objectContaining({ reasonCode: 'job_retry_requested' }), parentJobId: parent.id, nextAttempt: 2 }))
    expect(coordinator).toHaveBeenCalledOnce()
    expect(trace).toHaveBeenCalledWith(expect.objectContaining({ stage: 'ingestion.trigger_kick', status: 'failed', jobId: retry.id, sourceId: source.id, errorCode: 'source_fetch_failed', retryable: true }))
    expect(JSON.stringify(trace.mock.calls)).not.toContain('retry upstream details')
  })

  it('rejects non-retryable failure and uses exact cancel reason', async () => {
    const parent = { id: '507f1f77bcf86cd799439014', sourceId: source.id, status: 'failed', error: { retryable: false }, attempt: 1, batchSize: 20 }
    const { service, jobRepository } = fixture({ jobRepository: { findIngestionJobById: vi.fn(async () => parent) } })
    await expect(service.retryIngestionJob({ auth, jobId: parent.id, idempotencyKey: 'retry-ingest-0001', reasonCode: 'job_retry_requested' })).rejects.toThrow(/not retryable/i)
    await expect(service.cancelIngestionJob({ auth, jobId: parent.id, reasonCode: 'wrong_reason' })).rejects.toThrow(/reasonCode/i)
    expect(jobRepository.cancelIngestionJob).not.toHaveBeenCalled()
  })

  it('lists, reads and cancels jobs only for an active admin session', async () => {
    const existing = { id: '507f1f77bcf86cd799439014', status: 'queued' }
    const { service, jobRepository } = fixture({ jobRepository: { findIngestionJobById: vi.fn(async () => existing) } })
    await expect(service.listIngestionJobs({ auth, query: { status: 'queued' } })).resolves.toEqual({ jobs: [], hasNext: false, nextCursor: null })
    await expect(service.getIngestionJob({ auth, jobId: existing.id })).resolves.toBe(existing)
    await expect(service.cancelIngestionJob({ auth, jobId: existing.id, reasonCode: 'job_cancel_requested', request: { serverRequestId: 'cancel-request' } })).resolves.toEqual({ id: existing.id, status: 'cancelled' })
    expect(jobRepository.cancelIngestionJob).toHaveBeenCalledWith(expect.objectContaining({ actorFence: expect.objectContaining({ sessionVersion: 2 }), request: expect.objectContaining({ serverRequestId: 'cancel-request' }) }))
    await expect(service.listIngestionJobs({ auth: { user: { role: 'user' } } })).rejects.toEqual(expect.objectContaining({ status: 403 }))
    await expect(service.listIngestionJobs()).rejects.toEqual(expect.objectContaining({ status: 401 }))
  })

  it('maps missing/malformed resources and retry limits to canonical client failures', async () => {
    const missing = fixture({ sourceRepository: { findSourceById: vi.fn(async () => null) } })
    await expect(missing.service.createIngestionJob({ auth, input: { sourceId: source.id }, idempotencyKey: 'manual-ingest-0002' })).rejects.toEqual(expect.objectContaining({ status: 404 }))
    const noJob = fixture()
    await expect(noJob.service.getIngestionJob({ auth, jobId: 'not-an-object-id' })).rejects.toEqual(expect.objectContaining({ status: 400 }))
    await expect(noJob.service.getIngestionJob({ auth, jobId: '507f1f77bcf86cd799439099' })).rejects.toEqual(expect.objectContaining({ status: 404 }))
    const maximum = { id: '507f1f77bcf86cd799439014', sourceId: source.id, status: 'partial', error: null, attempt: 3, batchSize: 20 }
    const maxFixture = fixture({ jobRepository: { findIngestionJobById: vi.fn(async () => maximum) } })
    await expect(maxFixture.service.retryIngestionJob({ auth, jobId: maximum.id, idempotencyKey: 'retry-ingest-0002', reasonCode: 'job_retry_requested' })).rejects.toThrow(/limit/i)
    await expect(maxFixture.service.retryIngestionJob({ auth, jobId: maximum.id, idempotencyKey: 'retry-ingest-0002', reasonCode: 'wrong' })).rejects.toEqual(expect.objectContaining({ status: 422 }))
  })

  it('fails construction without a rate-limit admission or atomic create-or-reuse boundary', () => {
    expect(() => createJobService({ jobRepository: {}, sourceRepository: {} })).toThrow(/rate-limit/i)
    expect(() => createJobService({ jobRepository: {}, sourceRepository: {}, rateLimitAdmission: { reserve() {} } })).toThrow(/atomic/i)
  })


  it('lets only an active admin run one bounded shared coordinator turn', async () => {
    const result = {
      runId: 'admin-due-work-run',
      startedAt: NOW,
      finishedAt: new Date(NOW.getTime() + 1_000),
      recovery: { inspected: 0, recovered: 0, retriesCreated: 0, failed: 0 },
      queues: {
        ingestion: { claimed: 1, succeeded: 1, partial: 0, failed: 0, deferred: 0 },
        indexing: { claimed: 1, succeeded: 1, partial: 0, failed: 0, deferred: 0 },
        accountDeletion: { claimed: 0, succeeded: 0, partial: 0, failed: 0, deferred: 0 },
      },
      nextAvailableAt: null,
    }
    const coordinator = vi.fn(async () => result)
    const { service, rateLimitAdmission } = fixture({ runDueWork: coordinator })

    await expect(service.runDueWork({ auth })).resolves.toBe(result)
    expect(coordinator).toHaveBeenCalledTimes(1)
    expect(rateLimitAdmission.reserve).toHaveBeenCalledWith({ scope: 'admin-trigger', subject: auth.user.id })
    await expect(service.runDueWork({ auth: { user: { role: 'user', status: 'active' } } })).rejects.toEqual(expect.objectContaining({ status: 403 }))
    expect(coordinator).toHaveBeenCalledTimes(1)
  })

  it('fails closed when the shared coordinator is unavailable', async () => {
    const { service } = fixture()
    await expect(service.runDueWork({ auth })).rejects.toEqual(expect.objectContaining({ status: 503, code: 'service_unavailable' }))
  })

  it('returns a bounded Retry-After failure before coordinator execution', async () => {
    const coordinator = vi.fn()
    const rateLimitAdmission = { reserve: vi.fn(async () => ({ allowed: false, retryAfterSeconds: 41 })) }
    const { service } = fixture({ runDueWork: coordinator, rateLimitAdmission })

    await expect(service.runDueWork({ auth })).rejects.toEqual(expect.objectContaining({ status: 429, code: 'rate_limit_exceeded', retryAfter: 41 }))
    expect(coordinator).not.toHaveBeenCalled()
  })
})
