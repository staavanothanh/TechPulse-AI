import { MongoClient, ObjectId } from 'mongodb'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createApp } from '../../server/app.js'
import { createAuthService } from '../../server/application/auth/service.js'
import { createHmacKeyring } from '../../server/security/hmac-keyring.js'
import { hashPassword } from '../../server/security/password.js'
import { createMongoContext } from '../../server/repositories/mongo/connection.js'
import { MongoAuthRepository } from '../../server/repositories/mongo/auth-repository.js'
import { runAuthCoreMigration } from '../../scripts/migrations/auth-core.js'
import { databaseNameForSuite, dropTestDatabase } from '../../scripts/atlas-test-safety.js'
import { configureDns } from '../../scripts/configure-dns.js'

const hasMongo = Boolean(process.env.MONGODB_TEST_URI)
const describeMongo = hasMongo ? describe : describe.skip
let client
let context
let server
let origin
let repository
let registeredUserId
let databaseName

beforeAll(async () => {
  if (!hasMongo) return
  configureDns()
  client = new MongoClient(process.env.MONGODB_TEST_URI)
  await client.connect()
  databaseName = databaseNameForSuite('flow')
  context = createMongoContext({ client, database: databaseName })
  await runAuthCoreMigration({ db: context.db })
  repository = new MongoAuthRepository(context)
  const authService = createAuthService({
    repository,
    quotaKeyring: createHmacKeyring({ currentEnv: 'CURRENT', retiringEnvs: ['OLD'], currentVersion: 10, retiringVersions: [8], values: { CURRENT: 'c'.repeat(32), OLD: 'o'.repeat(32) } }),
    clientIpAdapter: { getClientIp: () => '203.0.113.20' },
  })
  await repository.createUser({ emailNormalized: 'admin-flow@example.com', emailDisplay: 'admin-flow@example.com', passwordHash: await hashPassword('admin-long-enough-password'), role: 'admin', status: 'active', topicPreferences: [], sessionVersion: 0 })
  const app = createApp({ authService })
  server = await new Promise((resolve) => { const listener = app.listen(0, () => resolve(listener)) })
  origin = `http://127.0.0.1:${server.address().port}`
})

afterAll(async () => {
  if (server) await new Promise((resolve) => server.close(resolve))
  if (context) await dropTestDatabase({ context, expectedDatabase: databaseName })
  if (client) await client.close()
})

describeMongo('Step 2 real Mongo auth flow', () => {
  it('registers, bootstraps CSRF, updates preferences and revokes logout session', async () => {
    const registerResponse = await fetch(`${origin}/api/v1/auth/register`, {
      method: 'POST',
      headers: { Origin: 'http://localhost:3000', 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'flow@example.com', password: 'long-enough-password' }),
    })
    const registered = await registerResponse.json()
    expect(registerResponse.status).toBe(201)
    registeredUserId = registered.data.user.id
    const cookie = registerResponse.headers.get('set-cookie').split(';', 1)[0]
    const csrfToken = registered.data.csrfToken

    const meResponse = await fetch(`${origin}/api/v1/me`, { headers: { Cookie: cookie } })
    const me = await meResponse.json()
    expect(meResponse.status).toBe(200)
    expect(me.data.user.email).toBe('flow@example.com')
    expect(me.data.csrfToken).toHaveLength(43)

    const concurrentMeResponse = await fetch(`${origin}/api/v1/me`, { headers: { Cookie: cookie } })
    const concurrentMe = await concurrentMeResponse.json()
    expect(concurrentMeResponse.status).toBe(200)
    expect(concurrentMe.data.csrfToken).toBe(me.data.csrfToken)

    const preferencesResponse = await fetch(`${origin}/api/v1/me/preferences`, {
      method: 'PATCH',
      headers: { Origin: 'http://localhost:3000', Cookie: cookie, 'X-CSRF-Token': me.data.csrfToken, 'Content-Type': 'application/json' },
      body: JSON.stringify({ topicPreferences: ['AI', 'Robot'] }),
    })
    expect(preferencesResponse.status).toBe(200)

    const concurrentPreferencesResponse = await fetch(`${origin}/api/v1/me/preferences`, {
      method: 'PATCH',
      headers: { Origin: 'http://localhost:3000', Cookie: cookie, 'X-CSRF-Token': concurrentMe.data.csrfToken, 'Content-Type': 'application/json' },
      body: JSON.stringify({ topicPreferences: ['AI', 'Robot'] }),
    })
    expect(concurrentPreferencesResponse.status).toBe(200)

    const logoutResponse = await fetch(`${origin}/api/v1/auth/logout`, {
      method: 'POST',
      headers: { Origin: 'http://localhost:3000', Cookie: cookie, 'X-CSRF-Token': me.data.csrfToken },
    })
    expect(logoutResponse.status).toBe(204)

    const afterLogout = await fetch(`${origin}/api/v1/me`, { headers: { Cookie: cookie } })
    expect(afterLogout.status).toBe(401)
    expect(csrfToken).toHaveLength(43)
  }, 30_000)

  it('enforces admin list pagination and suspend audit/session revocation', async () => {
    const loginResponse = await fetch(`${origin}/api/v1/auth/login`, {
      method: 'POST', headers: { Origin: 'http://localhost:3000', 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'admin-flow@example.com', password: 'admin-long-enough-password' }),
    })
    const login = await loginResponse.json()
    const cookie = loginResponse.headers.get('set-cookie').split(';', 1)[0]
    const listResponse = await fetch(`${origin}/api/v1/admin/users?limit=1&status=active`, { headers: { Cookie: cookie } })
    const list = await listResponse.json()
    expect(listResponse.status).toBe(200)
    expect(list.meta).toEqual(expect.objectContaining({ hasNext: expect.any(Boolean) }))
    const updateResponse = await fetch(`${origin}/api/v1/admin/users/${registeredUserId}`, {
      method: 'PATCH',
      headers: { Origin: 'http://localhost:3000', Cookie: cookie, 'X-CSRF-Token': login.data.csrfToken, 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: 'suspended', reasonCode: 'user_suspended' }),
    })
    expect(updateResponse.status).toBe(200)
    const suspended = await updateResponse.json()
    expect(suspended.data.status).toBe('suspended')
    const suspensionAudit = await context.db.collection('adminAuditLogs').findOne({ action: 'user_suspended', targetId: new ObjectId(registeredUserId) })
    expect(suspensionAudit.stateTransition).toEqual({ from: 'active', to: 'suspended' })
    const duplicateSuspend = await fetch(`${origin}/api/v1/admin/users/${registeredUserId}`, {
      method: 'PATCH',
      headers: { Origin: 'http://localhost:3000', Cookie: cookie, 'X-CSRF-Token': login.data.csrfToken, 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: 'suspended', reasonCode: 'user_suspended' }),
    })
    expect(duplicateSuspend.status).toBe(409)
    const failedSuspendAudit = await context.db.collection('adminAuditLogs').findOne({ action: 'user_suspended', targetId: new ObjectId(registeredUserId), result: 'failed' })
    expect(failedSuspendAudit).toEqual(expect.objectContaining({ stateTransition: { from: 'active', to: 'suspended' } }))
    const userSessions = await context.db.collection('sessions').countDocuments({ userId: (await repository.findUserByEmail('flow@example.com'))._id, status: 'active' })
    expect(userSessions).toBe(0)
  }, 30_000)
})
