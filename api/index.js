import { configureDns } from '../scripts/configure-dns.js'
import { createApp } from '../server/app.js'
import { createLazyRuntimeOptions } from '../server/bootstrap/lazy-runtime.js'
import { validateRuntimeConfiguration } from '../server/config/runtime.js'

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
  return app(request, response)
}
