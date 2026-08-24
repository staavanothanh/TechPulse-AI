import { validateMongoConfiguration } from '../server/config/runtime.js'
import { getMongoContext, closeMongoConnection } from '../server/repositories/mongo/connection.js'
import { buildAuthCoreMigration } from './migrations/auth-core.js'
import { buildSourcesMigration } from './migrations/sources.js'
import { buildDurableJobsMigration } from './migrations/durable-jobs.js'
import { buildArticlesMigration, runArticlesMigration } from './migrations/articles.js'
import { buildIndexingJobsMigration, runIndexingJobsMigration } from './migrations/indexing-jobs.js'
import {
  assertMigrationTargetDoesNotDowngradeProviderRoutingV2,
  buildProviderRoutingV2Migration,
  runProviderRoutingV2Migration,
} from './migrations/provider-routing-v2.js'
import { buildChatSessionsMigration, runChatSessionsMigration } from './migrations/chat-sessions.js'
import { buildGovernanceMigration, buildGovernanceDatabaseMigration, runGovernanceMigration, runGovernanceDatabaseMigration } from './migrations/governance.js'
import { buildGovernanceHardeningMigration, runGovernanceHardeningMigration } from './migrations/governance-hardening.js'
import { buildGovernanceCapabilityProbeMigration, runGovernanceCapabilityProbeMigration } from './migrations/governance-capability-probes.js'
import { buildGovernanceRetentionHardeningMigration, runGovernanceRetentionHardeningMigration } from './migrations/governance-retention-hardening.js'
import { buildArticleGovernanceHardeningMigration, runArticleGovernanceHardeningMigration } from './migrations/article-governance-hardening.js'
import { buildAdminPerformanceIndexesMigration, runAdminPerformanceIndexesMigration } from './migrations/admin-performance-indexes.js'
import { buildIndexingDrainPerformanceMigration, runIndexingDrainPerformanceMigration } from './migrations/indexing-drain-performance.js'
import { buildQaEvidenceFenceMigration, runQaEvidenceFenceMigration } from './migrations/qa-evidence-fence.js'
import {
  runAuthCoreWithStep4Compatibility,
  runDurableJobsWithStep4Compatibility,
  runSourcesWithStep4Compatibility,
} from './migrations/step4-compatibility.js'
import { configureDns } from './configure-dns.js'
import { migrationUriEnvName } from './migration-credential.js'

configureDns()

const args = new Set(process.argv.slice(2))
const targetIndex = process.argv.indexOf('--to')
const target = targetIndex >= 0 ? process.argv[targetIndex + 1] : 'auth-core'
const dryRun = args.has('--dry-run')

