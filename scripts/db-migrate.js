import { validateMongoConfiguration } from '../server/config/runtime.js'
import { getMongoContext, closeMongoConnection } from '../server/repositories/mongo/connection.js'
import { buildAuthCoreMigration } from './migrations/auth-core.js'
import { buildSourcesMigration } from './migrations/sources.js'
import { buildDurableJobsMigration } from './migrations/durable-jobs.js'
import { buildArticlesMigration, runArticlesMigration } from './migrations/articles.js'
import {
  runAuthCoreWithStep4Compatibility,
  runDurableJobsWithStep4Compatibility,
  runSourcesWithStep4Compatibility,
} from './migrations/step4-compatibility.js'
import { configureDns } from './configure-dns.js'

configureDns()

const args = new Set(process.argv.slice(2))
const targetIndex = process.argv.indexOf('--to')
const target = targetIndex >= 0 ? process.argv[targetIndex + 1] : 'auth-core'
const dryRun = args.has('--dry-run')

if (!['auth-core', 'sources', 'durable-jobs', 'articles'].includes(target)) {
  console.error('Supported migration targets: auth-core, sources, durable-jobs, articles')
  process.exitCode = 2
} else {
  try {
    const runtime = { mongo: validateMongoConfiguration(process.env) }
    const buildMigration = target === 'sources' ? buildSourcesMigration : target === 'durable-jobs' ? buildDurableJobsMigration : target === 'articles' ? buildArticlesMigration : buildAuthCoreMigration
    const runMigration = target === 'sources' ? runSourcesWithStep4Compatibility : target === 'durable-jobs' ? runDurableJobsWithStep4Compatibility : target === 'articles' ? runArticlesMigration : runAuthCoreWithStep4Compatibility
    const plan = dryRun
      ? buildMigration({ dryRun: true })
      : await (async () => {
        const context = await getMongoContext(runtime)
        return runMigration({ db: context.db })
      })()
    console.log(JSON.stringify({ migration: target, dryRun, operations: plan.length }))
  } catch {
    console.error('Migration failed: runtime_or_database_error')
    process.exitCode = 1
  } finally {
    await closeMongoConnection()
  }
}
