import { createServer as createViteServer } from 'vite'
import { configureDns } from '../scripts/configure-dns.js'

configureDns()

const port = Number(process.env.PORT || 3000)
const vite = await createViteServer({
  server: { middlewareMode: true },
  appType: 'spa',
})

const { createApp } = await import('./app.js')
const { createConfiguredAuthService } = await import('./bootstrap/auth.js')
const { createConfiguredSourceService } = await import('./bootstrap/sources.js')
const { createConfiguredJobRuntime } = await import('./bootstrap/jobs.js')
const { createConfiguredContentServices } = await import('./bootstrap/content.js')
const { createSafeFetch } = await import('./infrastructure/http/safe-fetch.js')
const { createSourceTechnicalCheckAdapter } = await import('./infrastructure/http/source-technical-check.js')
const { createRateLimitAdmission } = await import('./security/rate-limit-admission.js')
let authService
let sourceService
let jobService
let dueWorkRunner
let maintenanceRunner
let articleService
let searchService
let savedService
let imageCspHosts
let runtime
try {
  const configured = await createConfiguredAuthService()
  authService = configured.authService
  runtime = configured.runtime
  const rateLimitAdmission = createRateLimitAdmission({ repository: configured.authRepository, keyring: configured.quotaKeyring })
  const technicalCheckAdapter = createSourceTechnicalCheckAdapter({ safeFetch: createSafeFetch() })
  try { sourceService = (await createConfiguredSourceService({ context: configured.context, technicalCheckAdapter, rateLimitAdmission })).sourceService } catch { console.warn('Source Registry service is unavailable until its migration is applied') }
  try {
    const jobs = await createConfiguredJobRuntime({ context: configured.context, rateLimitAdmission })
    jobService = jobs.jobService
    dueWorkRunner = jobs.dueWorkRunner
    maintenanceRunner = jobs.maintenanceRunner
  } catch { console.warn('Durable job service is unavailable until its migration is applied') }
  try {
    const content = await createConfiguredContentServices({ context: configured.context })
    articleService = content.articleService
    searchService = content.searchService
    savedService = content.savedService
    imageCspHosts = content.imageCspHosts
  } catch { console.warn('Content service is unavailable until article migrations are applied') }
} catch {
  console.warn('Auth service is unavailable until MongoDB/runtime env is configured')
}
const app = createApp({ authService, sourceService, jobService, dueWorkRunner, maintenanceRunner, articleService, searchService, savedService, imageCspHosts, allowedOrigins: runtime?.origins?.join(','), machineSecretEnv: runtime?.internalMachineSecretEnv, afterApiMiddleware: vite.middlewares })
const server = app.listen(port, () => {
  console.log(`TechPulse local server listening on http://localhost:${port}`)
})

function shutdown(signal) {
  server.close(() => {
    vite.close().finally(() => process.exit(0))
  })
  setTimeout(() => process.exit(1), 5000).unref()
  console.warn(`Received ${signal}; shutting down`)
}

process.once('SIGINT', () => shutdown('SIGINT'))
process.once('SIGTERM', () => shutdown('SIGTERM'))
