import { validateMongoConfiguration } from '../server/config/runtime.js'
import { getMongoContext, closeMongoConnection } from '../server/repositories/mongo/connection.js'
import { buildAuthCoreMigration, runAuthCoreMigration } from './migrations/auth-core.js'
import { configureDns } from './configure-dns.js'

configureDns()

const args = new Set(process.argv.slice(2))
const targetIndex = process.argv.indexOf('--to')
const target = targetIndex >= 0 ? process.argv[targetIndex + 1] : 'auth-core'
const dryRun = args.has('--dry-run')

if (target !== 'auth-core') {
  console.error('Only --to auth-core is supported in Step 2')
  process.exitCode = 2
} else {
  try {
    const runtime = { mongo: validateMongoConfiguration(process.env) }
    const plan = dryRun
      ? buildAuthCoreMigration({ dryRun: true })
      : await (async () => {
        const context = await getMongoContext(runtime)
        return runAuthCoreMigration({ db: context.db })
      })()
    console.log(JSON.stringify({ migration: target, dryRun, operations: plan.length }))
  } catch {
    console.error('Migration failed: runtime_or_database_error')
    process.exitCode = 1
  } finally {
    await closeMongoConnection()
  }
}
