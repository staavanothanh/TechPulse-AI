import { spawn } from 'node:child_process'

const required = ['E2E_USER_EMAIL', 'E2E_USER_PASSWORD', 'E2E_ADMIN_EMAIL', 'E2E_ADMIN_PASSWORD']
const missing = required.filter((name) => !process.env[name])
if (process.env.E2E_ENABLED !== 'true') {
  console.error('Local E2E is disabled. Set E2E_ENABLED=true before running npm run test:e2e:local')
  process.exit(2)
}
if (missing.length > 0) {
  console.error(`Local E2E credentials are missing: ${missing.join(', ')}`)
  process.exit(2)
}

const child = spawn(
  process.execPath,
  ['./node_modules/vitest/vitest.mjs', 'run', 'test/e2e/local-host.test.js'],
  { stdio: 'inherit', env: process.env, windowsHide: true },
)
child.on('error', () => process.exit(1))
child.on('exit', (code, signal) => process.exit(signal ? 1 : (code ?? 1)))
