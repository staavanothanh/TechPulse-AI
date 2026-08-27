import { ObjectId } from 'mongodb'
import { describe, expect, it, vi } from 'vitest'
import { MongoAdminRepository } from '../../../server/repositories/mongo/admin-repository.js'

const NOW = new Date('2026-08-20T08:00:00.000Z')
const ADMIN_ID = new ObjectId('507f1f77bcf86cd799439401')
const ARTICLE_ID = new ObjectId('507f1f77bcf86cd799439402')
const DUPLICATE_ID = new ObjectId('507f1f77bcf86cd799439403')
const SOURCE_ID = new ObjectId('507f1f77bcf86cd799439404')
const SESSION_ID = new ObjectId('507f1f77bcf86cd799439405')
const actorFence = { userId: ADMIN_ID, sessionId: SESSION_ID, sessionVersion: 3 }
const actor = { _id: ADMIN_ID, role: 'admin' }

function article(id = ARTICLE_ID, overrides = {}) {
  return {
    _id: id,
    sourceId: SOURCE_ID,
    titleOriginal: 'Article',
    originalUrl: 'https://example.test/article',
    status: 'published',
    topics: ['technology'],
    provenance: [],
    rightsSnapshot: { sourcePolicyVersion: 2 },
    leadMedia: { type: 'image' },
    leadMediaStatus: 'available',
    updatedAt: NOW,
    ...overrides,
  }
}

function source(overrides = {}) {
  return {
    _id: SOURCE_ID,
    policyVersion: 2,
    updatedAt: NOW,
    operationalStatus: 'active',
    licenseStatus: 'permitted',
    llmInputScope: 'metadata',
    ...overrides,
  }
}

function cursor(rows = []) {
  const result = {
    sort: vi.fn(() => result),
    project: vi.fn(() => result),
    limit: vi.fn(() => result),
    toArray: vi.fn(async () => rows),
  }
  return result
}

function fixture({
  articleRows = [],
  sourceRows = [],
  userResult = { matchedCount: 1 },
  sessionResult = { matchedCount: 1 },
  sourceUpdateResult = { matchedCount: 1 },
  articleUpdateResult = { matchedCount: 1 },
  duplicateUpdateResult = { matchedCount: 1 },
  admission = { allowed: true },
  auditExisting = null,
} = {}) {
  const collections = {
    articles: {
      findOne: vi.fn(async () => (articleRows.length ? articleRows.shift() : null)),
      find: vi.fn(() => cursor([])),
      aggregate: vi.fn(() => ({ next: vi.fn(async () => null) })),
      updateOne: vi.fn(async () => articleUpdateResult),
      updateMany: vi.fn(async () => duplicateUpdateResult),
    },
    sources: {
      findOne: vi.fn(async () => (sourceRows.length ? sourceRows.shift() : source())),
      aggregate: vi.fn(() => ({ toArray: vi.fn(async () => []) })),
      updateOne: vi.fn(async () => sourceUpdateResult),
    },
    users: { updateOne: vi.fn(async () => userResult) },
    sessions: { updateOne: vi.fn(async () => sessionResult) },
    indexingJobs: {
      aggregate: vi.fn(() => ({ next: vi.fn(async () => null) })),
      updateOne: vi.fn(async () => ({ matchedCount: 1 })),
    },
    adminAuditLogs: {
      findOne: vi.fn(async () => auditExisting),
      insertOne: vi.fn(async () => ({ acknowledged: true })),
      find: vi.fn(() => cursor([])),
      updateMany: vi.fn(async () => ({ modifiedCount: 1 })),
    },
  }
  collections.ingestionJobs = { aggregate: vi.fn(() => ({ toArray: vi.fn(async () => []) })) }
  const db = {
    collection: vi.fn(
      (name) =>
        collections[name] ?? {
          aggregate: vi.fn(() => ({ next: vi.fn(async () => null) })),
          updateOne: vi.fn(async () => ({ matchedCount: 1 })),
        },
    ),
  }
  const tx = {
    withTransaction: vi.fn(async (work) => work(tx)),
    endSession: vi.fn(async () => undefined),
  }
  const client = { startSession: vi.fn(() => tx) }
  const repository = new MongoAdminRepository({ db, client, now: () => NOW })
  const rateLimitAdmission = { reserve: vi.fn(async () => admission) }
  return { repository, collections, tx, rateLimitAdmission }
}

function updateInput(overrides = {}) {
  return {
    category: 'topics',
    value: ['ai'],
    actorFence,
    actor,
    request: { requestId: 'request-1' },
    rateLimitAdmission: { reserve: vi.fn(async () => ({ allowed: true })) },
    reasonCode: 'article_topics_changed',
    ...overrides,
  }
}

