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
import {
  assertChatSessionsSourceNameMigrationSafe,
  buildChatSessionsSourceNameMigration,
  runChatSessionsSourceNameMigration,
} from './migrations/chat-sessions-source-name-v1.js'
import { buildGovernanceMigration, buildGovernanceDatabaseMigration, runGovernanceMigration, runGovernanceDatabaseMigration } from './migrations/governance.js'
import { buildGovernanceHardeningMigration, runGovernanceHardeningMigration } from './migrations/governance-hardening.js'
import { buildGovernanceCapabilityProbeMigration, runGovernanceCapabilityProbeMigration } from './migrations/governance-capability-probes.js'
import { buildGovernanceRetentionHardeningMigration, runGovernanceRetentionHardeningMigration } from './migrations/governance-retention-hardening.js'
import { buildArticleGovernanceHardeningMigration, runArticleGovernanceHardeningMigration } from './migrations/article-governance-hardening.js'
import { buildAdminPerformanceIndexesMigration, runAdminPerformanceIndexesMigration } from './migrations/admin-performance-indexes.js'
import { buildIndexingDrainPerformanceMigration, runIndexingDrainPerformanceMigration } from './migrations/indexing-drain-performance.js'
import { buildQaEvidenceFenceMigration, runQaEvidenceFenceMigration } from './migrations/qa-evidence-fence.js'
import { buildSummaryDetailV1Migration, runSummaryDetailV1Migration } from './migrations/summary-detail-v1.js'
import { buildCronObservabilityMigration, runCronObservabilityMigration } from './migrations/cron-observability.js'
import {
  runAuthCoreWithStep4Compatibility,
  runDurableJobsWithStep4Compatibility,
  runSourcesWithStep4Compatibility,
} from './migrations/step4-compatibility.js'
import { configureDns } from './configure-dns.js'
import { migrationUriEnvName } from './migration-credential.js'
import { buildGoogleOAuthMigration, runGoogleOAuthMigration, withGoogleOAuthAuditCompatibility } from './migrations/google-oauth.js'
import { buildTopicTaxonomyMigration, runTopicTaxonomyMigration } from './migrations/topic-taxonomy-v1.js'
import { SOURCE_POLICY_RECONCILIATION_AUDIT_VALIDATOR, buildSourcePolicyReconciliationMigration, runSourcePolicyReconciliationMigration } from './migrations/source-policy-reconciliation.js'

configureDns()
function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`
  return JSON.stringify(value)
}

async function preservedSourcePolicyAuditValidator(db) {
  const collections = await db.listCollections({ name: /^adminAuditLogs$/ }, { nameOnly: false }).toArray()
  const current = collections.find((collection) => collection.name === 'adminAuditLogs')?.options?.validator
  return stableJson(current) === stableJson(SOURCE_POLICY_RECONCILIATION_AUDIT_VALIDATOR) ? SOURCE_POLICY_RECONCILIATION_AUDIT_VALIDATOR : undefined
}

const args = new Set(process.argv.slice(2))
const targetIndex = process.argv.indexOf('--to')
const target = targetIndex >= 0 ? process.argv[targetIndex + 1] : 'auth-core'
const dryRun = args.has('--dry-run')
const summaryDetailWriterMode = args.has('--writers-paused') ? 'paused' : undefined
if (!['auth-core', 'sources', 'durable-jobs', 'articles', 'indexing-jobs', 'indexing-drain-performance', 'provider-routing-v2', 'chat-sessions', 'chat-sessions-source-name-v1', 'qa-evidence-fence', 'summary-detail-v1', 'governance', 'google-oauth', 'topic-taxonomy-v1', 'source-policy-reconciliation', 'cron-observability'].includes(target)) {
  console.error(
    'Supported migration targets: auth-core, sources, durable-jobs, articles, indexing-jobs, indexing-drain-performance, provider-routing-v2, chat-sessions, chat-sessions-source-name-v1, qa-evidence-fence, summary-detail-v1, governance, google-oauth, topic-taxonomy-v1, source-policy-reconciliation, cron-observability',
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
              : target === 'summary-detail-v1'
                ? buildSummaryDetailV1Migration
              : target === 'chat-sessions-source-name-v1'
                ? buildChatSessionsSourceNameMigration
              : target === 'cron-observability'
                ? buildCronObservabilityMigration
              : target === 'governance'
                ? buildGovernanceMigration
              : target === 'google-oauth'
                ? buildGoogleOAuthMigration
              : target === 'topic-taxonomy-v1'
                ? buildTopicTaxonomyMigration
              : target === 'source-policy-reconciliation'
                ? buildSourcePolicyReconciliationMigration
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
              : target === 'summary-detail-v1'
                ? runSummaryDetailV1Migration
              : target === 'cron-observability'
                ? runCronObservabilityMigration
              : target === 'governance'
                ? runGovernanceMigration
              : target === 'chat-sessions-source-name-v1'
                ? runChatSessionsSourceNameMigration
              : target === 'google-oauth'
                ? runGoogleOAuthMigration
              : target === 'topic-taxonomy-v1'
                ? runTopicTaxonomyMigration
              : target === 'source-policy-reconciliation'
                ? runSourcePolicyReconciliationMigration
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
            ...buildGoogleOAuthMigration({ dryRun: true }).map((operation) => ({ ...operation, database: 'techpulse_app' })),
            ...buildGovernanceDatabaseMigration({ dryRun: true }).map((operation) => ({ ...operation, database: 'techpulse_governance' })),
            ...buildGovernanceCapabilityProbeMigration({ dryRun: true }).map((operation) => ({ ...operation, database: 'techpulse_governance' })),
          ]
          : target === 'provider-routing-v2'
          ? [...buildMigration({ dryRun: true }), ...buildQaEvidenceFenceMigration({ dryRun: true })]
          : buildMigration({ dryRun: true })
      : await (async () => {
          const context = await getMongoContext(runtime)
          await assertMigrationTargetDoesNotDowngradeProviderRoutingV2({ db: context.db, target })
          await assertChatSessionsSourceNameMigrationSafe({ db: context.db, target })
          const auditValidator = ['governance', 'google-oauth'].includes(target) ? await preservedSourcePolicyAuditValidator(context.db) : undefined
          const appDb = target === 'governance' ? withGoogleOAuthAuditCompatibility(context.db, auditValidator ? { auditValidator } : {}) : context.db
          const plan = await runMigration({ db: appDb, ...(auditValidator ? { auditValidator } : {}), ...(['summary-detail-v1', 'topic-taxonomy-v1'].includes(target) ? { writerMode: summaryDetailWriterMode } : {}) })
          if (target === 'governance') {
            plan.push(...await runGovernanceHardeningMigration({ db: appDb }))
            plan.push(...await runGovernanceRetentionHardeningMigration({ db: appDb }))
            plan.push(...await runArticleGovernanceHardeningMigration({ db: appDb }))
            plan.push(...await runAdminPerformanceIndexesMigration({ db: appDb }))
            plan.push(...await runProviderRoutingV2Migration({ db: appDb }))
            plan.push(...await runQaEvidenceFenceMigration({ db: appDb }))
            plan.push(...await runGovernanceCapabilityProbeMigration({ db: appDb }))
            plan.push(...await runGoogleOAuthMigration({ db: context.db, ...(auditValidator ? { auditValidator } : {}) }))
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
