import { ObjectId } from 'mongodb'
import { describe, expect, it, vi } from 'vitest'
import {
  INDEXING_JOB_LIST_PROJECTION,
  MongoIndexingJobRepository,
  buildIngestionArtifactJobs,
  buildReconciliationJobs,
  indexingJobDocument,
  purgeAfterForIndexing,
  serializeIndexingJob,
} from '../../../server/repositories/mongo/indexing-job-repository.js'

const sourceId = new ObjectId('507f1f77bcf86cd799439011')
const articleId = new ObjectId('507f1f77bcf86cd799439012')
const jobId = new ObjectId('507f1f77bcf86cd799439013')
const sessionId = new ObjectId('507f1f77bcf86cd799439014')
const now = new Date('2026-08-20T08:00:00.000Z')

const sourcePolicy = {
  _id: sourceId,
  policyVersion: 3,
  operationalStatus: 'active',
  licenseStatus: 'permitted',
  llmInputScope: 'excerpt',
  reconciliation: { status: 'pending', requiredPolicyVersion: 3 },
  attributionRequired: false,
  attributionText: null,
  storageScope: { metadata: true, excerpt: true, summary: true, embedding: true },
  mediaPolicy: { imageMode: 'none', videoMode: 'none', allowedHosts: [], attributionRequired: false, evidenceNote: null },
  technicalCheck: { status: 'passed' },
  connectorType: 'rss',
}

const article = {
  _id: articleId,
  status: 'published',
  titleOriginal: 'Original title',
  titleVi: 'Tieu de',
  summaryStatus: 'ready',
  summaryVi: 'Tom tat',
  excerptOriginal: 'Excerpt',
  author: 'Author',
  sourceLanguage: 'en',
  topics: ['technology'],
}

function baseJob(overrides = {}) {
  return {
    id: jobId.toHexString(),
    idempotencyKey: 'indexing:job-1',
    actorScope: 'admin:admin-1',
    requestHash: 'a'.repeat(64),
    articleId: articleId.toHexString(),
    sourceId: sourceId.toHexString(),
    expectedSourcePolicyVersion: 3,
    task: 'summary',
    trigger: 'manual',
    status: 'queued',
    attempt: 1,
    priority: 50,
    availableAt: now,
    agingEligibleAt: new Date(now.getTime() + 1_800_000),
    idempotencyExpiresAt: new Date(now.getTime() + 14 * 86_400_000),
    leaseGeneration: 0,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  }
}

function document(overrides = {}) {
  const job = baseJob(overrides)
  return {
    _id: jobId,
    idempotencyKey: job.idempotencyKey,
    actorScope: job.actorScope,
    requestHash: job.requestHash,
    articleId,
    sourceId,
    expectedSourcePolicyVersion: job.expectedSourcePolicyVersion,
    task: job.task,
    trigger: job.trigger,
    status: job.status,
    attempt: job.attempt,
    priority: job.priority,
    availableAt: now,
    agingEligibleAt: new Date(now.getTime() + 1_800_000),
    idempotencyExpiresAt: new Date(now.getTime() + 14 * 86_400_000),
    leaseGeneration: job.leaseGeneration,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  }
}

function cursor(values = []) {
  const remaining = [...values]
  const result = {
    sort: vi.fn(() => result),
    hint: vi.fn(() => result),
    project: vi.fn(() => result),
    limit: vi.fn(() => result),
    toArray: vi.fn(async () => remaining),
    next: vi.fn(async () => remaining.shift() ?? null),
  }
  return result
}

