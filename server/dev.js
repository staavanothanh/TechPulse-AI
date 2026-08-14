import { createServer } from 'node:http'
import { createServer as createViteServer } from 'vite'
import { configureDns } from '../scripts/configure-dns.js'
import { createDevViteOptions } from './dev-vite.js'

configureDns()

const port = Number(process.env.PORT || 3000)
const server = createServer()
const vite = await createViteServer(createDevViteOptions(server))

const { createApp } = await import('./app.js')
const { createConfiguredAuthService } = await import('./bootstrap/auth.js')
const { createConfiguredSourceService } = await import('./bootstrap/sources.js')
const { createConfiguredJobRuntime } = await import('./bootstrap/jobs.js')
const { createConfiguredContentServices } = await import('./bootstrap/content.js')
const { createConfiguredIndexingRuntime } = await import('./bootstrap/indexing.js')
const { createConfiguredQaService } = await import('./bootstrap/qa.js')
const { createConfiguredAdminGovernanceService } = await import('./bootstrap/admin.js')
const { createConfiguredProviderAdapters, ZEN_SUMMARY_TIMEOUT_MS } = await import('./ai/provider-adapters.js')
const { createSafeFetch } = await import('./infrastructure/http/safe-fetch.js')
const { createSourceTechnicalCheckAdapter } = await import('./infrastructure/http/source-technical-check.js')
const { createRateLimitAdmission } = await import('./security/rate-limit-admission.js')
const { closeMaintenanceMongoContext, getMaintenanceMongoContext } = await import('./maintenance/mongo-context.js')
let authService
let sourceService
let jobService
let dueWorkRunner
let maintenanceRunner
let articleService
let searchService
let savedService
let imageCspHosts
let indexingJobService
let queryEmbedding
let qaService
let adminGovernanceService
let accountDeletionService
let maintenanceContext
let runtime
try {
  const configured = await createConfiguredAuthService()
  authService = configured.authService
  runtime = configured.runtime
  const rateLimitAdmission = createRateLimitAdmission({ repository: configured.authRepository, keyring: configured.quotaKeyring })
  try {
    maintenanceContext = await getMaintenanceMongoContext({ runtimeConfig: configured.runtime, runtimeClient: configured.context.client })
    if (!maintenanceContext) console.warn('Audit IP-HMAC maintenance is unavailable until MONGODB_MAINTENANCE_URI_ENV is configured')
  } catch { console.warn('Audit IP-HMAC maintenance is unavailable until a separate maintenance credential is configured') }
  try {
    const governance = await createConfiguredAdminGovernanceService({ context: configured.context, rateLimitAdmission, quotaKeyring: configured.quotaKeyring, governanceKeyring: configured.governanceKeyring })
    adminGovernanceService = governance.adminGovernanceService
    accountDeletionService = governance.accountDeletionService
  } catch { console.warn('Admin governance service is unavailable until article/auth migrations are applied') }
  const technicalCheckAdapter = createSourceTechnicalCheckAdapter({ safeFetch: createSafeFetch() })
  try { sourceService = (await createConfiguredSourceService({ context: configured.context, technicalCheckAdapter, rateLimitAdmission })).sourceService } catch { console.warn('Source Registry service is unavailable until its migration is applied') }
  try {
    const jobs = await createConfiguredJobRuntime({ context: configured.context, rateLimitAdmission, quotaKeyring: configured.quotaKeyring, governanceKeyring: configured.governanceKeyring, maintenanceContext })
    jobService = jobs.jobService
    dueWorkRunner = jobs.dueWorkRunner
    maintenanceRunner = jobs.maintenanceRunner
    maintenanceContext = jobs.maintenanceContext ?? maintenanceContext
    let adapters
    let indexing = {}
    try {
      adapters = createConfiguredProviderAdapters({ registry: runtime.providerAdmissionDomains, summaryTimeoutMs: ZEN_SUMMARY_TIMEOUT_MS })
      indexing = await createConfiguredIndexingRuntime({ context: configured.context, jobRuntime: jobs, rateLimitAdmission, providerRegistry: runtime.providerAdmissionDomains, ...adapters })
      indexingJobService = indexing.indexingJobService
      queryEmbedding = indexing.queryEmbedding
    } catch { console.warn('Indexing service is unavailable until the Step 9 migration/provider configuration is ready') }
    try {
      adapters ??= createConfiguredProviderAdapters({ registry: runtime.providerAdmissionDomains, summaryTimeoutMs: ZEN_SUMMARY_TIMEOUT_MS })
      qaService = await createConfiguredQaService({ context: configured.context, providerRegistry: runtime.providerAdmissionDomains, providerAdapters: adapters, providerAdmission: indexing.providerAdmission, rateLimitAdmission, maintenanceRegistry: jobs.maintenanceRegistry })
    } catch { console.warn('Grounded Q&A service is unavailable until the Step 10 migration/provider configuration is ready') }
  } catch { console.warn('Durable job service is unavailable until its migration is applied') }
  try {
    const content = await createConfiguredContentServices({ context: configured.context, queryEmbedding })
    articleService = content.articleService
    searchService = content.searchService
    savedService = content.savedService
    imageCspHosts = content.imageCspHosts
  } catch { console.warn('Content service is unavailable until article migrations are applied') }
} catch {
  console.warn('Auth service is unavailable until MongoDB/runtime env is configured')
}
const app = createApp({ authService, sourceService, jobService, indexingJobService, dueWorkRunner, maintenanceRunner, articleService, searchService, savedService, qaService, adminGovernanceService, accountDeletionService, imageCspHosts, allowedOrigins: runtime?.origins?.join(','), machineSecretEnv: runtime?.internalMachineSecretEnv, afterApiMiddleware: vite.middlewares })
server.on('request', app)
server.listen(port, () => {
  console.log(`TechPulse local server listening on http://localhost:${port}`)
})

function shutdown(signal) {
  server.close(() => {
    vite.close().finally(async () => {
      try { await closeMaintenanceMongoContext(maintenanceContext) } catch { /* shutdown is best effort */ }
      process.exit(0)
    })
  })
  setTimeout(() => process.exit(1), 5000).unref()
  console.warn(`Received ${signal}; shutting down`)
}

process.once('SIGINT', () => shutdown('SIGINT'))
process.once('SIGTERM', () => shutdown('SIGTERM'))
