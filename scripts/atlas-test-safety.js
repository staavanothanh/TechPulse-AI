import { randomBytes } from 'node:crypto'

const TEST_DATABASE_PREFIX = 'techpulse_step2_test'
const ATLAS_DATABASE_MAX_BYTES = 38
const RESERVED_DATABASES = new Set(['admin', 'config', 'local'])
const SAFE_CHILD_ENV_KEYS = [
  'APPDATA', 'CI', 'COLORTERM', 'ComSpec', 'FORCE_COLOR', 'HOME', 'LOCALAPPDATA', 'NODE_OPTIONS',
  'NO_COLOR', 'Path', 'PATH', 'PATHEXT', 'SystemRoot', 'TEMP', 'TERM', 'TMP', 'USERPROFILE', 'WINDIR',
]

function required(value, message) {
  if (typeof value !== 'string' || value.trim() === '') throw new Error(message)
  return value.trim()
}

function assertDatabaseIdentifier(value, label) {
  const database = required(value, `${label} is required`)
  if (!/^[a-z0-9_]+$/.test(database) || Buffer.byteLength(database, 'utf8') >= 64) throw new Error(`${label} is invalid`)
  if (RESERVED_DATABASES.has(database)) throw new Error(`${label} is reserved`)
  return database
}

function assertTestDatabaseName(database, protectedDatabase) {
  const safeDatabase = assertDatabaseIdentifier(database, 'Atlas test database')
  if (Buffer.byteLength(safeDatabase, 'utf8') > ATLAS_DATABASE_MAX_BYTES) throw new Error('Atlas test database exceeds the 38-byte limit')
  if (protectedDatabase && safeDatabase === protectedDatabase) throw new Error('Atlas test database matches the protected database')
  if (!safeDatabase.startsWith(`${TEST_DATABASE_PREFIX}_`)) throw new Error('Atlas test database must use the Step 2 test prefix')
  return safeDatabase
}

function safeRunId(value) {
  const runId = value ?? randomBytes(4).readUInt32BE(0).toString(36).padStart(7, '0').slice(-5)
  if (typeof runId !== 'string' || !/^[a-z0-9]{5}$/.test(runId)) throw new Error('Atlas test run ID is invalid')
  return runId
}

export function createAtlasTestEnvironment({ environment = process.env, runId } = {}) {
  const uriEnvironmentName = required(environment.MONGODB_URI_ENV, 'MONGODB_URI_ENV is required')
  if (!/^[A-Z][A-Z0-9_]{1,127}$/.test(uriEnvironmentName)) throw new Error('MONGODB_URI_ENV is invalid')
  const uri = required(environment[uriEnvironmentName], 'Referenced MongoDB URI is not configured')
  const protectedDatabase = assertDatabaseIdentifier(environment.MONGODB_DATABASE, 'MONGODB_DATABASE')
  const testDatabaseBase = assertTestDatabaseName(`${TEST_DATABASE_PREFIX}_${safeRunId(runId)}`, protectedDatabase)
  const childEnvironment = {}
  for (const key of SAFE_CHILD_ENV_KEYS) if (environment[key] !== undefined) childEnvironment[key] = environment[key]
  childEnvironment.NODE_ENV = 'test'
  childEnvironment.MONGODB_TEST_URI = uri
  childEnvironment.MONGODB_TEST_DATABASE = testDatabaseBase
  childEnvironment.MONGODB_PROTECTED_DATABASE_NAME = protectedDatabase
  return { childEnvironment, testDatabaseBase }
}

export function databaseNameForSuite(suite, environment = process.env) {
  if (typeof suite !== 'string' || !/^[a-z][a-z0-9_]{0,31}$/.test(suite)) throw new Error('Atlas test suite name is invalid')
  const base = assertDatabaseIdentifier(environment.MONGODB_TEST_DATABASE ?? `${TEST_DATABASE_PREFIX}_local`, 'Atlas test database base')
  const protectedDatabase = environment.MONGODB_PROTECTED_DATABASE_NAME ?? environment.MONGODB_DATABASE
  if (protectedDatabase && base === protectedDatabase) throw new Error('Atlas test database base matches the protected database')
  return assertTestDatabaseName(`${base}_${suite}`, protectedDatabase)
}

export async function dropTestDatabase({ context, expectedDatabase, environment = process.env } = {}) {
  if (!context?.db?.dropDatabase || context.database !== expectedDatabase) throw new Error('Atlas test database cleanup target mismatch')
  const protectedDatabase = environment.MONGODB_PROTECTED_DATABASE_NAME ?? environment.MONGODB_DATABASE
  assertTestDatabaseName(expectedDatabase, protectedDatabase)
  return context.db.dropDatabase()
}

export function atlasTestArguments(mode) {
  if (mode === 'integration') return ['node_modules/vitest/vitest.mjs', 'run', 'test/integration']
  if (mode === 'full') return ['node_modules/vitest/vitest.mjs', 'run']
  if (mode === 'coverage') return ['node_modules/vitest/vitest.mjs', 'run', '--coverage']
  throw new Error('Atlas test mode must be integration, full or coverage')
}

export function redactAtlasOutput(value, uri) {
  let output = String(value ?? '')
  const tokens = new Set([uri])
  try {
    tokens.add(decodeURIComponent(uri))
    const parsed = new URL(uri)
    for (const token of [parsed.host, parsed.hostname, parsed.username, parsed.password]) {
      if (token) {
        tokens.add(token)
        try { tokens.add(decodeURIComponent(token)) } catch { /* invalid percent encoding remains covered by the raw token */ }
      }
    }
    if (parsed.pathname && parsed.pathname !== '/') {
      tokens.add(parsed.pathname)
      tokens.add(parsed.pathname.slice(1))
    }
    if (parsed.search) {
      tokens.add(parsed.search)
      tokens.add(parsed.search.slice(1))
      for (const [key, value] of parsed.searchParams) tokens.add(`${key}=${value}`)
    }
  } catch { /* the Mongo driver owns URI syntax validation; exact-string redaction still applies */ }
  for (const token of [...tokens].filter(Boolean).sort((left, right) => right.length - left.length)) output = output.split(token).join('[REDACTED]')
  return output
}

export const ATLAS_TEST_DATABASE_PREFIX = TEST_DATABASE_PREFIX
