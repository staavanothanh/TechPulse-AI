import { ObjectId } from 'mongodb'
import { describe, expect, it, vi } from 'vitest'
import {
  historicalCitation,
  historicalCitationDocument,
  MongoChatRepository,
  publicAnswerCitation,
  publicMessage,
  redactHistoricalCitation,
  serializeChatSession,
} from '../../../server/repositories/mongo/chat-repository.js'

const NOW = new Date('2026-08-12T00:00:00.000Z')
const USER_ID = new ObjectId('507f1f77bcf86cd799439201')
const LOGIN_SESSION_ID = new ObjectId('507f1f77bcf86cd799439202')
const CHAT_SESSION_ID = new ObjectId('507f1f77bcf86cd799439203')
const ARTICLE_ID = new ObjectId('507f1f77bcf86cd799439204')
const SOURCE_ID = new ObjectId('507f1f77bcf86cd799439205')
const ACTOR = { userId: USER_ID, actorFence: { sessionId: LOGIN_SESSION_ID, sessionVersion: 1 } }

const SOURCE = {
  _id: SOURCE_ID,
  name: 'Nguon editorial',
  sourceKey: 'rss:example',
  authorityTier: 'editorial',
  operationalStatus: 'active',
  licenseStatus: 'permitted',
  policyVersion: 3,
  llmInputScope: 'excerpt',
  storageScope: { metadata: true, excerpt: true, summary: true, embedding: true },
  mediaPolicy: {
    imageMode: 'none',
    videoMode: 'none',
    allowedHosts: [],
    attributionRequired: false,
    evidenceNote: null,
  },
  technicalCheck: { status: 'passed' },
}

const ARTICLE = {
  _id: ARTICLE_ID,
  sourceId: SOURCE_ID,
  status: 'published',
  evidenceEligible: true,
  rightsSnapshot: { sourcePolicyVersion: 3, licenseStatus: 'permitted', llmInputScope: 'excerpt' },
  titleOriginal: 'Bai viet',
  originalUrl: 'https://example.test/articles/one',
  publishedAt: NOW,
  sourceLanguage: 'vi',
  excerptOriginal: 'Noi dung ngan.',
}

function validCitation(overrides = {}) {
  return {
    id: 'C1',
    status: 'available',
    articleId: ARTICLE_ID.toHexString(),
    sourceId: SOURCE_ID.toHexString(),
    originalUrl: 'https://example.test/articles/one',
    titleOriginal: 'Bai viet',
    publishedAt: NOW.toISOString(),
    ...overrides,
  }
}

function activeSession() {
  return {
    _id: LOGIN_SESSION_ID,
    userId: USER_ID,
    userSessionVersion: 1,
    status: 'active',
    expiresAt: new Date(NOW.getTime() + 60_000),
    absoluteExpiresAt: new Date(NOW.getTime() + 60_000),
  }
}

function fluent(rows = []) {
  const cursor = {
    sort: vi.fn(() => cursor),
    limit: vi.fn(() => cursor),
    hint: vi.fn(() => cursor),
    project: vi.fn(() => cursor),
    toArray: vi.fn(async () => rows),
  }
  return cursor
}

function makeDatabase(overrides = {}) {
  const collections = {
    users: { findOne: vi.fn(async () => ({ _id: USER_ID })) },
    sessions: { findOne: vi.fn(async () => activeSession()) },
    chatSessions: {
      find: vi.fn(() => fluent()),
      findOne: vi.fn(async () => null),
      findOneAndUpdate: vi.fn(async () => ({ value: null })),
      insertOne: vi.fn(async () => ({ acknowledged: true })),
      deleteOne: vi.fn(async () => ({ deletedCount: 1 })),
      deleteMany: vi.fn(async () => ({ deletedCount: 1 })),
    },
    answerAttempts: {
      findOne: vi.fn(async () => null),
      findOneAndUpdate: vi.fn(async () => ({ value: null })),
      insertOne: vi.fn(async () => ({ acknowledged: true })),
      find: vi.fn(() => fluent()),
      deleteMany: vi.fn(async () => ({ deletedCount: 0 })),
    },
    articles: {
      findOne: vi.fn(async () => ARTICLE),
      findOneAndUpdate: vi.fn(async () => ({ value: ARTICLE })),
    },
    sources: {
      findOne: vi.fn(async () => SOURCE),
      findOneAndUpdate: vi.fn(async () => ({ value: SOURCE })),
    },
    ...overrides,
  }
  const db = { collection: vi.fn((name) => collections[name]) }
  const transactionSession = {
    withTransaction: vi.fn(async (work) => work()),
    endSession: vi.fn(async () => undefined),
  }
  const client = { startSession: vi.fn(() => transactionSession) }
  return {
    collections,
    db,
    client,
    transactionSession,
    repository: new MongoChatRepository({ db, client, now: () => NOW }),
  }
}

