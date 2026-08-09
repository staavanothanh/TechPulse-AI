import { validateMongoConfiguration } from '../server/config/runtime.js'
import { getMongoContext, closeMongoConnection } from '../server/repositories/mongo/connection.js'
import { MongoAuthRepository } from '../server/repositories/mongo/auth-repository.js'
import { hashPassword } from '../server/security/password.js'
import { assertAuthCoreReady } from '../server/bootstrap/auth.js'
import { configureDns } from './configure-dns.js'

configureDns()

function normalizeEmail(value) {
  return typeof value === 'string' ? value.trim().toLowerCase() : ''
}

try {
  const email = normalizeEmail(process.env.SEED_ADMIN_EMAIL)
  const password = process.env.SEED_ADMIN_PASSWORD
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || typeof password !== 'string' || password.length < 10 || password.length > 128) throw new Error('SEED_ADMIN_EMAIL and SEED_ADMIN_PASSWORD are required')
  const runtime = { mongo: validateMongoConfiguration(process.env) }
  const context = await getMongoContext(runtime)
  await assertAuthCoreReady(context)
  const repository = new MongoAuthRepository(context)
  const result = await repository.seedAdmin({ emailNormalized: email, emailDisplay: email, passwordHash: await hashPassword(password) })
  console.log(JSON.stringify({ seeded: result.seeded, existing: result.existing }))
} catch {
  console.error('Admin seed failed: runtime_or_database_error')
  process.exitCode = 1
} finally {
  await closeMongoConnection()
}