if (!['auth-core', 'sources', 'durable-jobs', 'articles', 'indexing-jobs', 'indexing-drain-performance', 'provider-routing-v2', 'chat-sessions', 'qa-evidence-fence', 'governance'].includes(target)) {
  console.error(
    'Supported migration targets: auth-core, sources, durable-jobs, articles, indexing-jobs, indexing-drain-performance, provider-routing-v2, chat-sessions, qa-evidence-fence, governance',
  )
  process.exitCode = 2
} else {
  try {
    const runtime = {
      mongo: validateMongoConfiguration({
        ...process.env,
        // Every migration target mutates schema and therefore must use the
        // separately scoped operator credential.  Runtime credentials are
        // intentionally reserved for read/probe verification in db-verify.
        MONGODB_URI_ENV: migrationUriEnvName(target),
      }),
    }
    const buildMigration =
      target === 'sources'
        ? buildSourcesMigration
        : target === 'durable-jobs'
          ? buildDurableJobsMigration
          : target === 'articles'
            ? buildArticlesMigration
          : target === 'indexing-jobs'
              ? buildIndexingJobsMigration
              : target === 'indexing-drain-performance'
                ? buildIndexingDrainPerformanceMigration
              : target === 'provider-routing-v2'
                ? buildProviderRoutingV2Migration
              : target === 'chat-sessions'
                ? buildChatSessionsMigration
              : target === 'qa-evidence-fence'
                ? buildQaEvidenceFenceMigration
              : target === 'governance'
                ? buildGovernanceMigration
                : buildAuthCoreMigration
    const runMigration =
      target === 'sources'
        ? runSourcesWithStep4Compatibility
        : target === 'durable-jobs'
          ? runDurableJobsWithStep4Compatibility
          : target === 'articles'
            ? runArticlesMigration
          : target === 'indexing-jobs'
              ? runIndexingJobsMigration
              : target === 'indexing-drain-performance'
                ? runIndexingDrainPerformanceMigration
              : target === 'provider-routing-v2'
                ? runProviderRoutingV2Migration
              : target === 'chat-sessions'
                ? runChatSessionsMigration
              : target === 'qa-evidence-fence'
                ? runQaEvidenceFenceMigration
              : target === 'governance'
                ? runGovernanceMigration
                : runAuthCoreWithStep4Compatibility
    const plan = dryRun
      ? target === 'governance'
        ? [
            ...buildMigration({ dryRun: true }).map((operation) => ({ ...operation, database: 'techpulse_app' })),
            ...buildGovernanceHardeningMigration({ dryRun: true }).map((operation) => ({ ...operation, database: 'techpulse_app' })),
            ...buildGovernanceRetentionHardeningMigration({ dryRun: true }).map((operation) => ({ ...operation, database: 'techpulse_app' })),
            ...buildArticleGovernanceHardeningMigration({ dryRun: true }).map((operation) => ({ ...operation, database: 'techpulse_app' })),
            ...buildAdminPerformanceIndexesMigration({ dryRun: true }).map((operation) => ({ ...operation, database: 'techpulse_app' })),
            ...buildProviderRoutingV2Migration({ dryRun: true }).map((operation) => ({ ...operation, database: 'techpulse_app' })),
            ...buildQaEvidenceFenceMigration({ dryRun: true }).map((operation) => ({ ...operation, database: 'techpulse_app' })),
            ...buildGovernanceCapabilityProbeMigration({ dryRun: true }).map((operation) => ({ ...operation, database: 'techpulse_app' })),
            ...buildGovernanceDatabaseMigration({ dryRun: true }).map((operation) => ({ ...operation, database: 'techpulse_governance' })),
            ...buildGovernanceCapabilityProbeMigration({ dryRun: true }).map((operation) => ({ ...operation, database: 'techpulse_governance' })),
          ]
        : target === 'provider-routing-v2'
          ? [...buildMigration({ dryRun: true }), ...buildQaEvidenceFenceMigration({ dryRun: true })]
          : buildMigration({ dryRun: true })
      : await (async () => {
          const context = await getMongoContext(runtime)
          await assertMigrationTargetDoesNotDowngradeProviderRoutingV2({ db: context.db, target })
          const plan = await runMigration({ db: context.db })
          if (target === 'governance') {
            plan.push(...await runGovernanceHardeningMigration({ db: context.db }))
            plan.push(...await runGovernanceRetentionHardeningMigration({ db: context.db }))
            plan.push(...await runArticleGovernanceHardeningMigration({ db: context.db }))
            plan.push(...await runAdminPerformanceIndexesMigration({ db: context.db }))
            plan.push(...await runProviderRoutingV2Migration({ db: context.db }))
            plan.push(...await runQaEvidenceFenceMigration({ db: context.db }))
            plan.push(...await runGovernanceCapabilityProbeMigration({ db: context.db }))
            const governanceDb = context.client.db('techpulse_governance')
            await runGovernanceDatabaseMigration({ db: governanceDb })
            plan.push(...await runGovernanceCapabilityProbeMigration({ db: governanceDb }))
          } else if (target === 'provider-routing-v2') {
            plan.push(...await runQaEvidenceFenceMigration({ db: context.db }))
          }
          return plan
        })()
    console.log(JSON.stringify({ migration: target, dryRun, operations: plan.length }))
  } catch {
    console.error('Migration failed: runtime_or_database_error')
    process.exitCode = 1
  } finally {
    await closeMongoConnection()
  }
}