function createContext({ findOne = {}, findResults = {}, updateResults = {}, findOneAndUpdateResults = {}, insertResults = {}, deleteResults = {}, session = null } = {}) {
  const collections = new Map()
  const take = (input, name, fallback) => {
    const queue = input[name]
    return Array.isArray(queue) && queue.length > 0 ? queue.shift() : fallback
  }
  const collection = (name) => {
    if (collections.has(name)) return collections.get(name)
    const handle = {
      findOne: vi.fn(async () => take(findOne, name, null)),
      find: vi.fn(() => cursor(take(findResults, name, []))),
      updateOne: vi.fn(async () => take(updateResults, name, { matchedCount: 1, upsertedCount: 0 })),
      findOneAndUpdate: vi.fn(async () => take(findOneAndUpdateResults, name, null)),
      insertOne: vi.fn(async () => take(insertResults, name, { acknowledged: true })),
      deleteMany: vi.fn(async () => take(deleteResults, name, { deletedCount: 1 })),
    }
    collections.set(name, handle)
    return handle
  }
  const transactionSession = session ?? {
    withTransaction: vi.fn(async (work) => work(transactionSession)),
    endSession: vi.fn(async () => {}),
  }
  const context = { db: { collection }, client: { startSession: vi.fn(() => transactionSession) }, now: () => now }
  return { repository: new MongoIndexingJobRepository(context, { embeddingTarget: { version: 2, artifactCompatibilityId: 'model-v2' } }), context, collections, session: transactionSession }
}

function actorFence() {
  return { userId: sourceId, sessionId, sessionVersion: 2 }
}

function leaseFence() {
  return { key: `reconciliation:source:${sourceId.toHexString()}`, ownerTokenHash: 'b'.repeat(64), leaseGeneration: 2 }
}

function audit(action = 'indexing_job_created') {
  return {
    eventId: 'indexing-audit-1', actorType: 'admin', actorId: sourceId, action, targetType: 'indexing-job', targetId: jobId,
    changedFields: action === 'indexing_job_created' ? ['status'] : ['cancellationRequestedAt'],
    reasonCode: action === 'indexing_job_created' ? 'artifact_regeneration_requested' : 'job_cancel_requested', requestId: 'request-1', result: 'succeeded', createdAt: now,
  }
}

