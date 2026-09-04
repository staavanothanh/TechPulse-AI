import { ObjectId } from 'mongodb'
import { describe, expect, it, vi } from 'vitest'
import {
  CHAT_SESSION_COLLECTIONS,
  CHAT_SESSION_INDEXES,
  buildChatSessionsMigration,
  runChatSessionsMigration,
  validateAnswerAttemptDocument,
  validateChatSessionDocument,
} from '../../../scripts/migrations/chat-sessions.js'
import { CHAT_SESSION_SOURCE_NAME_VALIDATOR, assertChatSessionsSourceNameMigrationSafe } from '../../../scripts/migrations/chat-sessions-source-name-v1.js'
import { INDEXING_JOB_AUDIT_VALIDATOR } from '../../../scripts/migrations/indexing-jobs.js'
import { actorValues } from '../../../server/repositories/mongo/chat-repository.js'

const id = () => new ObjectId()
const now = new Date('2026-08-12T00:00:00.000Z')

function validSession() {
  return {
    _id: id(),
    userId: id(),
    title: null,
    scope: { topics: ['ai'] },
    messages: [{ id: 'msg-user', role: 'user', text: 'Xin chao', createdAt: now }],
    messageCount: 1,
    expiresAt: new Date('2026-09-11T00:00:00.000Z'),
    createdAt: now,
    updatedAt: now,
  }
}

function validAttempt() {
  return {
    _id: id(),
    userId: id(),
    sessionId: id(),
    expectedSessionVersion: 2,
    idempotencyKeyHash: 'a'.repeat(64),
    requestHash: 'b'.repeat(64),
    status: 'reserved',
    quotaReservationKey: 'answer-daily:user:opaque',
    expiresAt: new Date('2026-08-13T00:00:00.000Z'),
    createdAt: now,
    updatedAt: now,
  }
}

