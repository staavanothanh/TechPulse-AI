import { createApp } from '../server/app.js'
import { createConfiguredAuthService } from '../server/bootstrap/auth.js'
import { createConfiguredSourceService } from '../server/bootstrap/sources.js'
import { createConfiguredJobRuntime } from '../server/bootstrap/jobs.js'
import { createConfiguredContentServices } from '../server/bootstrap/content.js'
import { createConfiguredIndexingRuntime } from '../server/bootstrap/indexing.js'
import { createConfiguredProviderAdapters, ZEN_SUMMARY_TIMEOUT_MS } from '../server/ai/provider-adapters.js'
import { createSafeFetch } from '../server/infrastructure/http/safe-fetch.js'
import { createSourceTechnicalCheckAdapter } from '../server/infrastructure/http/source-technical-check.js'
import { createRateLimitAdmission } from '../server/security/rate-limit-admission.js'

let appPromise
function loadApp() {
  if (!appPromise) {
    appPromise = createConfiguredAuthService().then(async ({ authService, context, runtime, authRepository, quotaKeyring }) => {
      let sourceService
      let jobs = {}
      let content = {}
      const rateLimitAdmission = createRateLimitAdmission({ repository: authRepository, keyring: quotaKeyring })
      const technicalCheckAdapter = createSourceTechnicalCheckAdapter({ safeFetch: createSafeFetch() })
      try { sourceService = (await createConfiguredSourceService({ context, technicalCheckAdapter, rateLimitAdmission })).sourceService } catch { console.error('Source Registry service is unavailable') }
      try { jobs = await createConfiguredJobRuntime({ context, rateLimitAdmission }) } catch { console.error('Durable job service is unavailable') }
      let indexing = {}
      if (jobs.queueRegistry) {
        try {
          const adapters = createConfiguredProviderAdapters({ registry: runtime.providerAdmissionDomains, summaryTimeoutMs: ZEN_SUMMARY_TIMEOUT_MS })
          indexing = await createConfiguredIndexingRuntime({ context, jobRuntime: jobs, rateLimitAdmission, providerRegistry: runtime.providerAdmissionDomains, ...adapters })
        } catch { console.error('Indexing service is unavailable') }
      }
      try { content = await createConfiguredContentServices({ context, queryEmbedding: indexing.queryEmbedding }) } catch { console.error('Content service is unavailable') }
      return createApp({
        authService, sourceService, jobService: jobs.jobService, indexingJobService: indexing.indexingJobService, dueWorkRunner: jobs.dueWorkRunner, maintenanceRunner: jobs.maintenanceRunner,
        articleService: content.articleService, searchService: content.searchService, savedService: content.savedService,
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
