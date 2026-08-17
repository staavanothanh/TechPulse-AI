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
if (process.env.E2E_VERCEL_PROTECTION_HEADERS_JSON) {
  try {
    const headers = JSON.parse(process.env.E2E_VERCEL_PROTECTION_HEADERS_JSON)
    if (
      !headers ||
      Array.isArray(headers) ||
      typeof headers !== 'object' ||
      Object.entries(headers).some(([, value]) => typeof value !== 'string')
    )
      throw new Error('invalid headers')
  } catch {
    console.error('E2E_VERCEL_PROTECTION_HEADERS_JSON must be a JSON object with string values')
    process.exit(2)
  }
}

const child = spawn(
  process.execPath,
  ['./node_modules/vitest/vitest.mjs', 'run', 'test/e2e/vercel-host.test.js'],
  {
    stdio: 'inherit',
    env: { ...process.env, E2E_RUNNER_ENFORCE: 'true' },
    windowsHide: true,
  },
)
child.on('error', () => process.exit(1))
child.on('exit', (code, signal) => process.exit(signal ? 1 : (code ?? 1)))