describe('Step 10 chat migration contract', () => {
  it('accepts the exact nested actor fence emitted by content authentication', () => {
    const userId = id()
    const sessionId = id()
    expect(actorValues({ userId: userId.toHexString(), actorFence: { sessionId: sessionId.toHexString(), sessionVersion: 2 } })).toMatchObject({
      userId,
      sessionId,
      sessionVersion: 2,
    })
  })

  it('owns exactly chatSessions and answerAttempts with strict validators', () => {
    expect(Object.keys(CHAT_SESSION_COLLECTIONS)).toEqual(['chatSessions', 'answerAttempts'])
    for (const definition of Object.values(CHAT_SESSION_COLLECTIONS)) {
      expect(definition.validator).toEqual(expect.objectContaining({ $and: expect.any(Array) }))
      expect(definition.validator.$and[0].$jsonSchema.additionalProperties).toBe(false)
    }
  })
  it('blocks the legacy chat-sessions target from downgrading the sourceName successor', async () => {
    const db = {
      listCollections: vi.fn(() => ({ toArray: async () => [{ name: 'chatSessions', options: { validator: CHAT_SESSION_SOURCE_NAME_VALIDATOR } }] })),
    }
    await expect(assertChatSessionsSourceNameMigrationSafe({ db, target: 'chat-sessions' })).rejects.toThrow(/downgrade.*source-name/i)
    await expect(assertChatSessionsSourceNameMigrationSafe({ db, target: 'chat-sessions-source-name-v1' })).resolves.toBeUndefined()
  })

  it('defines bounded history, citation cleanup and answer receipt indexes', () => {
    expect(CHAT_SESSION_INDEXES.chatSessions).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: 'chat_sessions_user_updated', key: { userId: 1, updatedAt: -1, _id: -1 } }),
      expect.objectContaining({ name: 'chat_sessions_citation_article', key: { 'messages.citations.articleId': 1, _id: 1 } }),
      expect.objectContaining({ name: 'chat_sessions_citation_source', key: { 'messages.citations.sourceId': 1, _id: 1 } }),
      expect.objectContaining({ name: 'chat_sessions_expires_ttl', key: { expiresAt: 1 }, options: { expireAfterSeconds: 0 } }),
    ]))
    expect(CHAT_SESSION_INDEXES.answerAttempts).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: 'answer_attempts_identity_unique', options: { unique: true } }),
      expect.objectContaining({ name: 'answer_attempts_user_created', key: { userId: 1, createdAt: -1, _id: -1 } }),
      expect.objectContaining({ name: 'answer_attempts_expiry_deadline', key: { expiresAt: 1, _id: 1 } }),
      expect.objectContaining({ name: 'answer_attempts_expires_ttl', options: { expireAfterSeconds: 0 } }),
    ]))
  })

  it('validates message count/30-day retention and receipt privacy/24-hour retention', () => {
    expect(validateChatSessionDocument(validSession())).toEqual({ valid: true, errors: [] })
    expect(validateChatSessionDocument({ ...validSession(), scope: {} }).errors).toContain('scope must select articleId, topics, or a date range')
    expect(validateChatSessionDocument({ ...validSession(), scope: { topics: [] } }).errors).toContain('scope must select articleId, topics, or a date range')
    expect(validateChatSessionDocument({ ...validSession(), scope: { articleId: id(), publishedAfter: now } }).errors).toContain('scope date range must include both boundaries')
    expect(validateChatSessionDocument({ ...validSession(), scope: { publishedAfter: now, publishedBefore: new Date('2026-08-11T00:00:00.000Z') } }).errors).toContain('scope date range is invalid')
    expect(validateChatSessionDocument({ ...validSession(), scope: { publishedAfter: now, publishedBefore: new Date('2026-08-13T00:00:00.000Z') } }).valid).toBe(true)
    expect(validateChatSessionDocument({ ...validSession(), messageCount: 0 }).valid).toBe(false)
    expect(validateChatSessionDocument({ ...validSession(), messages: Array.from({ length: 31 }, (_, index) => ({ id: `m-${index}`, role: 'user', text: 'x', createdAt: now })), messageCount: 31 }).valid).toBe(false)
    expect(validateChatSessionDocument({ ...validSession(), expiresAt: new Date('2026-08-13T00:00:00.000Z') }).valid).toBe(false)
    expect(validateAnswerAttemptDocument(validAttempt())).toEqual({ valid: true, errors: [] })
    expect(validateAnswerAttemptDocument({ ...validAttempt(), rawQuestion: 'bi mat' }).valid).toBe(false)
    expect(validateAnswerAttemptDocument({ ...validAttempt(), expiresAt: new Date('2026-08-12T12:00:00.000Z') }).valid).toBe(false)
  })

  it('builds only non-destructive idempotent operations and fences on indexing predecessor', async () => {
    const plan = buildChatSessionsMigration({ dryRun: true })
    expect(plan.length).toBeGreaterThan(0)
    expect(plan.every((operation) => ['createCollection', 'collMod', 'createIndex'].includes(operation.type))).toBe(true)
    expect(plan.some((operation) => operation.type.startsWith('drop'))).toBe(false)
    const blocked = {
      listCollections: vi.fn(() => ({ toArray: async () => [] })),
      createCollection: vi.fn(),
      command: vi.fn(),
      collection: vi.fn(),
    }
    await expect(runChatSessionsMigration({ db: blocked })).rejects.toThrow(/indexing-jobs migration/i)
    expect(blocked.createCollection).not.toHaveBeenCalled()
    expect(blocked.command).not.toHaveBeenCalled()
  })

  it('applies create/collMod/index operations after the exact predecessor audit revision', async () => {
    const calls = []
    const db = {
      listCollections: vi.fn(() => ({ toArray: async () => [{ name: 'adminAuditLogs', options: { validator: INDEXING_JOB_AUDIT_VALIDATOR } }] })),
      createCollection: vi.fn(async (collection) => calls.push(['createCollection', collection])),
      command: vi.fn(async (command) => calls.push(['command', command.collMod])),
      collection: vi.fn((name) => ({ createIndex: vi.fn(async (_key, options) => calls.push(['createIndex', name, options.name])) })),
    }
    const plan = await runChatSessionsMigration({ db })
    expect(plan).toHaveLength(buildChatSessionsMigration().length)
    expect(calls).toEqual(expect.arrayContaining([
      ['createCollection', 'chatSessions'],
      ['createCollection', 'answerAttempts'],
      ['command', 'chatSessions'],
      ['command', 'answerAttempts'],
      ['createIndex', 'chatSessions', 'chat_sessions_expires_ttl'],
      ['createIndex', 'answerAttempts', 'answer_attempts_expires_ttl'],
    ]))
  })
})
