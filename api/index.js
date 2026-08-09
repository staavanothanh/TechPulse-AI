import { createApp } from '../server/app.js'
import { createConfiguredAuthService } from '../server/bootstrap/auth.js'

let appPromise
function loadApp() {
  if (!appPromise) {
    appPromise = createConfiguredAuthService().then(({ authService }) => createApp({ authService })).catch((_error) => {
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
