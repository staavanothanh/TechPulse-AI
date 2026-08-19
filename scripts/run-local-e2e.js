import { spawn } from 'node:child_process'
import { validateLocalE2eEndpoints } from './local-e2e-config.js'

const required = [
  'E2E_USER_EMAIL',
  'E2E_USER_PASSWORD',
  'E2E_ADMIN_EMAIL',
  'E2E_ADMIN_PASSWORD',
  'E2E_DEMO_SOURCE_ID',
  'E2E_DEMO_ARTICLE_ID',
  'E2E_SEARCH_QUERY',
]
const missing = required.filter((name) => !process.env[name])
if (process.env.E2E_ENABLED !== 'true') {
  console.error('Local E2E is disabled. Set E2E_ENABLED=true before running npm run test:e2e:local')
  process.exit(2)
}
if (missing.length > 0) {
  console.error(`Local E2E required inputs are missing: ${missing.join(', ')}`)
  process.exit(2)
}
let localEndpoints
try {
  localEndpoints = validateLocalE2eEndpoints({ baseUrl: process.env.E2E_BASE_URL, origin: process.env.E2E_ORIGIN })
} catch (error) {
  console.error(error instanceof Error ? error.message : 'Local E2E endpoint configuration is invalid')
  process.exit(2)
}
const objectIdPattern = /^[0-9a-f]{24}$/i
for (const name of ['E2E_DEMO_SOURCE_ID', 'E2E_DEMO_ARTICLE_ID']) {
  if (!objectIdPattern.test(process.env[name])) {
    console.error(`${name} must be a 24-character Mongo ObjectId from the deterministic demo seed`)
    process.exit(2)
  }
}
if (process.env.E2E_SEARCH_QUERY.trim().length < 2) {
  console.error('E2E_SEARCH_QUERY must contain at least two non-whitespace characters')
  process.exit(2)
}
if (process.env.E2E_GOVERNANCE_MUTATIONS === 'true') {
  const governanceRequired = [
    'E2E_DELETION_EMAIL',
    'E2E_DELETION_PASSWORD',
    'E2E_DELETION_CONFIRM_EMAIL',
    'E2E_TAKEDOWN_ARTICLE_ID',
  ]
  const governanceMissing = governanceRequired.filter((name) => !process.env[name])
  if (governanceMissing.length > 0) {
    console.error(`Governance E2E credentials/data are missing: ${governanceMissing.join(', ')}`)
    process.exit(2)
  }
  if (!objectIdPattern.test(process.env.E2E_TAKEDOWN_ARTICLE_ID)) {
    console.error('E2E_TAKEDOWN_ARTICLE_ID must be a 24-character Mongo ObjectId')
    process.exit(2)
  }
  const normalized = (value) => value.trim().toLowerCase()
  const deletionEmail = normalized(process.env.E2E_DELETION_EMAIL)
  const confirmationEmail = normalized(process.env.E2E_DELETION_CONFIRM_EMAIL)
  const protectedEmails = new Set(
    [process.env.E2E_USER_EMAIL, process.env.E2E_ADMIN_EMAIL].map(normalized),
  )
  if (confirmationEmail !== deletionEmail) {
    console.error('E2E_DELETION_CONFIRM_EMAIL must exactly match E2E_DELETION_EMAIL')
    process.exit(2)
  }
  if (protectedEmails.has(deletionEmail)) {
    console.error('E2E_DELETION_EMAIL must be distinct from E2E_USER_EMAIL and E2E_ADMIN_EMAIL')
    process.exit(2)
  }
  if (
    process.env.E2E_TAKEDOWN_ARTICLE_ID.toLowerCase() !==
    process.env.E2E_DEMO_ARTICLE_ID.toLowerCase()
  ) {
    console.error(
      'E2E_TAKEDOWN_ARTICLE_ID must equal E2E_DEMO_ARTICLE_ID for deterministic governance E2E',
    )
    process.exit(2)
  }
}

const child = spawn(
  process.execPath,
  ['./node_modules/vitest/vitest.mjs', 'run', 'test/e2e/local-host.test.js'],
  {
    stdio: 'inherit',
    env: { ...process.env, E2E_BASE_URL: localEndpoints.baseUrl, E2E_ORIGIN: localEndpoints.origin, E2E_REQUIRE_ARTICLES: 'true', E2E_RUNNER_ENFORCE: 'true' },
    windowsHide: true,
  },
)
child.on('error', () => process.exit(1))
child.on('exit', (code, signal) => process.exit(signal ? 1 : (code ?? 1)))