describe('MongoAdminRepository branch coverage', () => {
  it('rejects invalid context, identifiers, cursors and audit envelopes', async () => {
    expect(() => new MongoAdminRepository()).toThrow('Mongo context')
    const repository = new MongoAdminRepository({ db: { collection: vi.fn() } })
    await expect(repository.withTransaction(async () => true)).rejects.toThrow(
      'transaction capability',
    )
    await expect(fixture().repository.findAdminArticle('bad')).rejects.toMatchObject({
      code: 'bad_request',
      status: 400,
    })

    const audit = fixture().repository
    await expect(
      audit.insertAdminAudit({
        actor,
        targetId: ARTICLE_ID,
        reasonCode: 'article_status_changed',
        changedFields: ['topics'],
        request: { requestId: 'r' },
        now: NOW,
      }),
    ).rejects.toThrow('allowlisted')
    await expect(
      audit.insertAdminAudit({
        actor: {},
        targetId: ARTICLE_ID,
        reasonCode: 'article_status_changed',
        changedFields: ['status'],
        request: {},
        now: NOW,
      }),
    ).rejects.toThrow('identity')
    const logs = fixture().repository
    await expect(logs.listAuditLogs({ cursor: 'bad' })).rejects.toMatchObject({
      code: 'validation_error',
      status: 422,
    })
    await expect(logs.listAdminArticles({ sourceId: 'bad' })).rejects.toMatchObject({
      code: 'bad_request',
      status: 400,
    })
  })

  it('covers article update transition and authentication gates', async () => {
    const repository = fixture({ articleRows: [article()] }).repository
    await expect(
      repository.updateAdminArticle(
        ARTICLE_ID,
        updateInput({ category: 'leadMediaStatus', value: 'available' }),
      ),
    ).rejects.toMatchObject({ code: 'conflict', status: 409 })

    const invalidStatus = fixture({ articleRows: [article()] }).repository
    await expect(
      invalidStatus.updateAdminArticle(
        ARTICLE_ID,
        updateInput({ category: 'status', value: 'invalid' }),
      ),
    ).rejects.toMatchObject({ code: 'conflict', status: 409 })

    const removed = fixture({
      articleRows: [article(ARTICLE_ID, { status: 'removed' })],
    }).repository
    await expect(
      removed.updateAdminArticle(
        ARTICLE_ID,
        updateInput({ category: 'status', value: 'published' }),
      ),
    ).rejects.toMatchObject({ code: 'conflict', status: 409 })

    const unauthenticated = fixture({ articleRows: [article()] }).repository
    await expect(
      unauthenticated.updateAdminArticle(ARTICLE_ID, updateInput({ actorFence: null })),
    ).rejects.toMatchObject({ code: 'unauthorized', status: 401 })

    const userFence = fixture({
      articleRows: [article()],
      userResult: { matchedCount: 0 },
    }).repository
    await expect(userFence.updateAdminArticle(ARTICLE_ID, updateInput())).rejects.toMatchObject({
      code: 'unauthorized',
      status: 401,
    })
    const sessionFence = fixture({
      articleRows: [article()],
      sessionResult: { matchedCount: 0 },
    }).repository
    await expect(sessionFence.updateAdminArticle(ARTICLE_ID, updateInput())).rejects.toMatchObject({
      code: 'unauthorized',
      status: 401,
    })
    const noAdmission = fixture({ articleRows: [article()] }).repository
    await expect(
      noAdmission.updateAdminArticle(ARTICLE_ID, updateInput({ rateLimitAdmission: null })),
    ).rejects.toMatchObject({ code: 'service_unavailable', status: 503 })
    const admissionError = fixture({ articleRows: [article()] }).repository
    await expect(
      admissionError.updateAdminArticle(
        ARTICLE_ID,
        updateInput({
          rateLimitAdmission: {
            reserve: vi.fn(async () => {
              throw new Error('down')
            }),
          },
        }),
      ),
    ).rejects.toMatchObject({ code: 'service_unavailable', status: 503 })
    const denied = fixture({ articleRows: [article()] }).repository
    await expect(
      denied.updateAdminArticle(
        ARTICLE_ID,
        updateInput({
          rateLimitAdmission: {
            reserve: vi.fn(async () => ({ allowed: false, retryAfterSeconds: 6 })),
          },
        }),
      ),
    ).rejects.toMatchObject({ code: 'rate_limit_exceeded', status: 429, retryAfter: 6 })
  })

  it('rejects optimistic article and source races and replays existing audits during update', async () => {
    const changed = fixture({
      articleRows: [article(), article(ARTICLE_ID, { updatedAt: new Date(NOW.getTime() + 1) })],
    }).repository
    await expect(changed.updateAdminArticle(ARTICLE_ID, updateInput())).rejects.toMatchObject({
      code: 'conflict',
      status: 409,
    })

    const noSource = fixture({ articleRows: [article(), article()], sourceRows: [null] }).repository
    await expect(noSource.updateAdminArticle(ARTICLE_ID, updateInput())).rejects.toMatchObject({
      code: 'conflict',
      status: 409,
    })
    const sourceRace = fixture({
      articleRows: [article(), article()],
      sourceUpdateResult: { matchedCount: 0 },
    }).repository
    await expect(sourceRace.updateAdminArticle(ARTICLE_ID, updateInput())).rejects.toMatchObject({
      code: 'conflict',
      status: 409,
    })
    const articleRace = fixture({
      articleRows: [article(), article()],
      articleUpdateResult: { matchedCount: 0 },
    }).repository
    await expect(articleRace.updateAdminArticle(ARTICLE_ID, updateInput())).rejects.toMatchObject({
      code: 'conflict',
      status: 409,
    })
    const auditRace = fixture({
      articleRows: [article(), article(), article()],
      auditExisting: { eventId: 'existing-audit' },
    })
    await expect(
      auditRace.repository.updateAdminArticle(ARTICLE_ID, updateInput()),
    ).rejects.toThrow('audit identity collision')
    expect(auditRace.collections.adminAuditLogs.insertOne).not.toHaveBeenCalled()
  })

  it('covers duplicate merge preconditions, replay and guarded writes', async () => {
    const base = {
      canonicalArticleId: ARTICLE_ID,
      duplicateArticleIds: [DUPLICATE_ID],
      actorFence,
      actor,
      request: { requestId: 'merge' },
      idempotencyKey: 'merge-key',
      rateLimitAdmission: { reserve: vi.fn(async () => ({ allowed: true })) },
      reasonCode: 'duplicate_merge_confirmed',
    }
    await expect(
      fixture().repository.mergeDuplicateArticles({ ...base, actorFence: null }),
    ).rejects.toMatchObject({ code: 'unauthorized', status: 401 })
    await expect(
      fixture().repository.mergeDuplicateArticles({ ...base, rateLimitAdmission: null }),
    ).rejects.toMatchObject({ code: 'service_unavailable', status: 503 })
    await expect(
      fixture().repository.mergeDuplicateArticles({
        ...base,
        rateLimitAdmission: {
          reserve: vi.fn(async () => {
            throw new Error('down')
          }),
        },
      }),
    ).rejects.toMatchObject({ code: 'service_unavailable', status: 503 })
    await expect(
      fixture({
        admission: { allowed: false, retryAfterSeconds: 3 },
      }).repository.mergeDuplicateArticles({
        ...base,
        rateLimitAdmission: {
          reserve: vi.fn(async () => ({ allowed: false, retryAfterSeconds: 3 })),
        },
      }),
    ).rejects.toMatchObject({ code: 'rate_limit_exceeded', status: 429 })

    const replay = fixture({ auditExisting: { targetId: ARTICLE_ID, eventId: expect.any(String) } })
    replay.collections.adminAuditLogs.findOne.mockResolvedValue({ targetId: ARTICLE_ID })
    await expect(replay.repository.mergeDuplicateArticles({ ...base })).rejects.toMatchObject({
      code: 'idempotency_mismatch',
      status: 409,
    })

    const missingCanonical = fixture({ articleRows: [null] })
    await expect(
      missingCanonical.repository.mergeDuplicateArticles({ ...base, idempotencyKey: undefined }),
    ).resolves.toBeNull()
    const wrongDuplicates = fixture({ articleRows: [article()] })
    wrongDuplicates.collections.articles.find.mockReturnValue(cursor([]))
    await expect(
      wrongDuplicates.repository.mergeDuplicateArticles({ ...base, idempotencyKey: undefined }),
    ).rejects.toMatchObject({ code: 'conflict', status: 409 })

    const noSource = fixture({
      articleRows: [article(), article(), article(DUPLICATE_ID)],
      sourceRows: [null],
    })
    await expect(
      noSource.repository.mergeDuplicateArticles({ ...base, idempotencyKey: undefined }),
    ).rejects.toMatchObject({ code: 'conflict', status: 409 })
  })

  it('handles audit purge empty batches and safe numeric limits', async () => {
    const empty = fixture()
    empty.collections.adminAuditLogs.find.mockReturnValue(cursor([]))
    await expect(empty.repository.purgeAuditIpHmac({ cutoff: NOW, limit: 0 })).resolves.toEqual({
      inspected: 0,
      affected: 0,
      hasMore: false,
    })
    const rows = fixture()
    rows.collections.adminAuditLogs.find.mockReturnValue(
      cursor([{ _id: ARTICLE_ID }, { _id: DUPLICATE_ID }]),
    )
    rows.collections.adminAuditLogs.updateMany.mockResolvedValue({ modifiedCount: 0 })
    await expect(rows.repository.purgeAuditIpHmac({ cutoff: NOW, limit: 1_000 })).resolves.toEqual({
      inspected: 2,
      affected: 0,
      hasMore: false,
    })
  })
  it('covers optional defaults and successful hidden status transitions', async () => {
    const overview = fixture()
    await expect(overview.repository.getOverview()).resolves.toMatchObject({
      activeSources: 0,
      queuedJobs: 0,
      lastSuccessfulIngestionAt: null,
    })
    const emptyLists = fixture()
    await expect(emptyLists.repository.listAdminArticles({})).resolves.toMatchObject({
      articles: [],
      hasNext: false,
      nextCursor: null,
    })
    await expect(emptyLists.repository.listAuditLogs({})).resolves.toMatchObject({
      logs: [],
      hasNext: false,
      nextCursor: null,
    })
    await expect(
      emptyLists.repository.insertAdminAudit({
        actor,
        targetId: ARTICLE_ID,
        reasonCode: 'article_status_changed',
        changedFields: ['status'],
        request: { requestId: 'r' },
        now: 'bad-date',
      }),
    ).rejects.toMatchObject({ code: 'validation_error', status: 422 })
    await expect(
      emptyLists.repository.findAdminArticle({ toHexString: () => ARTICLE_ID.toHexString() }),
    ).resolves.toBeNull()

    const hidden = fixture({
      articleRows: [
        article(ARTICLE_ID, { leadMedia: null }),
        article(ARTICLE_ID, { leadMedia: null }),
      ],
      sourceRows: [{ ...source(), updatedAt: undefined }],
    })
    await expect(
      hidden.repository.updateAdminArticle(
        ARTICLE_ID,
        updateInput({
          category: 'status',
          value: 'hidden',
          reasonCode: 'article_status_changed',
          request: { serverRequestId: 'server-request' },
        }),
      ),
    ).resolves.toBeNull()

    const invalidPolicy = fixture({
      articleRows: [article(), article()],
      sourceRows: [source({ policyVersion: 0 })],
    })
    await expect(
      invalidPolicy.repository.updateAdminArticle(ARTICLE_ID, updateInput()),
    ).rejects.toMatchObject({ code: 'conflict', status: 409 })
  })

  it('covers merge actor, source and optimistic-write races', async () => {
    const base = {
      canonicalArticleId: ARTICLE_ID,
      duplicateArticleIds: [DUPLICATE_ID],
      actorFence,
      actor,
      request: {},
      rateLimitAdmission: { reserve: vi.fn(async () => ({ allowed: true })) },
      reasonCode: 'duplicate_merge_confirmed',
    }
    await expect(
      fixture({ userResult: { matchedCount: 0 } }).repository.mergeDuplicateArticles(base),
    ).rejects.toMatchObject({ code: 'unauthorized', status: 401 })
    await expect(
      fixture({ sessionResult: { matchedCount: 0 } }).repository.mergeDuplicateArticles(base),
    ).rejects.toMatchObject({ code: 'unauthorized', status: 401 })

    const missingSource = fixture({
      articleRows: [article(), article(DUPLICATE_ID)],
      sourceRows: [null],
    })
    missingSource.collections.articles.find.mockReturnValue(cursor([article(DUPLICATE_ID)]))
    await expect(missingSource.repository.mergeDuplicateArticles(base)).rejects.toMatchObject({
      code: 'conflict',
      status: 409,
    })

    const canonicalRace = fixture({
      articleRows: [article()],
      sourceRows: [source()],
      articleUpdateResult: { matchedCount: 0 },
    })
    canonicalRace.collections.articles.find.mockReturnValue(cursor([article(DUPLICATE_ID)]))
    await expect(canonicalRace.repository.mergeDuplicateArticles(base)).rejects.toMatchObject({
      code: 'conflict',
      status: 409,
    })

    const duplicateRace = fixture({
      articleRows: [article()],
      sourceRows: [source()],
      duplicateUpdateResult: { matchedCount: 0 },
    })
    duplicateRace.collections.articles.find.mockReturnValue(cursor([article(DUPLICATE_ID)]))
    await expect(duplicateRace.repository.mergeDuplicateArticles(base)).rejects.toMatchObject({
      code: 'conflict',
      status: 409,
    })
  })
})
