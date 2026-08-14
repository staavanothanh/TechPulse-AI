import { MongoClient } from 'mongodb'
import { createMongoContext } from '../repositories/mongo/connection.js'

const CLIENT_OPTIONS = Object.freeze({ maxPoolSize: 2, serverSelectionTimeoutMS: 5_000 })

function defaultClientFactory(uri) {
  return new MongoClient(uri, CLIENT_OPTIONS)
}

export function createMaintenanceMongoContext({ client, runtimeClient, database } = {}) {
  if (runtimeClient && client === runtimeClient) throw new Error('MongoDB maintenance client must be separate from runtime client')
  return createMongoContext({ client, database })
}

export async function getMaintenanceMongoContext({ runtimeConfig, environment = process.env, runtimeClient, clientFactory = defaultClientFactory } = {}) {
  const maintenance = runtimeConfig?.maintenanceMongo
  if (!maintenance) return null
  const uri = environment[maintenance.uriEnv]
  if (typeof uri !== 'string' || uri.trim() === '') throw new Error('MongoDB maintenance URI is not configured')
  const runtimeUri = runtimeConfig.mongo?.uriEnv ? environment[runtimeConfig.mongo.uriEnv] : undefined
  if (runtimeUri && uri === runtimeUri) throw new Error('MongoDB maintenance credential must be separate')
  const client = clientFactory(uri)
  try {
    if (!client || typeof client.connect !== 'function') throw new Error('MongoDB maintenance client is invalid')
    await client.connect()
    return createMaintenanceMongoContext({ client, runtimeClient, database: maintenance.database })
  } catch (error) {
    await client?.close?.()
    throw error
  }
}

export async function closeMaintenanceMongoContext(context) {
  await context?.client?.close?.()
}
