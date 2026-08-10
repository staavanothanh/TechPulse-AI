import { MongoClient, ObjectId } from 'mongodb'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createApp } from '../../server/app.js'
import { createSourceService } from '../../server/application/sources/service.js'
import { createMongoContext } from '../../server/repositories/mongo/connection.js'
import { MongoSourceRepository } from '../../server/repositories/mongo/source-repository.js'
import { runAuthCoreMigration } from '../../scripts/migrations/auth-core.js'
import { runSourcesMigration } from '../../scripts/migrations/sources.js'
import { databaseNameForSuite, dropTestDatabase } from '../../scripts/atlas-test-safety.js'
import { configureDns } from '../../scripts/configure-dns.js'

const hasMongo = Boolean(process.env.MONGODB_TEST_URI)
const describeMongo = hasMongo ? describe : describe.skip
const ADMIN_TOKEN = 'source-admin-session-token-0001'
const USER_TOKEN = 'source-user-session-token-00001'
const CSRF = 'source-csrf-token'
let client
let context
let databaseName
let server
let origin
let admin
let user

async function insertPrincipal({ role, email, tokenHash }) {
  const now = new Date()
  const principal = { _id: new ObjectId(), emailNormalized: email, emailDisplay: email, passwordHash: 'scrypt$16384$8$1$s:' + 's'.repeat(64), role, status: 'active', topicPreferences: [], sessionVersion: 0, createdAt: now, updatedAt: now }
  const session = { _id: new ObjectId(), tokenHash, userId: principal._id, userSessionVersion: 0, csrfSecretHash: 'c'.repeat(64), status: 'active', absoluteExpiresAt: new Date(now.getTime() + 86_400_000), expiresAt: new Date(now.getTime() + 86_400_000), lastSeenAt: now, createdAt: now }
  await context.db.collection('users').insertOne(principal)
  await context.db.collection('sessions').insertOne(session)
  return { user: { id: principal._id.toHexString(), role, status: 'active' }, session: { _id: session._id.toHexString(), userSessionVersion: 0 } }
}

beforeAll(async () => {
  if (!hasMongo) return
  configureDns()
  databaseName = databaseNameForSuite('source_flow')
  client = new MongoClient(process.env.MONGODB_TEST_URI)
  await client.connect()
  context = createMongoContext({ client, database: databaseName })
  await runAuthCoreMigration({ db: context.db })
  await runSourcesMigration({ db: context.db })
  admin = await insertPrincipal({ role: 'admin', email: 'source-flow-admin@example.com', tokenHash: 'a'.repeat(64) })
  user = await insertPrincipal({ role: 'user', email: 'source-flow-user@example.com', tokenHash: 'b'.repeat(64) })
  const authService = {
    async authenticate({ token }) {
      if (token === ADMIN_TOKEN) return admin
      if (token === USER_TOKEN) return user
      const error = new Error('Session is invalid'); error.status = 401; error.code = 'unauthorized'; throw error
    },
    async verifyCsrf({ token }) {
      if (token !== CSRF) { const error = new Error('CSRF token is invalid'); error.status = 403; error.code = 'csrf_invalid'; throw error }
    },
  }
  const sourceService = createSourceService({
    repository: new MongoSourceRepository(context),
    technicalCheckAdapter: { async run() { return { status: 'passed', checkedAt: new Date(), contentType: 'application/rss+xml', resolvedHost: 'example.com', sampleCount: 1, licenseStatus: 'permitted' } } },
    rateLimitAdmission: { async reserve() { return { allowed: true } } },
  })
  const app = createApp({ authService, sourceService })
  server = await new Promise((resolve) => { const listener = app.listen(0, () => resolve(listener)) })
  origin = `http://127.0.0.1:${server.address().port}`
})

afterAll(async () => {
  if (server) await new Promise((resolve) => server.close(resolve))
  if (context) await dropTestDatabase({ context, expectedDatabase: databaseName })
  if (client) await client.close()
})

