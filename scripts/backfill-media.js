import { pathToFileURL } from 'node:url'
import { createMediaBackfillWorker } from '../server/application/media/backfill.js'
import { createLiveConnectorRegistry } from '../server/connectors/live-registry.js'
import { validateMongoConfiguration } from '../server/config/runtime.js'
import { createSafeFetch } from '../server/infrastructure/http/safe-fetch.js'
import { MongoArticleRepository } from '../server/repositories/mongo/article-repository.js'
import { getMongoContext, closeMongoConnection } from '../server/repositories/mongo/connection.js'
import { MongoSourceRepository } from '../server/repositories/mongo/source-repository.js'

const DATABASE_NAME = /^[A-Za-z0-9][A-Za-z0-9_]{0,62}$/
const MAX_LIMIT = 100
export const MEDIA_BACKFILL_USAGE = 'Usage: node scripts/backfill-media.js --source-key=<rss:source> [--limit=1..100] [--confirm --confirm-database=<database>]'

function positiveInteger(value, label) {
  const result = Number(value)
  if (!Number.isInteger(result) || result < 1 || result > MAX_LIMIT) throw new Error(`${label} is invalid`)
  return result
}

export function parseMediaBackfillArgs(args = []) {
  let sourceKey
  let limit = MAX_LIMIT
  let confirm = false
  let confirmDatabase = null
  for (const argument of args) {
    if (argument === '--confirm') confirm = true
    else if (argument === '--help') return { help: true }
    else if (argument.startsWith('--source-key=')) sourceKey = argument.slice('--source-key='.length)
    else if (argument.startsWith('--limit=')) limit = positiveInteger(argument.slice('--limit='.length), 'limit')
    else if (argument.startsWith('--confirm-database=')) confirmDatabase = argument.slice('--confirm-database='.length)
    else throw new Error('arguments are invalid')
  }
  if (typeof sourceKey !== 'string' || !/^[a-z0-9][a-z0-9:-]{2,119}$/.test(sourceKey)) throw new Error('source-key is required')
  if (confirm && (!DATABASE_NAME.test(confirmDatabase ?? '') || !confirmDatabase)) throw new Error('confirm-database is required with confirm')
  if (!confirm && confirmDatabase !== null) throw new Error('confirm-database requires confirm')
  return Object.freeze({ sourceKey, limit, confirm, dryRun: !confirm, confirmDatabase })
}

export async function createConfiguredMediaBackfillRuntime({ environment = process.env } = {}) {
  const runtime = { mongo: validateMongoConfiguration(environment) }
  const context = await getMongoContext(runtime, environment)
  const sourceRepository = new MongoSourceRepository(context)
  const articleRepository = new MongoArticleRepository(context)
  const worker = createMediaBackfillWorker({
    connectorRegistry: createLiveConnectorRegistry({ safeFetch: createSafeFetch() }),
    sourceRepository,
    articleRepository,
  })
  return Object.freeze({ database: context.database, worker })
}

export async function runMediaBackfill({ options, environment = process.env, runtime, loadRuntime = createConfiguredMediaBackfillRuntime } = {}) {
  if (!options || options.help) return { ok: true, help: true }
  if (!options.dryRun && environment?.MONGODB_DATABASE !== options.confirmDatabase) throw new Error('confirm-database does not match the configured runtime database')
  try {
    const configured = runtime ?? await loadRuntime({ environment })
    if (!configured?.worker || typeof configured.worker.run !== 'function' || typeof configured.database !== 'string') throw new Error('media backfill runtime is invalid')
    if (!options.dryRun && configured.database !== options.confirmDatabase) throw new Error('confirm-database does not match the configured runtime database')
    const result = await configured.worker.run({ sourceKey: options.sourceKey, dryRun: options.dryRun, limit: options.limit })
    return Object.freeze({ ok: result?.outcome !== 'failed', mode: options.dryRun ? 'dry-run' : 'execute', dryRun: options.dryRun, ...result })
  } finally {
    if (!runtime) await closeMongoConnection()
  }
}

function safeError(error) {
  const code = typeof error?.code === 'string' && /^[a-z0-9_:-]{1,128}$/i.test(error.code) ? error.code : null
  return { ok: false, error: 'media_backfill_failed', code, type: error?.name ?? 'Error' }
}

export async function main(argv = process.argv.slice(2), { environment = process.env, log = console.log, errorLog = console.error } = {}) {
  try {
    const options = parseMediaBackfillArgs(argv)
    if (options.help) {
      log(MEDIA_BACKFILL_USAGE)
      return { ok: true, help: true }
    }
    const result = await runMediaBackfill({ options, environment })
    log(JSON.stringify(result))
    if (!result.ok) process.exitCode = 1
    return result
  } catch (error) {
    errorLog(JSON.stringify(safeError(error)))
    process.exitCode = 1
    return null
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main()
