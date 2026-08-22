import { configureDns } from '../scripts/configure-dns.js'
import { createApp } from '../server/app.js'
import { createLazyRuntimeOptions } from '../server/bootstrap/lazy-runtime.js'
import { validateRuntimeConfiguration } from '../server/config/runtime.js'
import { normalizeRequestTarget } from '../server/http/ingress.js'

configureDns()

function httpRuntimeOptions() {
  try {
    const runtime = validateRuntimeConfiguration(process.env)
    return { allowedOrigins: runtime.origins.join(','), machineSecretEnv: runtime.internalMachineSecretEnv }
  } catch {
    return { allowedOrigins: '', machineSecretEnv: '__TECHPULSE_INVALID_RUNTIME__' }
  }
}

const app = createApp({ ...createLazyRuntimeOptions(), ...httpRuntimeOptions() })

export default function handler(request, response) {
  const normalizedUrl = normalizeRequestTarget(request.url)
  if (normalizedUrl !== request.url) request.url = normalizedUrl
  if (typeof request.originalUrl === 'string') {
    const normalizedOriginalUrl = normalizeRequestTarget(request.originalUrl)
    if (normalizedOriginalUrl !== request.originalUrl) request.originalUrl = normalizedOriginalUrl
  }
  return app(request, response)
}