describe('MongoIndexingJobRepository', () => {
  it('builds policy-aware ingestion and reconciliation jobs', () => {
    const ingestion = buildIngestionArtifactJobs({ source: sourcePolicy, article, now, embeddingTarget: { version: 2, artifactCompatibilityId: 'model-v2' } })
    expect(ingestion).toHaveLength(2)
    expect(ingestion.map(({ task }) => task)).toEqual(['summary', 'embedding'])
    expect(ingestion[1]).toEqual(expect.objectContaining({ targetEmbeddingVersion: 2, targetEmbeddingArtifactCompatibilityId: 'model-v2', trigger: 'ingestion' }))
    expect(buildIngestionArtifactJobs({ source: { ...sourcePolicy, policyVersion: 0 }, article, now })).toEqual([])

    const reconciliation = buildReconciliationJobs({ source: sourcePolicy, articleId: articleId.toHexString(), now, embeddingTarget: { version: 2, artifactCompatibilityId: 'model-v2' } })
    expect(reconciliation.map(({ task }) => task)).toEqual(['visibility-reconcile', 'summary', 'embedding'])
    expect(reconciliation.every(({ status, priority }) => status === 'queued' && priority === 75)).toBe(true)
    expect(() => buildReconciliationJobs({ source: sourcePolicy, articleId: 'bad', now })).toThrow(/identity/i)
    expect(purgeAfterForIndexing('failed', now, now)).toEqual(new Date(now.getTime() + 30 * 86_400_000))
    expect(purgeAfterForIndexing('succeeded', now, new Date(now.getTime() + 30 * 86_400_000))).toEqual(new Date(now.getTime() + 30 * 86_400_000))
  })

  it('serializes documents and validates repository transactions', async () => {
    expect(serializeIndexingJob(null)).toBeNull()
    const serialized = serializeIndexingJob(document({ requestedBy: sessionId, parentJobId: jobId, targetEmbeddingVersion: 2, targetEmbeddingArtifactCompatibilityId: 'model-v2', inputHash: 'c'.repeat(64), error: { code: 'provider_error' } }))
    expect(serialized).toEqual(expect.objectContaining({ id: jobId.toHexString(), articleId: articleId.toHexString(), sourceId: sourceId.toHexString(), requestedBy: sessionId.toHexString(), parentJobId: jobId.toHexString() }))
    expect(() => new MongoIndexingJobRepository()).toThrow(/context/i)
    const fixture = createContext()
    await expect(fixture.repository.withTransaction(async (transactionSession) => transactionSession)).resolves.toBe(fixture.session)
    expect(fixture.session.endSession).toHaveBeenCalled()
  })

  it('checks admin actor fences and inserts replay-safe indexing audits', async () => {
    const active = createContext({ findOne: { users: [{}], sessions: [{}], adminAuditLogs: [null] } })
    await expect(active.repository.assertActorFence(actorFence(), active.session)).resolves.toBe(true)
    await expect(active.repository.insertAudit(audit(), active.session)).resolves.toEqual(expect.objectContaining({ eventId: 'indexing-audit-1' }))
    const replay = createContext({ findOne: { adminAuditLogs: [audit()] } })
    await expect(replay.repository.insertAudit(audit(), replay.session)).resolves.toEqual(expect.objectContaining({ eventId: 'indexing-audit-1' }))
    const invalid = createContext()
    await expect(invalid.repository.assertActorFence({ userId: sourceId, sessionId, sessionVersion: 1 }, invalid.session)).resolves.toBe(false)
  })

  it('creates or reuses admitted indexing jobs and system jobs', async () => {
    const fixture = createContext({ findOne: { users: [{}], sessions: [{}], indexingJobs: [null], adminAuditLogs: [null] } })
    const reserve = vi.fn(async () => ({ allowed: true }))
    const job = baseJob()
    await expect(fixture.repository.createOrReuseIndexingJobWithAdmission({ job, audit: audit(), actorFence: actorFence(), rateLimitAdmission: { reserve }, admission: { scope: 'manual' } })).resolves.toBe(job)
    expect(fixture.collections.get('indexingJobs').insertOne).toHaveBeenCalledWith(expect.objectContaining({ _id: jobId, articleId }), { session: fixture.session })

    const reused = createContext({ findOne: { users: [{}], sessions: [{}], indexingJobs: [document({ status: 'succeeded' })] } })
    await expect(reused.repository.createOrReuseIndexingJobWithAdmission({ job, actorFence: actorFence(), rateLimitAdmission: { reserve } })).resolves.toEqual(expect.objectContaining({ status: 'succeeded' }))
    const system = createContext({ findOne: { indexingJobs: [null] } })
    await expect(system.repository.createSystemIndexingJob({ job: baseJob({ actorScope: 'system', idempotencyKey: 'system-1' }) })).resolves.toEqual(expect.objectContaining({ id: jobId.toHexString() }))
    const admissionError = createContext()
    await expect(admissionError.repository.reserveAdmission({ rateLimitAdmission: { reserve: vi.fn(async () => ({ allowed: false, retryAfterSeconds: 4 })) }, admission: {}, session: admissionError.session })).rejects.toMatchObject({ status: 429, retryAfter: 4 })
  })

  it('selects pending reconciliation sources and materializes a fenced page', async () => {
    const selected = createContext({ findResults: { sources: [[{ _id: sourceId, policyVersion: 3 }]] } })
    await expect(selected.repository.selectPendingReconciliationSource({ now, retryBackoffMs: 1_000 })).resolves.toEqual({ id: sourceId.toHexString(), policyVersion: 3 })
    await expect(selected.repository.selectPendingReconciliationSource({ now, retryBackoffMs: 0 })).rejects.toMatchObject({ status: 422 })

    const fixture = createContext({
      findOne: { sources: [sourcePolicy] },
      findResults: { articles: [[article, { ...article, _id: sessionId }]] },
      updateResults: { leases: [{ matchedCount: 1 }], indexingJobs: [{ upsertedCount: 1 }, { upsertedCount: 1 }, { upsertedCount: 1 }], sources: [{ matchedCount: 1 }] },
    })
    await expect(fixture.repository.materializeReconciliationPage({ sourceId, fence: leaseFence(), limit: 1, now })).resolves.toEqual({ inspected: 1, created: 3, hasMore: true })
    expect(fixture.collections.get('articles').find.mock.results[0].value.hint).toHaveBeenCalledWith('articles_source_reconciliation')
    await expect(fixture.repository.materializeReconciliationPage({ sourceId, fence: { ...leaseFence(), key: 'wrong' }, now })).rejects.toThrow(/input/i)
  })

  it('marks reconciliation failures only with a current source and lease', async () => {
    const fixture = createContext({ findOne: { sources: [{ ...sourcePolicy, reconciliation: { status: 'pending', requiredPolicyVersion: 3 } }] }, updateResults: { leases: [{ matchedCount: 1 }], sources: [{ matchedCount: 1 }] } })
    await expect(fixture.repository.markReconciliationFailure({ sourceId, fence: leaseFence(), now, error: { code: 'provider_error', retryable: true } })).resolves.toBe(true)
    const stale = createContext({ updateResults: { leases: [{ matchedCount: 0 }] } })
    await expect(stale.repository.markReconciliationFailure({ sourceId, fence: leaseFence(), now })).resolves.toBe(false)
    await expect(stale.repository.markReconciliationFailure({ sourceId, fence: { key: 'wrong' }, now })).resolves.toBe(false)
  })

  it('lists, selects, and purges indexing jobs with task and exclusion filters', async () => {
    const row = document()
    const cursor = Buffer.from(JSON.stringify({ createdAt: now.toISOString(), id: jobId.toHexString() })).toString('base64url')
    const fixture = createContext({ findResults: { indexingJobs: [[row, { ...row, _id: sessionId }]] } })
    await expect(fixture.repository.listIndexingJobs({ limit: 1, status: 'queued', task: 'summary', articleId: articleId.toHexString(), sourceId: sourceId.toHexString(), cursor })).resolves.toEqual(expect.objectContaining({ hasNext: true, nextCursor: expect.any(String) }))
    expect(fixture.collections.get('indexingJobs').find).toHaveBeenCalledWith(expect.objectContaining({ status: 'queued', task: 'summary', articleId, sourceId, $or: expect.any(Array) }))
    expect(fixture.collections.get('indexingJobs').find.mock.results[0].value.project).toHaveBeenCalledWith(INDEXING_JOB_LIST_PROJECTION)
    await expect(fixture.repository.listIndexingJobs({ task: 'unknown' })).rejects.toMatchObject({ status: 422 })
    await expect(fixture.repository.listIndexingJobs({ cursor: 'bad' })).rejects.toMatchObject({ status: 422 })

    const due = createContext({ findResults: { indexingJobs: [[], [row]] } })
    await expect(due.repository.selectDueIndexing({ now, tasks: ['summary', 'embedding'], excludeArticleIds: [articleId.toHexString()], jobIds: [jobId.toHexString()] })).resolves.toEqual(expect.objectContaining({ id: jobId.toHexString() }))
    expect(due.collections.get('indexingJobs').find).toHaveBeenCalledWith(expect.objectContaining({ _id: { $in: [jobId] } }), {})
    await expect(due.repository.nextAvailableAt()).resolves.toBeNull()
    const purge = createContext({ findResults: { indexingJobs: [[{ _id: jobId }]] }, deleteResults: { indexingJobs: [{ deletedCount: 1 }] } })
    await expect(purge.repository.purgeDueIndexingJobs({ cutoff: now, limit: 1 })).resolves.toEqual({ inspected: 1, affected: 1, hasMore: false })
  })

  it('claims, observes cancellation, completes and defers indexed work behind a lease', async () => {
    const running = document({ status: 'running', leaseGeneration: 2 })
    const fixture = createContext({
      updateResults: { leases: [{ matchedCount: 1 }, { matchedCount: 1 }, { matchedCount: 1 }, { matchedCount: 1 }, { matchedCount: 1 }], indexingJobs: [{ matchedCount: 1 }, { matchedCount: 1 }, { matchedCount: 1 }] },
      findOne: { indexingJobs: [running, running, running, running, running], sources: [sourcePolicy] },
    })
    await expect(fixture.repository.claimQueuedWithFence({ jobId, fence: leaseFence() })).resolves.toBe(true)
    await expect(fixture.repository.cancellationRequestedWithFence({ jobId, fence: leaseFence() })).resolves.toBe(false)
    await expect(fixture.repository.completeWithFence({ jobId, fence: leaseFence(), status: 'succeeded', inputHash: 'c'.repeat(64) })).resolves.toEqual(expect.objectContaining({ id: jobId.toHexString() }))
    await expect(fixture.repository.deferWithFence({ jobId, fence: leaseFence(), delayMs: 1_000 })).resolves.toEqual(expect.objectContaining({ id: jobId.toHexString() }))
    await expect(fixture.repository.deferWithFence({ jobId, fence: leaseFence(), delayMs: 99 })).rejects.toThrow(/delay/i)

    const cancelled = createContext({ updateResults: { leases: [{ matchedCount: 1 }] }, findOne: { indexingJobs: [document({ status: 'running', cancellationRequestedAt: now })] } })
    await expect(cancelled.repository.cancellationRequestedWithFence({ jobId, fence: leaseFence() })).resolves.toBe(true)
  })

  it('cancels queued jobs and rejects terminal jobs', async () => {
    const queued = document({ status: 'queued' })
    const fixture = createContext({ findOne: { users: [{}], sessions: [{}], indexingJobs: [queued, queued], adminAuditLogs: [null] }, updateResults: { indexingJobs: [{ matchedCount: 1 }] } })
    await expect(fixture.repository.cancelIndexingJob({ jobId, actor: { id: 'admin-1', role: 'admin' }, reasonCode: 'job_cancel_requested', request: { serverRequestId: 'req-1' }, actorFence: actorFence(), now })).resolves.toEqual(expect.objectContaining({ id: jobId.toHexString() }))
    const terminal = createContext({ findOne: { users: [{}], sessions: [{}], indexingJobs: [document({ status: 'succeeded' })] } })
    await expect(terminal.repository.cancelIndexingJob({ jobId, actor: { id: 'admin-1', role: 'admin' }, reasonCode: 'job_cancel_requested', request: { serverRequestId: 'req-1' }, actorFence: actorFence(), now })).rejects.toMatchObject({ status: 409 })
  })

  it('recovers expired indexing leases and resets in-flight artifacts', async () => {
    const parent = document({ status: 'running', attempt: 1, leaseGeneration: 2 })
    const snapshot = { _id: sourceId, key: `indexing:article:${articleId.toHexString()}`, activeOwner: { jobId, ownerTokenHash: 'b'.repeat(64), leaseGeneration: 2, expiresAt: new Date(now.getTime() - 1000) } }
    const fixture = createContext({ findOne: { indexingJobs: [parent], adminAuditLogs: [null] }, updateResults: { indexingJobs: [{ matchedCount: 1 }, { upsertedCount: 1 }], leases: [{ matchedCount: 1 }] }, findResults: {} })
    const leaseRepository = { listExpired: vi.fn(async () => [snapshot]) }
    await expect(fixture.repository.recoverExpiredIndexing({ leaseRepository, now, limit: 10 })).resolves.toEqual({ inspected: 1, recovered: 1, retriesCreated: 1, failed: 0 })
    expect(fixture.collections.get('articles').updateOne).toHaveBeenCalled()
  })
})
