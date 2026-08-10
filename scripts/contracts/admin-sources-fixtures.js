import http from 'node:http'
import Ajv from 'ajv'
import addFormats from 'ajv-formats'
import { createApp } from '../../server/app.js'
import { SourceError } from '../../server/application/sources/service.js'
import { collectOperations, dereference } from './openapi-utils.js'

const NOW = '2026-08-10T00:00:00.000Z'
const ADMIN_TOKEN = 'source-admin-contract-token-0001'
const USER_TOKEN = 'source-user-contract-token-00001'
const CSRF_TOKEN = 'source-contract-csrf-token'
const SOURCE_ID = '507f1f77bcf86cd799439011'
const SOURCE = Object.freeze({
  id: SOURCE_ID, name: 'Example', sourceKey: 'rss:example', publisherName: 'Example Publisher', domain: 'example.com', connectorType: 'rss', accessMethod: 'rss', authorityTier: 'editorial', connectorConfig: { kind: 'rss', feedUrl: 'https://example.com/feed.xml', batchSize: 20 },
  operationalStatus: 'testing', licenseStatus: 'metadata-only', llmInputScope: 'metadata', storageScope: { metadata: true, excerpt: false, summary: true, embedding: true }, mediaPolicy: { imageMode: 'none', videoMode: 'none', allowedHosts: [], attributionRequired: false, evidenceNote: null }, attributionRequired: true, attributionText: 'Example Publisher', termsUrl: 'https://example.com/terms', licenseUrl: null, evidenceNote: 'Human reviewed terms.', reviewedAt: NOW, reviewedBy: '507f1f77bcf86cd799439012', policyVersion: 2,
  reconciliation: { status: 'pending', requiredPolicyVersion: 2, completedPolicyVersion: null, requestedAt: NOW, error: null }, technicalCheck: { status: 'passed', checkedAt: NOW, contentType: 'application/rss+xml', resolvedHost: 'example.com', sampleCount: 1, error: null }, health: { lastIngestSucceededAt: null, lastIngestFailedAt: null, consecutiveFailures: 0, lastError: null }, createdAt: NOW, updatedAt: NOW,
})

function responseValidator(document) {
  const ajv = new Ajv({ allErrors: true, strict: false })
  addFormats(ajv)
  ajv.addSchema({ ...document, $id: 'techpulse-openapi-sources' })
  const operations = new Map(collectOperations(document).map(({ operation }) => [operation.operationId, operation]))
  return (operationId, status, body) => {
    const response = dereference(document, operations.get(operationId)?.responses?.[String(status)])
    const schema = response?.content?.['application/json']?.schema
    if (!schema) throw new Error(`No JSON schema for ${operationId} ${status}`)
    const validate = ajv.compile(schema.$ref ? { $ref: `techpulse-openapi-sources${schema.$ref}` } : schema)
    if (!validate(body)) throw new Error(`Invalid ${operationId} ${status}: ${ajv.errorsText(validate.errors)}`)
  }
}

function fixtureServices() {
  const authService = {
    async authenticate({ token }) {
      if (![ADMIN_TOKEN, USER_TOKEN].includes(token)) throw new SourceError(401, 'unauthorized', 'Session is invalid')
      return { user: { id: '507f1f77bcf86cd799439012', role: token === ADMIN_TOKEN ? 'admin' : 'user', status: 'active' }, session: { _id: '507f1f77bcf86cd799439013', userSessionVersion: 0 } }
    },
    async verifyCsrf({ token }) { if (token !== CSRF_TOKEN) throw new SourceError(403, 'csrf_invalid', 'CSRF token is invalid') },
  }
  const unknown = (sourceId) => { if (sourceId === 'unknown') throw new SourceError(404, 'not_found', 'Source not found') }
  const sourceService = {
    async list() { return { sources: [SOURCE], hasNext: false, nextCursor: null } },
    async get({ sourceId }) { unknown(sourceId); return SOURCE },
    async create() { return SOURCE },
    async update({ sourceId, patch }) {
      if (sourceId === 'conflict') throw new SourceError(409, 'conflict', 'Source changed concurrently')
      if (sourceId === 'invalid-transition') throw new SourceError(409, 'invalid_state_transition', 'Source transition is invalid')
      return { ...SOURCE, operationalStatus: patch.operationalStatus ?? SOURCE.operationalStatus }
    },
    async runTechnicalCheck({ sourceId }) { if (sourceId === 'unavailable') throw new SourceError(503, 'service_unavailable', 'Technical check unavailable'); return { sourceId: SOURCE_ID, technicalCheck: SOURCE.technicalCheck } },
    async reviewPolicy() { return SOURCE },
    async requestReReview({ idempotencyKey }) {
      if (idempotencyKey === 'stale-re-review-key') throw new SourceError(409, 'idempotency_mismatch', 'Idempotency key no longer matches current state')
      return { ...SOURCE, operationalStatus: 'paused', licenseStatus: 'review-needed', llmInputScope: 'none', storageScope: { metadata: false, excerpt: false, summary: false, embedding: false }, policyVersion: 3, reconciliation: { status: 'pending', requiredPolicyVersion: 3, completedPolicyVersion: null, requestedAt: NOW, error: null } }
    },
  }
  return { authService, sourceService }
}

async function start(app) {
  const server = http.createServer(app)
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  return server
}

