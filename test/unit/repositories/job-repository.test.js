import { ObjectId } from 'mongodb'
import { describe, expect, it, vi } from 'vitest'
import {
  INGESTION_JOB_LIST_PROJECTION,
  MongoJobRepository,
  serializeIngestionJob,
} from '../../../server/repositories/mongo/job-repository.js'

const sourceId = new ObjectId('507f1f77bcf86cd799439011')
const jobId = new ObjectId('507f1f77bcf86cd799439012')
const sessionId = new ObjectId('507f1f77bcf86cd799439013')
const now = new Date('2026-08-20T08:00:00.000Z')
const counters = { fetched: 1, created: 2, updated: 3, duplicate: 4, skipped: 5, failed: 0 }

function baseJob(overrides = {}) {
  return {
    id: jobId.toHexString(),
    idempotencyKey: 'manual:job-1',
    actorScope: 'admin:admin-1',
    requestHash: 'a'.repeat(64),
    sourceId: sourceId.toHexString(),
    connectorType: 'rss',
    expectedSourcePolicyVersion: 3,
    trigger: 'manual',
    status: 'queued',
    attempt: 1,
    priority: 50,
    availableAt: now,
    agingEligibleAt: new Date(now.getTime() + 1_800_000),
    idempotencyExpiresAt: new Date(now.getTime() + 14 * 86_400_000),
    leaseGeneration: 0,
    batchSize: 20,
    counters,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  }
}

function serializedDocument(overrides = {}) {
  const job = baseJob(overrides)
  return {
    _id: jobId,
    idempotencyKey: job.idempotencyKey,
    actorScope: job.actorScope,
    requestHash: job.requestHash,
    sourceId,
    connectorType: job.connectorType,
    expectedSourcePolicyVersion: job.expectedSourcePolicyVersion,
    trigger: job.trigger,
    status: job.status,
    attempt: job.attempt,
    priority: job.priority,
    availableAt: job.availableAt,
    agingEligibleAt: job.agingEligibleAt,
    idempotencyExpiresAt: job.idempotencyExpiresAt,
    leaseGeneration: job.leaseGeneration,
    batchSize: job.batchSize,
    counters: { ...counters },
    createdAt: now,
    updatedAt: now,
    ...overrides,
  }
}

function createCursor(values = []) {
  const remaining = [...values]
  const cursor = {
    sort: vi.fn(() => cursor),
    hint: vi.fn(() => cursor),
    project: vi.fn(() => cursor),
    skip: vi.fn(() => cursor),
    limit: vi.fn(() => cursor),
    toArray: vi.fn(async () => remaining),
    next: vi.fn(async () => remaining.shift() ?? null),
  }
  return cursor
}

function createContext({
  findOne = {},
  findResults = {},
  updateResults = {},
  findOneAndUpdateResults = {},
  insertResults = {},
  deleteResults = {},
  nowValue = now,
  sourceRows = [],
} = {}) {
  const collections = new Map()
  const queues = (input, name) => {
    const values = input[name]
    if (Array.isArray(values) && values.length > 0) return values
    return []
  }
  const collection = (name) => {
    if (collections.has(name)) return collections.get(name)
    const handle = {
      findOne: vi.fn(async (...args) => queues(findOne, name).shift() ?? null),
      findOneAndUpdate: vi.fn(async (...args) => queues(findOneAndUpdateResults, name).shift() ?? null),
      updateOne: vi.fn(async (...args) => queues(updateResults, name).shift() ?? { matchedCount: 1, upsertedCount: 0 }),
      insertOne: vi.fn(async (...args) => queues(insertResults, name).shift() ?? { insertedId: args[0]?._id }),
      deleteMany: vi.fn(async (...args) => queues(deleteResults, name).shift() ?? { deletedCount: 1 }),
      find: vi.fn((...args) => {
        const values = queues(findResults, name).shift()
        return createCursor(values ?? (name === 'sources' ? sourceRows : []))
      }),
    }
    collections.set(name, handle)
    return handle
  }
  const session = {
    withTransaction: vi.fn(async (work) => work(session)),
    endSession: vi.fn(async () => {}),
  }
  const context = {
    db: { collection },
    client: { startSession: vi.fn(() => session) },
    now: () => nowValue,
  }
  return { repository: new MongoJobRepository(context), context, collections, session }
}

