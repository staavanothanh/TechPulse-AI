import { pathToFileURL } from 'node:url'
import { ObjectId } from 'mongodb'
import { createAuditEvent } from '../server/audit/writer.js'
import { assertAuthCoreReady } from '../server/bootstrap/auth.js'
import { validateMongoConfiguration } from '../server/config/runtime.js'
import { MongoAuthRepository } from '../server/repositories/mongo/auth-repository.js'
import { closeMongoConnection, getMongoContext } from '../server/repositories/mongo/connection.js'
import { hashPassword, verifyPassword } from '../server/security/password.js'
import { configureDns } from './configure-dns.js'

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
const ENV_NAME_PATTERN = /^[A-Z][A-Z0-9_]{2,127}$/
const RESERVED_DISPOSABLE_DOMAINS = new Set([
  'example.com',
  'example.net',
  'example.org',
  'invalid',
  'localhost',
  'test',
])

function isDisposableEmail(email) {
  const domain = email.slice(email.lastIndexOf('@') + 1)
  return RESERVED_DISPOSABLE_DOMAINS.has(domain) || [...RESERVED_DISPOSABLE_DOMAINS].some((suffix) => domain.endsWith(`.${suffix}`))
}

function normalizeEmail(value, { allowNonDisposable = false } = {}) {
  if (typeof value !== 'string') throw new Error('E2E_DELETION_EMAIL is required')
  const email = value.trim().toLowerCase()
  if (!EMAIL_PATTERN.test(email) || email.length > 254) throw new Error('E2E_DELETION_EMAIL is invalid')
  if (!allowNonDisposable && !isDisposableEmail(email)) throw new Error('E2E_DELETION_EMAIL must use a disposable test domain or E2E_SEED_CONFIRM=true')
  return email
}

export function buildE2eUserInput({ email, password, allowNonDisposable = false } = {}) {
  const emailNormalized = normalizeEmail(email, { allowNonDisposable })
  if (typeof password !== 'string' || password.length < 10 || password.length > 128) throw new Error('E2E_DELETION_PASSWORD is invalid')
  return { emailNormalized, emailDisplay: email.trim(), password }
}

export function parseSeedMode(args = []) {
  const values = Array.isArray(args) ? args : []
  if (values.length > 1 || (values.length === 1 && values[0] !== '--apply')) throw new Error('unknown seed option')
  return { apply: values[0] === '--apply' }
}

function nowDate(value) {
  return value instanceof Date ? value : new Date(value ?? Date.now())
}

export async function seedE2eUser({ repository, email, password, apply = false, now = new Date(), allowNonDisposable = false } = {}) {
  const input = buildE2eUserInput({ email, password, allowNonDisposable })
  if (!apply) return { dryRun: true, eligible: true }
  if (!repository?.withTransaction || !repository.findUserByEmail || !repository.createUser || !repository.insertAudit) throw new Error('E2E user repository is incomplete')
  const createdAt = nowDate(now)
  return repository.withTransaction(async (session) => {
    const options = { session }
    const existing = await repository.findUserByEmail(input.emailNormalized, options)
    if (existing) {
      if (existing.role !== 'user' || existing.status !== 'active') throw new Error('E2E seed requires an active user account')
      if (!(await verifyPassword(input.password, existing.passwordHash))) throw new Error('E2E seed password does not match the existing user')
      return { seeded: false, existing: true }
    }
    const user = await repository.createUser({
      _id: new ObjectId(),
      emailNormalized: input.emailNormalized,
      emailDisplay: input.emailDisplay,
      passwordHash: await hashPassword(input.password),
      role: 'user',
      status: 'active',
      topicPreferences: [],
      sessionVersion: 0,
      createdAt,
      updatedAt: createdAt,
    }, options)
    const audit = createAuditEvent({
      actor: user,
      action: 'user_registered',
      targetId: user._id,
      changedFields: ['status'],
      reasonCode: 'user_registered',
      request: { serverRequestId: `seed:e2e-user:${user._id.toHexString()}` },
      result: 'succeeded',
    })
    await repository.insertAudit(audit, options)
    return { seeded: true, existing: false }
  })
}

async function main() {
  configureDns()
  try {
    const mode = parseSeedMode(process.argv.slice(2))
    const allowNonDisposable = process.env.E2E_SEED_CONFIRM === 'true'
    const input = buildE2eUserInput({ email: process.env.E2E_DELETION_EMAIL, password: process.env.E2E_DELETION_PASSWORD, allowNonDisposable })
    if (!mode.apply) {
      console.log(JSON.stringify({ dryRun: true, eligible: true }))
      return
    }
    const operatorUriEnv = process.env.MONGODB_OPERATOR_URI_ENV
    if (typeof operatorUriEnv !== 'string' || !ENV_NAME_PATTERN.test(operatorUriEnv) || typeof process.env[operatorUriEnv] !== 'string' || process.env[operatorUriEnv].length === 0) throw new Error('operator credential is required')
    const runtime = { mongo: validateMongoConfiguration({ ...process.env, MONGODB_URI_ENV: operatorUriEnv }) }
    const context = await getMongoContext(runtime, process.env)
    await assertAuthCoreReady(context)
    const repository = new MongoAuthRepository(context)
    const result = await seedE2eUser({ repository, email: input.emailDisplay, password: input.password, apply: true, allowNonDisposable })
    console.log(JSON.stringify(result))
  } catch (error) {
    if (error instanceof Error && error.message.includes('disposable test domain')) {
      console.error('E2E user seed failed: use a reserved test domain or set E2E_SEED_CONFIRM=true only for a dedicated test account')
      process.exitCode = 2
      return
    }
    console.error('E2E user seed failed: runtime_or_database_error')
    process.exitCode = 1
  } finally {
    await closeMongoConnection()
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main()
