import { MongoClient } from 'mongodb'
import { pathToFileURL } from 'node:url'
import { configureDns } from '../scripts/configure-dns.js'

export const APP_DATABASE = 'techpulse_app'
export const GOVERNANCE_DATABASE = 'techpulse_governance'
export const PRESERVED_APP_COLLECTIONS = Object.freeze([
  'users',
  'sessions',
  'accountDeletionRequests',
  'adminAuditLogs',
  'hmacKeyLifecycleSnapshots',
])
export const PRESERVED_GOVERNANCE_COLLECTIONS = Object.freeze([
  'governanceSuppressions',
  'governanceCheckpoints',
  'auditRetentionManifests',
])

const APP_CLEARABLE_COLLECTIONS = Object.freeze([
  'rateLimitBuckets',
  'savedArticles',
  'sources',
  'articles',
  'ingestionJobs',
  'jobLeases',
  'ingestionScheduleProgress',
  'indexingJobs',
  'providerAdmissionStates',
  'providerFailureDomainStates',
  'chatSessions',
  'answerAttempts',
  'takedownRequests',
  'runtimeCapabilityProbes',
])
const GOVERNANCE_CLEARABLE_COLLECTIONS = Object.freeze(['runtimeCapabilityProbes'])

const RESERVED_COLLECTION_PREFIX = /^system\./
const ENV_NAME_PATTERN = /^[A-Z][A-Z0-9_]{2,127}$/

export function parseClearArgs(args = []) {
  if (args.length === 0) return { apply: false }
  if (args.length === 1 && args[0] === '--apply') return { apply: true }
  throw new Error('clear tool accepts no arguments or --apply only')
}

export function planCollectionClears({ database, collections } = {}) {
  if (typeof database !== 'string' || !Array.isArray(collections)) throw new Error('clear plan input is invalid')
  const preserved = new Set(database === APP_DATABASE ? PRESERVED_APP_COLLECTIONS : database === GOVERNANCE_DATABASE ? PRESERVED_GOVERNANCE_COLLECTIONS : [])
  const known = new Set([...preserved, ...(database === APP_DATABASE ? APP_CLEARABLE_COLLECTIONS : database === GOVERNANCE_DATABASE ? GOVERNANCE_CLEARABLE_COLLECTIONS : [])])
  const unknown = collections.filter((collection) => typeof collection === 'string' && !RESERVED_COLLECTION_PREFIX.test(collection) && !known.has(collection))
  if (unknown.length > 0) throw new Error(`unsupported collection: ${unknown[0]}`)
  return collections.filter((collection) => typeof collection === 'string' && !RESERVED_COLLECTION_PREFIX.test(collection) && !preserved.has(collection)).map((collection) => ({ database, collection }))
}

function operatorUri(environment) {
  const name = environment.MONGODB_OPERATOR_URI_ENV
  if (typeof name !== 'string' || !ENV_NAME_PATTERN.test(name) || name === environment.MONGODB_URI_ENV) throw new Error('a separate operator credential is required')
  const uri = environment[name]
  if (typeof uri !== 'string' || uri.trim() === '') throw new Error('operator credential is not configured')
  if (environment.MONGODB_DATABASE !== APP_DATABASE) throw new Error(`clear tool only permits ${APP_DATABASE}`)
  return uri
}

async function collectionNames(db) {
  return (await db.listCollections({}, { nameOnly: true }).toArray()).map(({ name }) => name).filter(Boolean)
}

export async function clearDatabaseData({ db, database, apply = false, plan } = {}) {
  if (!db || typeof db.collection !== 'function') throw new Error('Mongo database is required')
  const targets = plan ?? planCollectionClears({ database, collections: await collectionNames(db) })
  const results = []
  for (const target of targets) {
    const collection = db.collection(target.collection)
    const before = await collection.countDocuments()
    const deleted = apply ? (await collection.deleteMany({})).deletedCount : 0
    results.push({ ...target, before, deleted, preserved: false })
  }
  return results
}

export async function inspectPreservedData({ db, database } = {}) {
  if (!db || typeof db.collection !== 'function') throw new Error('Mongo database is required')
  const names = database === APP_DATABASE ? PRESERVED_APP_COLLECTIONS : database === GOVERNANCE_DATABASE ? PRESERVED_GOVERNANCE_COLLECTIONS : []
  const counts = {}
  for (const name of names) counts[name] = await db.collection(name).countDocuments()
  return counts
}

async function main() {
  configureDns()
  const mode = parseClearArgs(process.argv.slice(2))
  let client
  try {
    const uri = operatorUri(process.env)
    client = new MongoClient(uri, { serverSelectionTimeoutMS: 5_000, maxPoolSize: 2 })
    await client.connect()
    const app = client.db(APP_DATABASE)
    const governance = client.db(GOVERNANCE_DATABASE)
    const appPlan = planCollectionClears({ database: APP_DATABASE, collections: await collectionNames(app) })
    const governancePlan = planCollectionClears({ database: GOVERNANCE_DATABASE, collections: await collectionNames(governance) })
    const preserved = {
      [APP_DATABASE]: await inspectPreservedData({ db: app, database: APP_DATABASE }),
      [GOVERNANCE_DATABASE]: await inspectPreservedData({ db: governance, database: GOVERNANCE_DATABASE }),
    }
    const appResults = await clearDatabaseData({
      db: app,
      database: APP_DATABASE,
      plan: appPlan,
      apply: mode.apply,
    })
    const governanceResults = await clearDatabaseData({
      db: governance,
      database: GOVERNANCE_DATABASE,
      plan: governancePlan,
      apply: mode.apply,
    })
    console.log(JSON.stringify({
      apply: mode.apply,
      preserved,
      cleared: [...appResults, ...governanceResults],
    }))
  } catch {
    console.error('Clear failed: operator_or_database_error')
    process.exitCode = 1
  } finally {
    await client?.close()
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main()