function fence() {
  return { key: 'ingestion:source:source-1', ownerTokenHash: 'b'.repeat(64), leaseGeneration: 2 }
}

function actorFence() {
  return { userId: sourceId, sessionId, sessionVersion: 4 }
}

function audit(action = 'ingestion_job_created') {
  return {
    eventId: 'job-audit-1',
    actorType: 'admin',
    actorId: sourceId,
    action,
    targetType: 'ingestion-job',
    targetId: jobId,
    changedFields: action === 'ingestion_job_created' ? ['status'] : ['cancellationRequestedAt'],
    reasonCode: action === 'ingestion_job_created' ? 'ingestion_trigger_requested' : 'job_cancel_requested',
    requestId: 'request-1',
    result: 'succeeded',
    createdAt: now,
  }
}

describe('MongoJobRepository', () => {
  it('serializes absent and fully populated ingestion jobs safely', () => {
    expect(serializeIngestionJob(null)).toBeNull()
    const document = serializedDocument({
      requestedBy: sessionId,
      parentJobId: sourceId,
      checkpoint: { cursor: 'x' },
      cancellationRequestedAt: now,
      error: { code: 'provider_error', message: 'failed', retryable: true },
      startedAt: now,
      heartbeatAt: now,
      finishedAt: now,
      purgeAfter: now,
    })
    expect(serializeIngestionJob(document)).toEqual(expect.objectContaining({
      id: jobId.toHexString(),
      sourceId: sourceId.toHexString(),
      requestedBy: sessionId.toHexString(),
      parentJobId: sourceId.toHexString(),
      checkpoint: { cursor: 'x' },
      error: { code: 'provider_error', message: 'failed', retryable: true },
    }))
  })

  it('requires context, exposes collections, and closes transactions', async () => {
    expect(() => new MongoJobRepository()).toThrow(/context/i)
    const { repository, session } = createContext()
    expect(repository.jobs()).toBe(repository.db.collection('ingestionJobs'))
    const value = await repository.withTransaction(async (transactionSession) => {
      expect(transactionSession).toBe(session)
      return 'done'
    })
    expect(value).toBe('done')
    expect(session.withTransaction).toHaveBeenCalledWith(expect.any(Function), { readConcern: { level: 'snapshot' }, writeConcern: { w: 'majority' } })
    expect(session.endSession).toHaveBeenCalled()
  })

  it('validates actor fences against an active admin user and session', async () => {
    const valid = createContext({ findOne: { users: [{}], sessions: [{}] } })
    await expect(valid.repository.assertActorFence(actorFence(), valid.session)).resolves.toBe(true)
    expect(valid.collections.get('users').findOne).toHaveBeenCalledWith(expect.objectContaining({ role: 'admin', status: 'active' }), expect.any(Object))

    const inactive = createContext({ findOne: { users: [null] } })
    await expect(inactive.repository.assertActorFence(actorFence(), inactive.session)).resolves.toBe(false)
    await expect(inactive.repository.assertActorFence({ userId: sourceId, sessionId, sessionVersion: 0 }, inactive.session)).resolves.toBe(false)
  })

  it('inserts idempotent audits and rejects identity collisions', async () => {
    const created = createContext({ findOne: { adminAuditLogs: [null] } })
    await expect(created.repository.insertAudit(audit(), created.session)).resolves.toEqual(expect.objectContaining({ eventId: 'job-audit-1' }))
    expect(created.collections.get('adminAuditLogs').insertOne).toHaveBeenCalled()

    const existing = createContext({ findOne: { adminAuditLogs: [audit()] } })
    await expect(existing.repository.insertAudit(audit(), existing.session)).resolves.toEqual(expect.objectContaining({ eventId: 'job-audit-1' }))

    const collision = createContext({ findOne: { adminAuditLogs: [{ ...audit(), requestId: 'different' }] } })
    await expect(collision.repository.insertAudit(audit(), collision.session)).rejects.toMatchObject({ status: 409, code: 'idempotency_mismatch' })
  })

  it('creates or reuses admitted jobs under the actor fence', async () => {
    const fixture = createContext({
      findOne: { users: [{}], sessions: [{}], ingestionJobs: [null], adminAuditLogs: [null] },
    })
    const reserve = vi.fn(async () => ({ allowed: true }))
    const job = baseJob()
    await expect(fixture.repository.createOrReuseIngestionJobWithAdmission({ job, audit: audit(), actorFence: actorFence(), rateLimitAdmission: { reserve }, admission: { scope: 'manual' } })).resolves.toBe(job)
    expect(reserve).toHaveBeenCalledWith(expect.objectContaining({ scope: 'manual', session: fixture.session }))
    expect(fixture.collections.get('ingestionJobs').insertOne).toHaveBeenCalledWith(expect.objectContaining({ _id: jobId, sourceId }), { session: fixture.session })

    const reused = createContext({ findOne: { users: [{}], sessions: [{}], ingestionJobs: [serializedDocument({ status: 'succeeded' })] } })
    await expect(reused.repository.createOrReuseIngestionJobWithAdmission({ job, actorFence: actorFence(), rateLimitAdmission: { reserve } })).resolves.toEqual(expect.objectContaining({ status: 'succeeded' }))
  })

  it('maps admission failures to typed job errors and validates linked retry identity', async () => {
    const fixture = createContext({ findOne: { users: [{}], sessions: [{}], ingestionJobs: [null] } })
    await expect(fixture.repository.reserveAdmission({ rateLimitAdmission: null, admission: {}, session: fixture.session })).rejects.toMatchObject({ status: 503 })
    await expect(fixture.repository.reserveAdmission({ rateLimitAdmission: { reserve: vi.fn(async () => ({ allowed: false, retryAfterSeconds: 9 })) }, admission: {}, session: fixture.session })).rejects.toMatchObject({ status: 429, retryAfter: 9 })
    await expect(fixture.repository.reserveAdmission({ rateLimitAdmission: { reserve: vi.fn(async () => ({ allowed: 'yes' })) }, admission: {}, session: fixture.session })).rejects.toMatchObject({ status: 503 })
    await expect(fixture.repository.createOrReuseIngestionJobWithAdmission({ job: baseJob(), parentJobId: sourceId })).rejects.toThrow(/linked retry/i)
  })

  it('materializes bounded daily ingestion batches and completes progress', async () => {
    const source = { _id: sourceId, connectorType: 'rss', policyVersion: 4, connectorConfig: { batchSize: 12 } }
    const fixture = createContext({
      findOne: { ingestionScheduleProgress: [null] },
      findResults: { sources: [[source, { ...source, _id: sessionId }]] },
      updateResults: { ingestionJobs: [{ upsertedCount: 1 }], ingestionScheduleProgress: [{ matchedCount: 1 }] },
    })
    const result = await fixture.repository.materializeDailyIngestion({ now, limit: 1 })
    expect(result).toEqual({ inspected: 1, created: 1, hasMore: true, period: '2026-08-20' })
    expect(fixture.collections.get('ingestionJobs').updateOne).toHaveBeenCalledWith(expect.objectContaining({ idempotencyKey: `daily:2026-08-20:${sourceId.toHexString()}` }), expect.any(Object), expect.objectContaining({ upsert: true, session: fixture.session }))

    const completed = createContext({ findOne: { ingestionScheduleProgress: [{ _id: sourceId, completedAt: now }] } })
    await expect(completed.repository.materializeDailyIngestion({ now, limit: 10 })).resolves.toEqual({ inspected: 0, created: 0, hasMore: false, period: '2026-08-20' })
    await expect(completed.repository.materializeDailyIngestion({ now, limit: 0 })).rejects.toThrow(/limit/i)
    await expect(completed.repository.materializeDailyIngestion({ now: 'bad' })).rejects.toThrow(/materialization time/i)
  })

  it('lists jobs with filters, cursors, projections, due ordering, and retention purge', async () => {
    const document = serializedDocument()
    const cursor = Buffer.from(JSON.stringify({ createdAt: now.toISOString(), id: jobId.toHexString() })).toString('base64url')
    const fixture = createContext({ findResults: { ingestionJobs: [[document, { ...document, _id: sessionId }]] } })
    const listed = await fixture.repository.listIngestionJobs({ limit: 1, status: 'queued', sourceId: sourceId.toHexString(), cursor })
    expect(listed).toEqual(expect.objectContaining({ hasNext: true, nextCursor: expect.any(String) }))
    expect(fixture.collections.get('ingestionJobs').find).toHaveBeenCalledWith(expect.objectContaining({ status: 'queued', sourceId, $or: expect.any(Array) }))
    expect(fixture.collections.get('ingestionJobs').find).toHaveBeenCalled()
    expect(fixture.collections.get('ingestionJobs').find.mock.results[0].value.project).toHaveBeenCalledWith(INGESTION_JOB_LIST_PROJECTION)
    await expect(fixture.repository.listIngestionJobs({ limit: 0 })).rejects.toMatchObject({ status: 400 })
    await expect(fixture.repository.listIngestionJobs({ status: 'bad' })).rejects.toMatchObject({ status: 400 })
    await expect(fixture.repository.listIngestionJobs({ cursor: 'bad' })).rejects.toMatchObject({ status: 400 })

    const aged = createContext({ findResults: { ingestionJobs: [[document]] } })
    await expect(aged.repository.selectDueIngestion({ now })).resolves.toEqual(expect.objectContaining({ id: jobId.toHexString() }))
    expect(aged.collections.get('ingestionJobs').find).toHaveBeenCalledTimes(1)
    expect(aged.collections.get('ingestionJobs').find.mock.results[0].value.hint).toHaveBeenCalledWith('ingestion_due_aged')

    const normal = createContext({ findResults: { ingestionJobs: [[], [document]] } })
    await expect(normal.repository.selectDueIngestion({ now })).resolves.toEqual(expect.objectContaining({ id: jobId.toHexString() }))
    await expect(normal.repository.nextAvailableAt()).resolves.toBeNull()

    const purge = createContext({ findResults: { ingestionJobs: [[{ _id: jobId }, { _id: sourceId }]] }, deleteResults: { ingestionJobs: [{ deletedCount: 1 }] } })
    await expect(purge.repository.purgeDueIngestionJobs({ cutoff: now, limit: 1 })).resolves.toEqual({ inspected: 1, affected: 1, hasMore: true })
    const empty = createContext({ findResults: { ingestionJobs: [[]] } })
    await expect(empty.repository.purgeDueIngestionJobs({ cutoff: now, limit: 1 })).resolves.toEqual({ inspected: 0, affected: 0, hasMore: false })
    await expect(empty.repository.purgeDueIngestionJobs({ cutoff: 'bad' })).rejects.toThrow(/cutoff/i)
  })

  it('claims queued jobs and completes them only with a valid lease fence', async () => {
    const running = serializedDocument({ status: 'running', leaseGeneration: 2 })
    const fixture = createContext({
      updateResults: { jobLeases: [{ matchedCount: 1 }, { matchedCount: 1 }], ingestionJobs: [{ matchedCount: 1 }] },
      findOne: { ingestionJobs: [running, running] },
      findResults: { sources: [[{ _id: sourceId }]] },
    })
    await expect(fixture.repository.claimQueuedWithFence({ jobId, fence: fence() })).resolves.toBe(true)
    await expect(fixture.repository.completeWithFence({ jobId, fence: fence(), status: 'succeeded', checkpoint: { cursor: 'next' }, counters })).resolves.toEqual(expect.objectContaining({ id: jobId.toHexString() }))
    expect(fixture.collections.get('ingestionJobs').updateOne).toHaveBeenCalled()

    const stale = createContext({ updateResults: { jobLeases: [{ matchedCount: 0 }] } })
    await expect(stale.repository.claimQueuedWithFence({ jobId, fence: fence() })).resolves.toBe(false)
    await expect(stale.repository.completeWithFence({ jobId, fence: fence(), status: 'queued' })).rejects.toThrow(/terminal/i)
    await expect(stale.repository.completeWithFence({ jobId, fence: fence(), status: 'failed' })).rejects.toMatchObject({ status: 409 })
  })

  it('defers running jobs, cancels requested work, and rejects terminal cancellation', async () => {
    const running = serializedDocument({ status: 'running', leaseGeneration: 2 })
    const fixture = createContext({
      updateResults: { jobLeases: [{ matchedCount: 1 }, { matchedCount: 1 }, { matchedCount: 1 }, { matchedCount: 1 }], ingestionJobs: [{ matchedCount: 1 }, { matchedCount: 1 }] },
      findOne: { ingestionJobs: [running, running, running, running] },
    })
    await expect(fixture.repository.deferWithFence({ jobId, fence: fence(), delayMs: 1000 })).resolves.toEqual(expect.objectContaining({ id: jobId.toHexString() }))
    await expect(fixture.repository.deferWithFence({ jobId, fence: fence(), delayMs: 1000 })).resolves.toEqual(expect.objectContaining({ id: jobId.toHexString() }))
    await expect(fixture.repository.deferWithFence({ jobId, fence: fence(), delayMs: 99 })).rejects.toThrow(/defer duration/i)

    const cancelled = serializedDocument({ status: 'running', leaseGeneration: 2, cancellationRequestedAt: now })
    const cancelFixture = createContext({
      findOne: { users: [{}], sessions: [{}], ingestionJobs: [cancelled, cancelled], adminAuditLogs: [null] },
      updateResults: { ingestionJobs: [{ matchedCount: 1 }] },
    })
    await expect(cancelFixture.repository.cancelIngestionJob({ jobId, actor: { id: 'admin-1', role: 'admin' }, reasonCode: 'job_cancel_requested', request: { serverRequestId: 'req-1' }, actorFence: actorFence(), now })).resolves.toEqual(expect.objectContaining({ id: jobId.toHexString() }))

    const terminal = createContext({ findOne: { users: [{}], sessions: [{}], ingestionJobs: [serializedDocument({ status: 'succeeded' })] } })
    await expect(terminal.repository.cancelIngestionJob({ jobId, actor: { id: 'admin-1', role: 'admin' }, reasonCode: 'job_cancel_requested', request: { serverRequestId: 'req-1' }, actorFence: actorFence(), now })).rejects.toMatchObject({ status: 409 })
  })

  it('recovers expired leases into failed parents and bounded retry children', async () => {
    const parent = serializedDocument({ status: 'running', attempt: 1, leaseGeneration: 2 })
    const snapshots = [
      { _id: sourceId, key: 'ingestion:source:source-1', activeOwner: { jobId, ownerTokenHash: 'b'.repeat(64), leaseGeneration: 2, expiresAt: new Date(now.getTime() - 1000) } },
      { _id: sessionId, key: 'ingestion:source:source-2', activeOwner: { jobId: sourceId, ownerTokenHash: 'c'.repeat(64), leaseGeneration: 1, expiresAt: new Date(now.getTime() - 1000) } },
    ]
    const fixture = createContext({
      findOne: { ingestionJobs: [parent, null], adminAuditLogs: [null] },
      updateResults: { ingestionJobs: [{ matchedCount: 1 }, { upsertedCount: 1 }], jobLeases: [{ matchedCount: 1 }, { matchedCount: 1 }] },
    })
    const leaseRepository = { listExpired: vi.fn(async () => snapshots) }
    await expect(fixture.repository.recoverExpiredIngestion({ leaseRepository, now, limit: 10 })).resolves.toEqual({ inspected: 2, recovered: 2, retriesCreated: 1, failed: 0 })
    expect(fixture.collections.get('ingestionJobs').updateOne).toHaveBeenCalledWith(expect.objectContaining({ parentJobId: jobId, attempt: 2 }), expect.objectContaining({ $setOnInsert: expect.any(Object) }), expect.objectContaining({ upsert: true }))
  })
})
