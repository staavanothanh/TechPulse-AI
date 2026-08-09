import { describe, expect, it, vi } from 'vitest'
import {
  actionsForCollection,
  isAuthorizationDenied,
  probeAuditRoleCapabilities,
  probeHmacLifecycleRoleCapabilities,
} from '../../scripts/mongo-role-probe.js'

function deniedError() {
  const error = new Error('not authorized')
  error.code = 13
  return error
}

function atlasDeniedError(identity = 'name', message = 'user is not allowed to do action update') {
  const error = new Error(message)
  error.code = 8000
  error[identity] = 'AtlasError'
  return error
}

function createClient(sessionBehaviors = []) {
  const sessions = []
  let attempt = 0
  const client = {
    startSession: vi.fn(() => {
      const behavior = sessionBehaviors[attempt] ?? {}
      attempt += 1
      if (behavior.startSessionError) throw behavior.startSessionError
      const session = {
        startTransaction: vi.fn(() => {
          if (behavior.startTransactionError) throw behavior.startTransactionError
        }),
        abortTransaction: vi.fn(async () => {
          if (behavior.abortError) throw behavior.abortError
        }),
        endSession: vi.fn(async () => {
          if (behavior.endError) throw behavior.endError
        }),
      }
      sessions.push(session)
      return session
    }),
  }
  return { client, sessions }
}

describe('Mongo audit role capability probe', () => {
  it('classifies Mongo code 13 and narrowly identified Atlas authorization denials', () => {
    expect(isAuthorizationDenied(deniedError())).toBe(true)
    expect(isAuthorizationDenied(atlasDeniedError('name'))).toBe(true)
    expect(isAuthorizationDenied(atlasDeniedError('codeName', 'not authorized to perform this operation'))).toBe(true)
  })

  it('rejects unrelated Atlas, network, transaction, validation and arbitrary errors', () => {
    expect(isAuthorizationDenied(atlasDeniedError('name', 'request rate limit reached'))).toBe(false)
    expect(isAuthorizationDenied(atlasDeniedError('codeName', 'authorization service unavailable'))).toBe(false)
    expect(isAuthorizationDenied(Object.assign(new Error('socket closed'), { code: 'ECONNRESET' }))).toBe(false)
    expect(isAuthorizationDenied(Object.assign(new Error('transaction aborted'), { code: 251 }))).toBe(false)
    expect(isAuthorizationDenied(Object.assign(new Error('document validation failed'), { code: 121 }))).toBe(false)
    expect(isAuthorizationDenied(new Error('arbitrary failure'))).toBe(false)
  })

  it('includes database-wide Atlas privileges when evaluating a protected collection', () => {
    const actions = actionsForCollection([
      { resource: { db: '', collection: '' }, actions: ['find', 'insert', 'update'] },
      { resource: { db: 'techpulse_app', collection: 'adminAuditLogs' }, actions: ['remove'] },
      { resource: { db: 'other', collection: '' }, actions: ['dropDatabase'] },
    ], 'techpulse_app', 'adminAuditLogs')

    expect(actions).toEqual(new Set(['find', 'insert', 'update', 'remove']))
  })

  it('uses independent transactions to prove update and delete are each denied', async () => {
    const { client, sessions } = createClient()
    const collection = {
      insertOne: vi.fn(async () => undefined),
      findOne: vi.fn(async () => ({ eventId: 'role-probe' })),
      updateOne: vi.fn(async () => { throw deniedError() }),
      deleteOne: vi.fn(async () => { throw deniedError() }),
    }

    const result = await probeAuditRoleCapabilities({ client, db: { collection: vi.fn(() => collection) } })

    expect(result).toEqual({ inserted: true, findAllowed: true, updateDenied: true, deleteDenied: true })
    expect(client.startSession).toHaveBeenCalledTimes(3)
    expect(sessions.every((session) => session.abortTransaction.mock.calls.length === 1)).toBe(true)
  })

  it('allows append/read but independently denies update and delete for lifecycle snapshots', async () => {
    const { client, sessions } = createClient()
    const collection = {
      insertOne: vi.fn(async () => undefined),
      findOne: vi.fn(async () => ({ inventoryId: 'quota-hmac', revision: 1 })),
      updateOne: vi.fn(async () => { throw atlasDeniedError('name') }),
      deleteOne: vi.fn(async () => { throw atlasDeniedError('codeName') }),
    }

    const result = await probeHmacLifecycleRoleCapabilities({ client, db: { collection: vi.fn(() => collection) } })

    expect(result).toEqual({ inserted: true, findAllowed: true, updateDenied: true, deleteDenied: true })
    expect(client.startSession).toHaveBeenCalledTimes(3)
    expect(sessions.every((session) => session.abortTransaction.mock.calls.length === 1)).toBe(true)
  })

  it('does not claim denial when update and delete operations actually succeed', async () => {
    const { client } = createClient()
    const collection = {
      insertOne: vi.fn(async () => undefined),
      findOne: vi.fn(async () => ({ eventId: 'role-probe' })),
      updateOne: vi.fn(async () => ({ matchedCount: 0 })),
      deleteOne: vi.fn(async () => ({ deletedCount: 0 })),
    }

    await expect(probeAuditRoleCapabilities({ client, db: { collection: vi.fn(() => collection) } })).resolves.toEqual({
      inserted: true, findAllowed: true, updateDenied: false, deleteDenied: false,
    })
  })

  it.each([
    ['startSession', { startSessionError: deniedError() }],
    ['startTransaction', { startTransactionError: deniedError() }],
    ['abortTransaction', { abortError: deniedError() }],
    ['endSession', { endError: deniedError() }],
  ])('fails closed when %s fails instead of treating it as mutation denial', async (_phase, behavior) => {
    const { client } = createClient([{}, behavior, {}])
    const collection = {
      insertOne: vi.fn(async () => undefined),
      findOne: vi.fn(async () => ({ eventId: 'role-probe' })),
      updateOne: vi.fn(async () => { throw deniedError() }),
      deleteOne: vi.fn(async () => { throw deniedError() }),
    }

    await expect(probeAuditRoleCapabilities({ client, db: { collection: vi.fn(() => collection) } })).resolves.toEqual({
      inserted: true, findAllowed: true, updateDenied: false, deleteDenied: true,
    })
  })
})