describeMongo('Step 3 real Mongo Source Registry HTTP flow', () => {
  it('keeps the admin surface forbidden to a regular user', async () => {
    const response = await fetch(`${origin}/api/v1/admin/sources`, { headers: { Cookie: `__Host-techpulse_session=${USER_TOKEN}` } })
    expect(response.status).toBe(403)
  })

  it('maps an invalid admin list filter to the canonical bad-request response', async () => {
    const response = await fetch(`${origin}/api/v1/admin/sources?operationalStatus=unknown`, { headers: { Cookie: `__Host-techpulse_session=${ADMIN_TOKEN}` } })
    const body = await response.json()
    expect(response.status).toBe(400)
    expect(body.error.code).toBe('bad_request')
  })

  it('creates, checks, reviews, activates and idempotently re-reviews a source', async () => {
    const cookie = `__Host-techpulse_session=${ADMIN_TOKEN}`
    const jsonHeaders = { Origin: 'http://localhost:3000', Cookie: cookie, 'X-CSRF-Token': CSRF, 'Content-Type': 'application/json' }
    const createBody = { name: 'Example', sourceKey: 'rss:source-flow', publisherName: 'Example Publisher', domain: 'example.com', connectorType: 'rss', accessMethod: 'rss', authorityTier: 'editorial', connectorConfig: { kind: 'rss', feedUrl: 'https://example.com/feed.xml', batchSize: 20 } }
    const createResponse = await fetch(`${origin}/api/v1/admin/sources`, { method: 'POST', headers: jsonHeaders, body: JSON.stringify(createBody) })
    const created = await createResponse.json()
    expect(createResponse.status).toBe(201)
    expect(created.data).toEqual(expect.objectContaining({ operationalStatus: 'draft', licenseStatus: 'review-needed', policyVersion: 1 }))
    const sourceId = created.data.id

    const prematureActivation = await fetch(`${origin}/api/v1/admin/sources/${sourceId}`, { method: 'PATCH', headers: jsonHeaders, body: JSON.stringify({ operationalStatus: 'active', reasonCode: 'source_status_changed' }) })
    const prematureBody = await prematureActivation.json()
    expect(prematureActivation.status).toBe(409)
    expect(prematureBody.error.code).toBe('invalid_state_transition')
    expect(await context.db.collection('adminAuditLogs').findOne({ targetId: new ObjectId(sourceId), action: 'source_status_updated', result: 'failed' })).toEqual(expect.objectContaining({ changedFields: ['operationalStatus'], stateTransition: { from: 'draft', to: 'active' } }))

    const testingResponse = await fetch(`${origin}/api/v1/admin/sources/${sourceId}`, { method: 'PATCH', headers: jsonHeaders, body: JSON.stringify({ operationalStatus: 'testing', reasonCode: 'source_status_changed' }) })
    expect(testingResponse.status).toBe(200)
    const technicalResponse = await fetch(`${origin}/api/v1/admin/sources/${sourceId}/technical-checks`, { method: 'POST', headers: jsonHeaders, body: JSON.stringify({ reasonCode: 'source_technical_check_requested' }) })
    const technical = await technicalResponse.json()
    expect(technicalResponse.status).toBe(200)
    expect(technical.data.technicalCheck.status).toBe('passed')

    const reviewBody = {
      licenseStatus: 'metadata-only', llmInputScope: 'metadata', storageScope: { metadata: true, excerpt: false, summary: true, embedding: true },
      mediaPolicy: { imageMode: 'none', videoMode: 'none', allowedHosts: [], attributionRequired: false, evidenceNote: null },
      attributionRequired: true, attributionText: 'Example Publisher', termsUrl: 'https://example.com/terms', licenseUrl: null,
      evidenceNote: 'Human-reviewed publisher terms.', reasonCode: 'source_policy_reviewed',
    }
    const reviewResponse = await fetch(`${origin}/api/v1/admin/sources/${sourceId}/policy-reviews`, { method: 'POST', headers: jsonHeaders, body: JSON.stringify(reviewBody) })
    const reviewed = await reviewResponse.json()
    expect(reviewResponse.status).toBe(200)
    expect(reviewed.data).toEqual(expect.objectContaining({ licenseStatus: 'metadata-only', reviewedBy: admin.user.id, policyVersion: 2 }))
    expect(reviewed.data.licenseStatus).not.toBe('permitted')

    const activateResponse = await fetch(`${origin}/api/v1/admin/sources/${sourceId}`, { method: 'PATCH', headers: jsonHeaders, body: JSON.stringify({ operationalStatus: 'active', reasonCode: 'source_status_changed' }) })
    expect(activateResponse.status).toBe(200)
    const idempotencyKey = 'source-re-review-flow-1'
    const reReview = async () => fetch(`${origin}/api/v1/admin/sources/${sourceId}/re-review-requests`, { method: 'POST', headers: { ...jsonHeaders, 'Idempotency-Key': idempotencyKey }, body: JSON.stringify({ reasonCode: 'source_policy_re_review_requested' }) })
    const [firstReReview, secondReReview] = await Promise.all([reReview(), reReview()])
    const [firstBody, secondBody] = await Promise.all([firstReReview.json(), secondReReview.json()])
    const conflictingCreate = await fetch(`${origin}/api/v1/admin/sources`, { method: 'POST', headers: jsonHeaders, body: JSON.stringify({ ...createBody, sourceKey: 'rss:source-flow-conflict', name: 'Conflicting source' }) })
    const conflictingSource = await conflictingCreate.json()
    expect(conflictingCreate.status).toBe(201)
    const conflictingReReview = await fetch(`${origin}/api/v1/admin/sources/${conflictingSource.data.id}/re-review-requests`, { method: 'POST', headers: { ...jsonHeaders, 'Idempotency-Key': idempotencyKey }, body: JSON.stringify({ reasonCode: 'source_policy_re_review_requested' }) })
    const conflictingBody = await conflictingReReview.json()
    expect(conflictingReReview.status).toBe(409)
    expect(conflictingBody.error.code).toBe('idempotency_mismatch')
    expect(await context.db.collection('sources').findOne({ _id: new ObjectId(conflictingSource.data.id) })).toEqual(expect.objectContaining({ policyVersion: 1, licenseStatus: 'review-needed' }))
    expect(firstReReview.status).toBe(202)
    expect(secondReReview.status).toBe(202)
    expect(firstBody.data).toEqual(expect.objectContaining({ operationalStatus: 'paused', licenseStatus: 'review-needed', policyVersion: 3 }))
    expect(secondBody.data.policyVersion).toBe(3)
    const reReviewAudit = await context.db.collection('adminAuditLogs').findOne({ targetType: 'source', targetId: new ObjectId(sourceId), action: 'source_policy_re_review_requested', result: 'succeeded' })
    expect(await context.db.collection('adminAuditLogs').countDocuments({ targetType: 'source', targetId: new ObjectId(sourceId), action: 'source_policy_re_review_requested', result: 'succeeded' })).toBe(1)
    const reReviewedSource = await context.db.collection('sources').findOne({ _id: new ObjectId(sourceId) })
    expect(reReviewedSource).toEqual(expect.objectContaining({ policyVersion: 3, reconciliation: expect.objectContaining({ status: 'pending', requiredPolicyVersion: 3 }) }))
    expect(reReviewedSource.reconciliation.requestedAt).toEqual(reReviewAudit.createdAt)

    const secondReviewResponse = await fetch(`${origin}/api/v1/admin/sources/${sourceId}/policy-reviews`, { method: 'POST', headers: jsonHeaders, body: JSON.stringify(reviewBody) })
    expect(secondReviewResponse.status).toBe(200)
    const reactivateResponse = await fetch(`${origin}/api/v1/admin/sources/${sourceId}`, { method: 'PATCH', headers: jsonHeaders, body: JSON.stringify({ operationalStatus: 'active', reasonCode: 'source_status_changed' }) })
    expect(reactivateResponse.status).toBe(200)
    const staleReplay = await reReview()
    const staleReplayBody = await staleReplay.json()
    expect(staleReplay.status).toBe(409)
    expect(staleReplayBody.error.code).toBe('idempotency_mismatch')
    expect(await context.db.collection('sources').findOne({ _id: new ObjectId(sourceId) })).toEqual(expect.objectContaining({ operationalStatus: 'active', licenseStatus: 'metadata-only', policyVersion: 4 }))
    const auditDocuments = await context.db.collection('adminAuditLogs').find({ targetType: 'source', targetId: new ObjectId(sourceId) }).toArray()
    expect(auditDocuments.map(({ action }) => action)).toEqual(expect.arrayContaining(['source_created', 'source_status_updated', 'source_technical_check_recorded', 'source_policy_reviewed', 'source_policy_re_review_requested']))
    expect(JSON.stringify(auditDocuments)).not.toMatch(/Human-reviewed|feed\.xml|passwordHash|credential/i)
  }, 30_000)
})
