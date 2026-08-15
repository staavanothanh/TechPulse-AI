import { describe, expect, it, vi } from 'vitest'
import { createIndexingJobService } from '../../../server/application/indexing/service.js'

const ARTICLE_ID = '507f1f77bcf86cd799439011'
const SOURCE_ID = '507f1f77bcf86cd799439021'
const USER_ID = '507f1f77bcf86cd799439001'
const SESSION_ID = '507f1f77bcf86cd799439031'
const auth = { user: { id: USER_ID, role: 'admin', status: 'active' }, session: { id: SESSION_ID, userSessionVersion: 7 } }
const article = { id: ARTICLE_ID, sourceId: SOURCE_ID, status: 'published' }
const source = { id: SOURCE_ID, policyVersion: 4, operationalStatus: 'active', technicalCheck: { status: 'passed' }, licenseStatus: 'permitted' }
const embeddingTarget = { dimensions: 3, version: 7, artifactCompatibilityId: 'embedding-compat-v1' }

function setup({ target = embeddingTarget } = {}) {
  const indexingJobRepository = {
    createOrReuseIndexingJobWithAdmission: vi.fn(async ({ job }) => job),
    listIndexingJobs: vi.fn(async () => ({ jobs: [], hasNext: false, nextCursor: null })),
    findIndexingJobById: vi.fn(),
    cancelIndexingJob: vi.fn(),
  }
  const articleRepository = { findArticleForIndexing: vi.fn(async () => article) }
  const sourceRepository = { findSourceById: vi.fn(async () => source) }
  const service = createIndexingJobService({
    indexingJobRepository, articleRepository, sourceRepository,
    rateLimitAdmission: { reserve: vi.fn(async () => ({ allowed: true })) },
    embeddingTarget: target, now: () => new Date('2026-08-10T00:00:00.000Z'),
  })
  return { service, indexingJobRepository, articleRepository, sourceRepository }
}

describe('Step 9 indexing job application service', () => {
  it('creates independent summary and embedding jobs with server-captured policy version', async () => {
    const { service, indexingJobRepository } = setup()
    const summary = await service.createSummaryJob({ auth, articleId: ARTICLE_ID, reasonCode: 'artifact_regeneration_requested', idempotencyKey: 'summary-manual-key', request: { requestId: 'req-summary' } })
    const embedding = await service.createIndexingJob({ auth, articleId: ARTICLE_ID, input: { task: 'embedding', reasonCode: 'artifact_regeneration_requested' }, idempotencyKey: 'embedding-manual-key', request: { requestId: 'req-embedding' } })

    expect(summary).toEqual(expect.objectContaining({ articleId: ARTICLE_ID, sourceId: SOURCE_ID, expectedSourcePolicyVersion: 4, task: 'summary', trigger: 'admin', status: 'queued' }))
    expect(embedding).toEqual(expect.objectContaining({ task: 'embedding', targetEmbeddingVersion: embeddingTarget.version, targetEmbeddingArtifactCompatibilityId: embeddingTarget.artifactCompatibilityId }))
    expect(summary.id).not.toBe(embedding.id)
    expect(indexingJobRepository.createOrReuseIndexingJobWithAdmission).toHaveBeenCalledTimes(2)
  })

  it('rejects disallowed task/body state and an article without a current eligible source', async () => {
    const { service, sourceRepository } = setup()
    await expect(service.createIndexingJob({ auth, articleId: ARTICLE_ID, input: { task: 'summary', reasonCode: 'artifact_regeneration_requested' }, idempotencyKey: 'invalid-task-key' })).rejects.toMatchObject({ status: 422, code: 'validation_error' })
    sourceRepository.findSourceById.mockResolvedValue({ ...source, policyVersion: 5, operationalStatus: 'paused' })
    await expect(service.createSummaryJob({ auth, articleId: ARTICLE_ID, reasonCode: 'artifact_regeneration_requested', idempotencyKey: 'blocked-summary-key' })).rejects.toMatchObject({ status: 409, code: 'source_policy_blocked' })
  })

  it('supports list/get/retry/cancel while keeping linked retry identity immutable', async () => {
    const { service, indexingJobRepository } = setup()
    const parent = {
      id: '507f1f77bcf86cd799439041', articleId: ARTICLE_ID, sourceId: SOURCE_ID, expectedSourcePolicyVersion: 4,
      task: 'embedding', trigger: 'admin', status: 'failed', attempt: 1, error: { retryable: true },
    }
    indexingJobRepository.findIndexingJobById.mockResolvedValue(parent)
    indexingJobRepository.cancelIndexingJob.mockResolvedValue({ ...parent, status: 'cancelled' })
    await expect(service.listIndexingJobs({ auth, query: {} })).resolves.toEqual(expect.objectContaining({ jobs: [] }))
    await expect(service.getIndexingJob({ auth, jobId: parent.id })).resolves.toEqual(parent)
    const retry = await service.retryIndexingJob({ auth, jobId: parent.id, reasonCode: 'job_retry_requested', idempotencyKey: 'retry-embedding-key' })
    expect(retry).toEqual(expect.objectContaining({ parentJobId: parent.id, attempt: 2, trigger: 'retry', task: 'embedding' }))
    await expect(service.cancelIndexingJob({ auth, jobId: parent.id, reasonCode: 'job_cancel_requested' })).resolves.toEqual(expect.objectContaining({ status: 'cancelled' }))
  })

  it('derives idempotency identity from the configured embedding target', async () => {
    const first = setup({ target: embeddingTarget })
    const second = setup({ target: { ...embeddingTarget, version: 8, artifactCompatibilityId: 'embedding-compat-v2' } })
    const firstJob = await first.service.createIndexingJob({ auth, articleId: ARTICLE_ID, input: { task: 'embedding', reasonCode: 'artifact_regeneration_requested' }, idempotencyKey: 'same-embedding-key' })
    const secondJob = await second.service.createIndexingJob({ auth, articleId: ARTICLE_ID, input: { task: 'embedding', reasonCode: 'artifact_regeneration_requested' }, idempotencyKey: 'same-embedding-key' })
    expect(firstJob.idempotencyKey).not.toBe(secondJob.idempotencyKey)
    expect(firstJob.requestHash).not.toBe(secondJob.requestHash)
  })
})