export async function runAdminSourcesContractFixtures({ document } = {}) {
  if (!document) throw new Error('OpenAPI document is required')
  const validate = responseValidator(document)
  const server = await start(createApp(fixtureServices()))
  const origin = `http://127.0.0.1:${server.address().port}`
  const adminCookie = `__Host-techpulse_session=${ADMIN_TOKEN}`
  const userCookie = `__Host-techpulse_session=${USER_TOKEN}`
  const jsonHeaders = { Origin: 'http://localhost:3000', Cookie: adminCookie, 'X-CSRF-Token': CSRF_TOKEN, 'Content-Type': 'application/json' }
  let cases = 0
  const request = async (operationId, path, init, status) => {
    const response = await globalThis.fetch(`${origin}${path}`, init)
    const body = await response.json()
    if (response.status !== status) throw new Error(`${operationId} expected ${status}, got ${response.status}`)
    validate(operationId, status, body)
    cases += 1
  }
  const create = { name: 'Example', sourceKey: 'rss:example', publisherName: 'Example Publisher', domain: 'example.com', connectorType: 'rss', accessMethod: 'rss', authorityTier: 'editorial', connectorConfig: { kind: 'rss', feedUrl: 'https://example.com/feed.xml', batchSize: 20 } }
  const review = { licenseStatus: 'metadata-only', llmInputScope: 'metadata', storageScope: { metadata: true, excerpt: false, summary: true, embedding: true }, mediaPolicy: { imageMode: 'none', videoMode: 'none', allowedHosts: [], attributionRequired: false, evidenceNote: null }, attributionRequired: true, attributionText: 'Example Publisher', termsUrl: 'https://example.com/terms', licenseUrl: null, evidenceNote: 'Human reviewed terms.', reasonCode: 'source_policy_reviewed' }
  try {
    await request('listSources', '/api/v1/admin/sources', { headers: { Cookie: adminCookie } }, 200)
    await request('listSources', '/api/v1/admin/sources?operationalStatus=unknown', { headers: { Cookie: adminCookie } }, 400)
    await request('listSources', '/api/v1/admin/sources', { headers: { Cookie: userCookie } }, 403)
    await request('createSource', '/api/v1/admin/sources', { method: 'POST', headers: jsonHeaders, body: JSON.stringify(create) }, 201)
    await request('createSource', '/api/v1/admin/sources', { method: 'POST', headers: jsonHeaders, body: JSON.stringify({ ...create, accessMethod: 'api' }) }, 422)
    await request('getSource', `/api/v1/admin/sources/${SOURCE_ID}`, { headers: { Cookie: adminCookie } }, 200)
    await request('getSource', '/api/v1/admin/sources/unknown', { headers: { Cookie: adminCookie } }, 404)
    await request('updateSource', `/api/v1/admin/sources/${SOURCE_ID}`, { method: 'PATCH', headers: jsonHeaders, body: JSON.stringify({ operationalStatus: 'active', reasonCode: 'source_status_changed' }) }, 200)
    await request('updateSource', '/api/v1/admin/sources/conflict', { method: 'PATCH', headers: jsonHeaders, body: JSON.stringify({ operationalStatus: 'active', reasonCode: 'source_status_changed' }) }, 409)
    await request('updateSource', '/api/v1/admin/sources/invalid-transition', { method: 'PATCH', headers: jsonHeaders, body: JSON.stringify({ operationalStatus: 'active', reasonCode: 'source_status_changed' }) }, 409)
    await request('runSourceTechnicalCheck', `/api/v1/admin/sources/${SOURCE_ID}/technical-checks`, { method: 'POST', headers: jsonHeaders, body: JSON.stringify({ reasonCode: 'source_technical_check_requested' }) }, 200)
    await request('runSourceTechnicalCheck', '/api/v1/admin/sources/unavailable/technical-checks', { method: 'POST', headers: jsonHeaders, body: JSON.stringify({ reasonCode: 'source_technical_check_requested' }) }, 503)
    await request('reviewSourcePolicy', `/api/v1/admin/sources/${SOURCE_ID}/policy-reviews`, { method: 'POST', headers: jsonHeaders, body: JSON.stringify(review) }, 200)
    await request('reviewSourcePolicy', `/api/v1/admin/sources/${SOURCE_ID}/policy-reviews`, { method: 'POST', headers: jsonHeaders, body: JSON.stringify({ ...review, attributionText: '' }) }, 422)
    await request('requestSourcePolicyReReview', `/api/v1/admin/sources/${SOURCE_ID}/re-review-requests`, { method: 'POST', headers: { ...jsonHeaders, 'Idempotency-Key': 'contract-re-review-1' }, body: JSON.stringify({ reasonCode: 'source_policy_re_review_requested' }) }, 202)
    await request('requestSourcePolicyReReview', `/api/v1/admin/sources/${SOURCE_ID}/re-review-requests`, { method: 'POST', headers: { ...jsonHeaders, 'Idempotency-Key': 'stale-re-review-key' }, body: JSON.stringify({ reasonCode: 'source_policy_re_review_requested' }) }, 409)
    await request('requestSourcePolicyReReview', `/api/v1/admin/sources/${SOURCE_ID}/re-review-requests`, { method: 'POST', headers: jsonHeaders, body: JSON.stringify({ reasonCode: 'source_policy_re_review_requested' }) }, 400)
  } finally { await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())) }
  return { cases }
}