describe('chat repository coverage contracts', () => {
  it('serializes active sessions and rejects expired or inconsistent documents', () => {
    const userMessage = { id: 'U1', role: 'user', text: 42, createdAt: NOW }
    const answered = {
      id: 'A1',
      role: 'assistant',
      status: 'answered',
      paragraphs: [{ text: 'Ket luan', citationIds: ['C1'] }],
      citations: [validCitation()],
      createdAt: NOW,
    }
    const refused = {
      id: 'A2',
      role: 'assistant',
      status: 'refused',
      refusalReason: 'insufficient-evidence',
      createdAt: NOW,
    }
    const document = {
      _id: CHAT_SESSION_ID,
      title: undefined,
      scope: { articleId: ARTICLE_ID, topics: ['ai'], publishedAfter: NOW },
      messages: [userMessage, answered, refused],
      messageCount: 3,
      createdAt: NOW,
      updatedAt: NOW,
    }

    expect(serializeChatSession(document, { now: NOW })).toMatchObject({
      id: CHAT_SESSION_ID.toHexString(),
      title: null,
      scope: {
        articleId: ARTICLE_ID.toHexString(),
        topics: ['ai'],
        publishedAfter: NOW.toISOString(),
      },
      messageCount: 3,
      messages: [
        { text: '42' },
        { status: 'answered', citations: [{ id: 'C1', status: 'available' }] },
        { status: 'refused', refusalReason: 'insufficient-evidence' },
      ],
    })
    expect(serializeChatSession(null)).toBeNull()
    expect(
      serializeChatSession(
        { ...document, updatedAt: new Date(NOW.getTime() - 30 * 24 * 60 * 60 * 1000) },
        { now: NOW },
      ),
    ).toBeNull()
    expect(() => serializeChatSession({ ...document, messageCount: 2 }, { now: NOW })).toThrow(
      'message count',
    )
    expect(() =>
      serializeChatSession(
        { ...document, messages: Array.from({ length: 31 }, () => userMessage), messageCount: 31 },
        { now: NOW },
      ),
    ).toThrow('message count')
  })

  it('validates public message and citation shapes while preserving unavailable history', () => {
    expect(publicMessage({ id: 'u', role: 'user', text: 'hello', createdAt: NOW })).toEqual({
      id: 'u',
      role: 'user',
      text: 'hello',
      createdAt: NOW.toISOString(),
    })
    expect(
      publicMessage({
        id: 'a',
        role: 'assistant',
        status: 'refused',
        refusalReason: 'blocked',
        createdAt: NOW,
      }),
    ).toMatchObject({ status: 'refused', paragraphs: [], citations: [] })
    expect(
      historicalCitation({
        id: 'C2',
        status: 'unavailable',
        articleId: ARTICLE_ID,
        sourceId: SOURCE_ID,
        unavailableReason: 'takedown',
      }),
    ).toMatchObject({ id: 'C2', status: 'unavailable' })
    expect(
      redactHistoricalCitation({ id: 'C2', status: 'unavailable', unavailableReason: 'old' }),
    ).toEqual({ id: 'C2', status: 'unavailable', unavailableReason: 'old' })
    expect(() =>
      publicMessage({ id: 'x', role: 'assistant', status: 'pending', createdAt: NOW }),
    ).toThrow('status')
    expect(() => publicMessage({ id: 'x', role: 'system', createdAt: NOW })).toThrow('message')
    expect(() =>
      historicalCitation({
        id: 'C3',
        status: 'available',
        articleId: ARTICLE_ID,
        sourceId: SOURCE_ID,
        originalUrl: 'http://example.test',
        titleOriginal: 'x',
        publishedAt: NOW,
      }),
    ).toThrow('URL')
    expect(() =>
      historicalCitationDocument(
        validCitation({ originalUrl: 'https://user:pass@example.test/a' }),
      ),
    ).toThrow('invalid')
    expect(publicAnswerCitation(validCitation(), ARTICLE, SOURCE)).toMatchObject({
      id: 'C1',
      sourceName: 'Nguon editorial',
      articleId: ARTICLE_ID.toHexString(),
    })
    expect(
      publicAnswerCitation(
        validCitation(),
        { ...ARTICLE, originalUrl: 'http://example.test' },
        SOURCE,
      ),
    ).toBeNull()
  })

  it('lists sessions with a stable cursor and enforces actor and limit gates', async () => {
    const rows = [
      { _id: CHAT_SESSION_ID, title: 'One', updatedAt: NOW },
      {
        _id: new ObjectId('507f1f77bcf86cd799439206'),
        title: null,
        updatedAt: new Date(NOW.getTime() - 1_000),
      },
      {
        _id: new ObjectId('507f1f77bcf86cd799439207'),
        title: 'Three',
        updatedAt: new Date(NOW.getTime() - 2_000),
      },
    ]
    const { repository, collections } = makeDatabase()
    collections.chatSessions.find.mockReturnValue(fluent(rows))

    const result = await repository.listChatSessions({ actor: ACTOR, limit: 2, now: NOW })

    expect(result).toMatchObject({
      hasNext: true,
      sessions: [{ id: CHAT_SESSION_ID.toHexString(), title: 'One' }, { title: null }],
    })
    expect(result.nextCursor).toEqual(expect.any(String))
    expect(collections.chatSessions.find).toHaveBeenCalledWith(
      expect.objectContaining({ userId: USER_ID, expiresAt: { $gt: NOW } }),
    )
    await expect(
      repository.listChatSessions({ actor: ACTOR, limit: 0, now: NOW }),
    ).rejects.toMatchObject({ code: 'validation_error', status: 422 })
    const unauthorized = makeDatabase({ users: { findOne: vi.fn(async () => null) } }).repository
    await expect(unauthorized.listChatSessions({ actor: ACTOR, now: NOW })).rejects.toMatchObject({
      code: 'unauthorized',
      status: 401,
    })
  })

  it('gets, deletes and clears owned sessions, including missing documents', async () => {
    const document = {
      _id: CHAT_SESSION_ID,
      userId: USER_ID,
      title: 'One',
      scope: {},
      messages: [],
      messageCount: 0,
      createdAt: NOW,
      updatedAt: NOW,
      expiresAt: new Date(NOW.getTime() + 60_000),
    }
    const { repository, collections } = makeDatabase()
    collections.chatSessions.findOne.mockResolvedValue(document)
    expect(
      await repository.getChatSession({ actor: ACTOR, chatSessionId: CHAT_SESSION_ID, now: NOW }),
    ).toMatchObject({ id: CHAT_SESSION_ID.toHexString(), messageCount: 0 })
    collections.chatSessions.findOne.mockResolvedValue(null)
    expect(
      await repository.getChatSession({
        userId: USER_ID,
        chatSessionId: CHAT_SESSION_ID,
        now: NOW,
      }),
    ).toBeNull()
    await repository.deleteChatSession({ userId: USER_ID, chatSessionId: CHAT_SESSION_ID })
    await repository.clearChatSessions({ actor: ACTOR })
    expect(collections.chatSessions.deleteOne).toHaveBeenCalledWith({
      _id: CHAT_SESSION_ID,
      userId: USER_ID,
    })
    expect(collections.chatSessions.deleteMany).toHaveBeenCalledWith({ userId: USER_ID })
  })

  it('reserves attempts, reuses matching idempotency and rejects quota or mismatched requests', async () => {
    const existing = {
      _id: new ObjectId('507f1f77bcf86cd799439208'),
      requestHash: 'b'.repeat(64),
      status: 'reserved',
      updatedAt: NOW,
    }
    const { repository, collections } = makeDatabase()
    collections.answerAttempts.findOne.mockResolvedValue(existing)
    await expect(
      repository.reserveAnswerAttempt({
        actor: ACTOR,
        idempotencyKeyHash: 'a'.repeat(64),
        requestHash: 'b'.repeat(64),
        now: NOW,
      }),
    ).resolves.toMatchObject({ reused: true })
    await expect(
      repository.reserveAnswerAttempt({
        actor: ACTOR,
        idempotencyKeyHash: 'a'.repeat(64),
        requestHash: 'c'.repeat(64),
        now: NOW,
      }),
    ).rejects.toMatchObject({ code: 'idempotency_mismatch', status: 409 })
    await expect(
      repository.reserveAnswerAttempt({
        actor: ACTOR,
        idempotencyKeyHash: 'bad',
        requestHash: 'b'.repeat(64),
        now: NOW,
      }),
    ).rejects.toThrow('hashes')

    collections.answerAttempts.findOne.mockResolvedValue(null)
    const denied = makeDatabase()
    denied.collections.answerAttempts.insertOne.mockRejectedValue(
      Object.assign(new Error('duplicate'), { code: 11000 }),
    )
    denied.collections.answerAttempts.findOne.mockResolvedValue(null)
    denied.repository.assertActorFence = vi.fn(async () => true)
    await expect(
      denied.repository.reserveAnswerAttempt({
        actor: ACTOR,
        idempotencyKeyHash: 'a'.repeat(64),
        requestHash: 'b'.repeat(64),
        rateLimitAdmission: { reserve: async () => ({ allowed: false, retryAfterSeconds: 7 }) },
        now: NOW,
      }),
    ).rejects.toMatchObject({ code: 'rate_limit_exceeded', retryAfter: 7 })
  })

  it('updates attempts with optional status fences and purges due rows in bounded batches', async () => {
    const { repository, collections } = makeDatabase()
    const updated = { _id: CHAT_SESSION_ID, status: 'completed' }
    collections.answerAttempts.findOneAndUpdate.mockResolvedValue({ value: updated })
    await expect(
      repository.updateAnswerAttempt(
        CHAT_SESSION_ID,
        { status: 'completed' },
        { expectedStatuses: ['reserved', 'provider-running'] },
      ),
    ).resolves.toEqual(updated)
    expect(collections.answerAttempts.findOneAndUpdate).toHaveBeenCalledWith(
      { _id: CHAT_SESSION_ID, status: { $in: ['reserved', 'provider-running'] } },
      { $set: { status: 'completed', updatedAt: NOW } },
      expect.objectContaining({ returnDocument: 'after' }),
    )
    collections.answerAttempts.findOneAndUpdate.mockResolvedValue({ value: null })
    await expect(
      repository.updateAnswerAttempt(
        CHAT_SESSION_ID,
        { status: 'failed' },
        { expectedStatus: 'reserved' },
      ),
    ).rejects.toMatchObject({ code: 'conflict', status: 409 })
    await expect(repository.purgeDueAnswerAttempts({ cutoff: NOW, limit: 0 })).rejects.toThrow(
      'limit',
    )
    collections.answerAttempts.find.mockReturnValue(fluent([]))
    await expect(repository.purgeDueAnswerAttempts({ cutoff: NOW, limit: 2 })).resolves.toEqual({
      inspected: 0,
      affected: 0,
      hasMore: false,
    })
    const candidates = [
      { _id: new ObjectId('507f1f77bcf86cd799439209') },
      { _id: new ObjectId('507f1f77bcf86cd799439210') },
      { _id: new ObjectId('507f1f77bcf86cd799439211') },
    ]
    collections.answerAttempts.find.mockReturnValue(fluent(candidates))
    collections.answerAttempts.deleteMany.mockResolvedValue({ deletedCount: 2 })
    await expect(repository.purgeDueAnswerAttempts({ cutoff: NOW, limit: 2 })).resolves.toEqual({
      inspected: 2,
      affected: 2,
      hasMore: true,
    })
  })

  it('appends answered and refused messages while rotating full sessions', async () => {
    const { repository, collections } = makeDatabase()
    const current = {
      _id: CHAT_SESSION_ID,
      userId: USER_ID,
      scope: {},
      messages: [],
      messageCount: 30,
      createdAt: NOW,
      updatedAt: NOW,
      expiresAt: new Date(NOW.getTime() + 60_000),
    }
    collections.chatSessions.findOne.mockResolvedValue(current)
    collections.chatSessions.findOneAndUpdate.mockImplementation(async (filter) => ({
      value: { ...current, _id: filter._id, messageCount: 0, messages: [] },
    }))
    const answer = await repository.appendAnswer({
      actor: ACTOR,
      question: 'Cau hoi?',
      answer: {
        id: 'answer-1',
        status: 'answered',
        paragraphs: [{ text: 'Ket luan', citationIds: [] }],
      },
      now: NOW,
    })
    expect(answer).toMatchObject({
      answer: { status: 'answered' },
      chatSessionId: expect.any(String),
    })

    collections.chatSessions.findOne.mockResolvedValue(null)
    await expect(
      repository.appendAnswer({
        actor: ACTOR,
        chatSessionId: CHAT_SESSION_ID,
        question: 'Cau hoi?',
        answer: { status: 'refused', refusalReason: 'insufficient-evidence' },
        now: NOW,
      }),
    ).rejects.toMatchObject({ code: 'not_found', status: 404 })
    await expect(
      repository.appendAnswer({
        actor: ACTOR,
        question: '',
        answer: { status: 'refused' },
        now: NOW,
      }),
    ).rejects.toThrow('Question')
  })
})
