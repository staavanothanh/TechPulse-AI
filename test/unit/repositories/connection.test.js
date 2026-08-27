import { describe, expect, it, vi } from 'vitest'

vi.mock('mongodb', () => ({ MongoClient: vi.fn() }))

import { MongoClient } from 'mongodb'
import { closeMongoConnection, createMongoContext, getMongoContext, resetMongoConnectionForTests } from '../../../server/repositories/mongo/connection.js'

function clientFixture({ connectError = null } = {}) {
  const client = {
    connect: vi.fn(async () => {
      if (connectError) throw connectError
      return client
    }),
    db: vi.fn((name) => ({ name })),
    close: vi.fn(async () => {}),
  }
  MongoClient.mockImplementation(function MongoClientMock() { return client })
  return client
}

describe('Mongo connection context', () => {
  it('validates client and database names before calling Mongo', () => {
    expect(() => createMongoContext()).toThrow(/client/i)
    const client = { db: vi.fn(() => ({ name: 'techpulse_1' })) }
    expect(() => createMongoContext({ client, database: '' })).toThrow(/database/i)
    expect(() => createMongoContext({ client, database: 'bad-name!' })).toThrow(/database/i)
    expect(createMongoContext({ client, database: 'techpulse_1' })).toEqual({ client, db: { name: 'techpulse_1' }, database: 'techpulse_1' })
  })

  it('requires runtime Mongo configuration and caches the same URI/database promise', async () => {
    resetMongoConnectionForTests()
    await expect(getMongoContext()).rejects.toThrow(/configuration/i)
    await expect(getMongoContext({ mongo: { uriEnv: 'MONGO_URI', database: 'techpulse' } }, {})).rejects.toThrow(/URI/i)
    const client = clientFixture()
    const config = { mongo: { uriEnv: 'MONGO_URI', database: 'techpulse' } }
    const environment = { MONGO_URI: 'mongodb://localhost/test' }
    const first = await getMongoContext(config, environment)
    const second = await getMongoContext(config, environment)
    expect(first).toEqual({ client, db: { name: 'techpulse' }, database: 'techpulse' })
    expect(second).toBe(first)
    expect(MongoClient).toHaveBeenCalledTimes(1)
    expect(client.connect).toHaveBeenCalledTimes(1)
  })

  it('closes an old connection when URI changes and resets singleton state', async () => {
    const firstClient = clientFixture()
    await getMongoContext({ mongo: { uriEnv: 'MONGO_URI', database: 'techpulse' } }, { MONGO_URI: 'mongodb://one' })
    const secondClient = clientFixture()
    await getMongoContext({ mongo: { uriEnv: 'MONGO_URI', database: 'techpulse' } }, { MONGO_URI: 'mongodb://two' })
    expect(firstClient.close).toHaveBeenCalled()
    expect(secondClient.connect).toHaveBeenCalled()
    await closeMongoConnection()
    expect(secondClient.close).toHaveBeenCalled()
    await closeMongoConnection()
    resetMongoConnectionForTests()
  })

  it('clears cached state when connecting fails', async () => {
    resetMongoConnectionForTests()
    const error = new Error('connect failed')
    const failedClient = clientFixture({ connectError: error })
    await expect(getMongoContext({ mongo: { uriEnv: 'MONGO_URI', database: 'techpulse' } }, { MONGO_URI: 'mongodb://failed' })).rejects.toBe(error)
    expect(failedClient.close).not.toHaveBeenCalled()
    const recoveredClient = clientFixture()
    await expect(getMongoContext({ mongo: { uriEnv: 'MONGO_URI', database: 'techpulse' } }, { MONGO_URI: 'mongodb://recovered' })).resolves.toEqual(expect.objectContaining({ client: recoveredClient }))
  })
})
