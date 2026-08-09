import { createServer as createViteServer } from 'vite'

const port = Number(process.env.PORT || 3000)
const vite = await createViteServer({
  server: { middlewareMode: true },
  appType: 'spa',
})

const { createApp } = await import('./app.js')
const app = createApp({ afterApiMiddleware: vite.middlewares })
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
