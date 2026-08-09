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
let authService
try {
  authService = (await createConfiguredAuthService()).authService
} catch {
  console.warn('Auth service is unavailable until MongoDB/runtime env is configured')
}
const app = createApp({ authService, afterApiMiddleware: vite.middlewares })
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
