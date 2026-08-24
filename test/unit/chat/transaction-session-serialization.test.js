import { MongoServerError, ObjectId } from 'mongodb'
import { describe, expect, it } from 'vitest'
import { MongoChatRepository } from '../../../server/repositories/mongo/chat-repository.js'

const now = new Date('2026-08-12T00:00:00.000Z')
const userId = new ObjectId('507f1f77bcf86cd799439201')
const loginSessionId = new ObjectId('507f1f77bcf86cd799439202')
const actor = { userId, actorFence: { sessionId: loginSessionId, sessionVersion: 1 } }

function serializedMongo() {
  const calls = []
  const state = {
    users: [{ _id: userId, status: 'active', sessionVersion: 1 }],
    sessions: [{
      _id: loginSessionId, userId, userSessionVersion: 1, status: 'active',
      expiresAt: new Date(now.getTime() + 60_000), absoluteExpiresAt: new Date(now.getTime() + 60_000),
    }],
    chatSessions: [],
    answerAttempts: [],
  }
  let inFlight = null

  async function operation(collection, method, options, work) {
    const session = options?.session
    if (session !== transactionSession) {
      const error = new Error(`${collection}.${method} must use the transaction session`)
      error.code = 'transaction_session_missing'
      throw error
    }
    if (session && inFlight?.session === session) {
      const error = new MongoServerError({
        message: `Transaction session reused while ${inFlight.name} is in flight`,
        code: 117,
        codeName: 'ConflictingOperationInProgress',
      })
      throw error
    }
    inFlight = { name: `${collection}.${method}`, session }
    calls.push({ collection, method, session })
    try {
      await Promise.resolve()
      return await work()
    } finally {
      if (session && inFlight?.session === session) inFlight = null
    }
  }

  function collection(name) {
    return {
      findOne(filter, options) {
        return operation(name, 'findOne', options, async () => {
          if (name === 'users') return state.users[0]
          if (name === 'sessions') return state.sessions[0]
          if (name === 'chatSessions') return state.chatSessions.find(({ _id }) => String(_id) === String(filter._id)) ?? null
          if (name === 'answerAttempts') return state.answerAttempts.find(({ _id }) => String(_id) === String(filter._id)) ?? null
          return null
        })
      },
      async insertOne(document, options) {
        return operation(name, 'insertOne', options, async () => {
          state[name].push(document)
          return { insertedId: document._id }
        })
      },
      async updateOne(_filter, _update, options) {
        return operation(name, 'updateOne', options, async () => ({ matchedCount: 1 }))
      },
      async findOneAndUpdate(filter, update, options) {
        return operation(name, 'findOneAndUpdate', options, async () => {
          const rows = state[name]
          const index = rows.findIndex(({ _id }) => String(_id) === String(filter._id))
          if (index < 0) return { value: null }
          const current = rows[index]
          const pushed = update.$push?.messages
          const messages = pushed?.$each ? [...current.messages, ...pushed.$each] : pushed ? [...current.messages, pushed] : current.messages
          const next = {
            ...current,
            ...(pushed ? { messages } : {}),
            ...(update.$inc?.messageCount ? { messageCount: current.messageCount + update.$inc.messageCount } : {}),
            ...(update.$set ?? {}),
          }
          rows[index] = next
          return { value: next }
        })
      },
    }
  }

  const transactionSession = {
    withTransaction: async (work) => work(),
    endSession: async () => undefined,
  }
  const db = { collection }
  const client = { startSession: () => transactionSession }
  return { db, client, calls, state, transactionSession }
}

function repositoryFixture() {
  const mongo = serializedMongo()
  const repository = new MongoChatRepository({ db: mongo.db, client: mongo.client, now: () => now })
  return { ...mongo, repository }
}

describe('Mongo chat transaction session serialization', () => {
  it('serializes actor fence reads before reserving an answer attempt', async () => {
    const { repository, calls, transactionSession } = repositoryFixture()
    let reserveInFlight = false
    const reservations = []
    const rateLimitAdmission = {
      reserve: async ({ scope, session }) => {
        expect(session).toBe(transactionSession)
        expect(reserveInFlight).toBe(false)
        reserveInFlight = true
        reservations.push({ scope, session })
        await Promise.resolve()
        reserveInFlight = false
        return { allowed: true }
      },
    }

    await expect(repository.reserveAnswerAttempt({
      actor,
      idempotencyKeyHash: 'a'.repeat(64),
      requestHash: 'b'.repeat(64),
      rateLimitAdmission,
      now,
    })).resolves.toMatchObject({ status: 'reserved', reused: false })

    expect(calls.every(({ session }) => session === transactionSession)).toBe(true)
    expect(reservations).toEqual([
      { scope: 'answer-minute', session: transactionSession },
      { scope: 'answer-daily', session: transactionSession },
    ])
  })

  it('keeps answer append reachable when actor fence reads share one transaction session', async () => {
    const { repository, calls, transactionSession } = repositoryFixture()

    await expect(repository.appendAnswer({
      actor,
      scope: { topics: ['ai'] },
      question: 'Cau hoi?',
      answer: { id: 'answer-1', status: 'answered', paragraphs: [{ text: 'Ket luan.', citationIds: [] }] },
      now,
    })).resolves.toMatchObject({ answer: { id: 'answer-1', status: 'answered' } })
    expect(calls.every(({ session }) => session === transactionSession)).toBe(true)
  })

  it('keeps sensitive-input refusal append reachable on one transaction session', async () => {
    const { repository, calls, transactionSession } = repositoryFixture()

    await expect(repository.appendRefusalWithoutQuestion({
      actor,
      scope: { topics: ['ai'] },
      answer: { id: 'refusal-1' },
      now,
    })).resolves.toMatchObject({ answer: { id: 'refusal-1', status: 'refused', refusalReason: 'sensitive-input' } })
    expect(calls.every(({ session }) => session === transactionSession)).toBe(true)
  })
})
