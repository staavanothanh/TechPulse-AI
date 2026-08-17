import { spawn } from 'node:child_process'

const required = ['E2E_BASE_URL', 'E2E_CRON_SECRET']
const missing = required.filter((name) => !process.env[name])
if (process.env.E2E_VERCEL_ENABLED !== 'true') {
  console.error(
    'Vercel Preview E2E is disabled. Set E2E_VERCEL_ENABLED=true before running this command',
  )
  process.exit(2)
}
if (missing.length > 0) {
  console.error(`Vercel Preview E2E credentials are missing: ${missing.join(', ')}`)
  process.exit(2)
}
if (!/^https:\/\//.test(process.env.E2E_BASE_URL)) {
  console.error(
    'Vercel Preview E2E requires an HTTPS E2E_BASE_URL; localhost belongs to test:e2e:local',
  )
  process.exit(2)
}

const child = spawn(
  process.execPath,
  ['./node_modules/vitest/vitest.mjs', 'run', 'test/e2e/vercel-host.test.js'],
  { stdio: 'inherit', env: process.env, windowsHide: true },
)
child.on('error', () => process.exit(1))
child.on('exit', (code, signal) => process.exit(signal ? 1 : (code ?? 1)))
