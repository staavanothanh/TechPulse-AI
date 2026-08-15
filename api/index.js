import { createApp } from '../server/app.js'
import { createConfiguredAuthService } from '../server/bootstrap/auth.js'
import { createConfiguredSourceService } from '../server/bootstrap/sources.js'
import { createConfiguredJobRuntime } from '../server/bootstrap/jobs.js'
import { createConfiguredContentServices } from '../server/bootstrap/content.js'
import { createConfiguredIndexingRuntime } from '../server/bootstrap/indexing.js'
import { createConfiguredQaService } from '../server/bootstrap/qa.js'
import { createConfiguredAdminGovernanceService } from '../server/bootstrap/admin.js'
import { createConfiguredProviderAdapters, DEFAULT_CHAT_TIMEOUT_MS } from '../server/ai/provider-adapters.js'
import { createSafeFetch } from '../server/infrastructure/http/safe-fetch.js'
import { createSourceTechnicalCheckAdapter } from '../server/infrastructure/http/source-technical-check.js'
import { createRateLimitAdmission } from '../server/security/rate-limit-admission.js'
import { createProductionJobRuntime } from '../server/maintenance/job-runtime.js'

let appPromise
function loadApp() {
  if (!appPromise) {
    appPromise = createConfiguredAuthService().then(async ({ authService, context, runtime, authRepository, quotaKeyring, governanceKeyring }) => {
      let sourceService
      let jobs
      let content = {}
      let qaService
      let adminGovernanceService
      let providerAdapters
      const rateLimitAdmission = createRateLimitAdmission({ repository: authRepository, keyring: quotaKeyring })
      const technicalCheckAdapter = createSourceTechnicalCheckAdapter({ safeFetch: createSafeFetch() })
      try { sourceService = (await createConfiguredSourceService({ context, technicalCheckAdapter, rateLimitAdmission })).sourceService } catch { console.error('Source Registry service is unavailable') }
      jobs = (await createProductionJobRuntime({
        runtimeConfig: runtime,
        jobOptions: { context, rateLimitAdmission, quotaKeyring, governanceKeyring },
        createJobRuntime: createConfiguredJobRuntime,
      })).jobs
      let indexing = {}
      if (jobs.queueRegistry) {
        try {
          providerAdapters = createConfiguredProviderAdapters({ registry: runtime.providerRegistry, summaryTimeoutMs: DEFAULT_CHAT_TIMEOUT_MS })
          indexing = await createConfiguredIndexingRuntime({ context, jobRuntime: jobs, rateLimitAdmission, providerRegistry: runtime.providerRegistry, ...providerAdapters })
        } catch { console.error('Indexing service is unavailable') }
      }
      try {
        providerAdapters ??= createConfiguredProviderAdapters({ registry: runtime.providerRegistry, summaryTimeoutMs: DEFAULT_CHAT_TIMEOUT_MS })
        qaService = await createConfiguredQaService({ context, providerRegistry: runtime.providerRegistry, providerAdapters, providerAdmission: indexing.providerAdmission, queryEmbedding: indexing.queryEmbedding, rateLimitAdmission, maintenanceRegistry: jobs.maintenanceRegistry })
      } catch { console.error('Grounded Q&A service is unavailable') }
      try { content = await createConfiguredContentServices({ context, queryEmbedding: indexing.queryEmbedding }) } catch { console.error('Content service is unavailable') }
      let accountDeletionService
      try {
        const governance = await createConfiguredAdminGovernanceService({ context, rateLimitAdmission, quotaKeyring, governanceKeyring })
        adminGovernanceService = governance.adminGovernanceService
        accountDeletionService = governance.accountDeletionService
      } catch { console.error('Admin governance service is unavailable') }
      return createApp({
        authService, sourceService, jobService: jobs.jobService, indexingJobService: indexing.indexingJobService, dueWorkRunner: jobs.dueWorkRunner, maintenanceRunner: jobs.maintenanceRunner,
        articleService: content.articleService, searchService: content.searchService, savedService: content.savedService, qaService, adminGovernanceService, accountDeletionService,
        imageCspHosts: content.imageCspHosts,
        allowedOrigins: runtime.origins.join(','), machineSecretEnv: runtime.internalMachineSecretEnv,
      })
    }).catch((_error) => {
      console.error('Auth service is unavailable')
      appPromise = null
      return createApp()
    })
  }
  return appPromise
}

export default async function handler(request, response) {
  const app = await loadApp()
  return app(request, response)
}
