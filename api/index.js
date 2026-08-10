import { createApp } from '../server/app.js'
import { createConfiguredAuthService } from '../server/bootstrap/auth.js'
import { createConfiguredSourceService } from '../server/bootstrap/sources.js'

let appPromise
function loadApp() {
  if (!appPromise) {
    appPromise = createConfiguredAuthService().then(async ({ authService, context }) => {
      let sourceService
      try { sourceService = (await createConfiguredSourceService({ context })).sourceService } catch { console.error('Source Registry service is unavailable') }
      return createApp({ authService, sourceService })
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
