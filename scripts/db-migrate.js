import { validateMongoConfiguration } from '../server/config/runtime.js'
import { getMongoContext, closeMongoConnection } from '../server/repositories/mongo/connection.js'
import { buildAuthCoreMigration } from './migrations/auth-core.js'
import { buildSourcesMigration, runSourcesMigration } from './migrations/sources.js'
import { runAuthCoreWithStep3Compatibility } from './migrations/step3-compatibility.js'
import { configureDns } from './configure-dns.js'

configureDns()

const args = new Set(process.argv.slice(2))
const targetIndex = process.argv.indexOf('--to')
const target = targetIndex >= 0 ? process.argv[targetIndex + 1] : 'auth-core'
const dryRun = args.has('--dry-run')

if (!['auth-core', 'sources'].includes(target)) {
  console.error('Supported migration targets: auth-core, sources')
  process.exitCode = 2
} else {
  try {
    const runtime = { mongo: validateMongoConfiguration(process.env) }
    const buildMigration = target === 'sources' ? buildSourcesMigration : buildAuthCoreMigration
    const runMigration = target === 'sources' ? runSourcesMigration : runAuthCoreWithStep3Compatibility
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
