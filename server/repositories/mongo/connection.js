import { MongoClient } from 'mongodb'

const GLOBAL_KEY = Symbol.for('techpulse.mongo.connection')

function state() {
  if (!globalThis[GLOBAL_KEY]) globalThis[GLOBAL_KEY] = { client: null, promise: null, uri: null, database: null }
  return globalThis[GLOBAL_KEY]
}

export function createMongoContext({ client, database }) {
  if (!client || typeof client.db !== 'function') throw new Error('MongoDB client is required')
  if (typeof database !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_]{0,62}$/.test(database)) throw new Error('unsafe MongoDB database name')
  return Object.freeze({ client, db: client.db(database), database })
}

export async function getMongoContext(runtimeConfig, environment = process.env) {
  const mongo = runtimeConfig?.mongo
  if (!mongo?.uriEnv || !mongo.database) throw new Error('MongoDB runtime configuration is required')
  const uri = environment[mongo.uriEnv]
  if (typeof uri !== 'string' || uri.trim() === '') throw new Error('MongoDB URI is not configured')
  const current = state()
  if (current.promise && current.uri === uri && current.database === mongo.database) return current.promise
  if (current.client) await closeMongoConnection()
  current.uri = uri
  current.database = mongo.database
  current.promise = (async () => {
    const client = new MongoClient(uri, { maxPoolSize: 10, serverSelectionTimeoutMS: 5_000, socketTimeoutMS: 15_000 })
    await client.connect()
    current.client = client
    return createMongoContext({ client, database: mongo.database })
  })()
  try {
    return await current.promise
  } catch (error) {
    current.promise = null
    current.client = null
    throw error
  }
}

export async function closeMongoConnection() {
  const current = state()
  const client = current.client
  current.promise = null
  current.client = null
  current.uri = null
  current.database = null
  if (client) await client.close()
}

export function resetMongoConnectionForTests() {
  const current = state()
  current.promise = null
  current.client = null
  current.uri = null
  current.database = null
}
