import http from 'node:http'
import Ajv from 'ajv'
import addFormats from 'ajv-formats'
import { createApp } from '../../server/app.js'
import { AdminGovernanceError } from '../../server/application/admin/service.js'
import { AuthError } from '../../server/application/auth/service.js'
import { collectOperations, dereference } from './openapi-utils.js'

const NOW = '2026-08-13T00:00:00.000Z'
const ADMIN_TOKEN = 'governance-admin-contract-token-0001'
const USER_TOKEN = 'governance-user-contract-token-00001'
const CSRF_TOKEN = 'governance-contract-csrf-token'
const ARTICLE_ID = '507f1f77bcf86cd799439011'
const SOURCE_ID = '507f1f77bcf86cd799439012'
const USER_ID = '507f1f77bcf86cd799439013'
const TAKEDOWN_ID = '507f1f77bcf86cd799439014'
const DELETION_ID = '507f1f77bcf86cd799439015'
const CONFLICT_ARTICLE_ID = '507f1f77bcf86cd799439020'
const LIMITED_ARTICLE_ID = '507f1f77bcf86cd799439021'
const UNAVAILABLE_ARTICLE_ID = '507f1f77bcf86cd799439022'

const ARTICLE = Object.freeze({
  id: ARTICLE_ID, sourceId: SOURCE_ID, titleOriginal: 'Bản tin hệ thống có nguồn', status: 'published', topics: ['AI'], leadMedia: null,
  leadMediaStatus: 'none', summaryStatus: 'ready', embeddingStatus: 'ready', embeddingModel: 'baai/bge-m3', embeddingVersion: 1, updatedAt: NOW,
})
const ARTICLE_DETAIL = Object.freeze({
  ...ARTICLE, originalUrl: 'https://example.com/articles/system-news',
  provenance: [{ sourceId: SOURCE_ID, originalUrl: 'https://example.com/articles/system-news', observedAt: NOW }],
  rightsSnapshot: { sourcePolicyVersion: 2, licenseStatus: 'permitted', llmInputScope: 'metadata', capturedAt: NOW },
  summaryModel: 'deepseek-v4-flash-free', summarySourcePolicyVersion: 2, summaryGeneratedAt: NOW, summaryError: null,
  embeddingSourcePolicyVersion: 2, embeddedAt: NOW, embeddingError: null,
})
const TAKEDOWN_SUMMARY = Object.freeze({ id: TAKEDOWN_ID, status: 'reviewing', targetType: 'article', targetIds: [ARTICLE_ID], requestedScope: ['summary', 'embedding'], createdAt: NOW, updatedAt: NOW })
const TAKEDOWN = Object.freeze({
  ...TAKEDOWN_SUMMARY, requesterName: 'Đại diện nhà xuất bản', requesterContact: 'rights@example.com', reason: 'Yêu cầu xử lý quyền nội dung', evidenceNote: null,
  decisionReasonCode: 'takedown_review_started', completion: { hidden: false, metadataRemoved: false, mediaMetadataRemoved: false, summaryRemoved: false, embeddingRemoved: false, historicalChatCitationsRedacted: false }, completedAt: null,
})
const DELETION = Object.freeze({
  id: DELETION_ID, status: 'failed', priority: 50, attempt: 2, availableAt: NOW,
  completion: { sessionsRevoked: true, sessionsDeleted: true, savedArticlesDeleted: true, chatSessionsDeleted: true, answerAttemptsDeleted: true, userQuotaDataDeleted: false, identityAnonymized: false },
  error: { code: 'cleanup_incomplete', message: 'Cleanup chưa hoàn tất', retryable: true, occurredAt: NOW }, requestedAt: NOW, startedAt: NOW, completedAt: null,
})
const ADMIN_USER = Object.freeze({ id: USER_ID, emailNormalized: 'user@example.com', emailDisplay: 'user@example.com', role: 'user', status: 'active', createdAt: new Date(NOW), updatedAt: new Date(NOW) })
const AUDIT = Object.freeze({ id: '507f1f77bcf86cd799439016', actorType: 'admin', actorId: '507f1f77bcf86cd799439017', action: 'article_status_changed', targetType: 'article', targetId: ARTICLE_ID, changedFields: ['status'], stateTransition: { from: 'published', to: 'hidden' }, reasonCode: 'article_status_changed', requestId: 'contract-request-0001', result: 'succeeded', createdAt: NOW })

function responseValidator(document) {
  const ajv = new Ajv({ allErrors: true, strict: false })
  addFormats(ajv)
  ajv.addSchema({ ...document, $id: 'techpulse-openapi-admin-governance' })
  const operations = new Map(collectOperations(document).map(({ operation }) => [operation.operationId, operation]))
  return (operationId, status, body) => {
    const response = dereference(document, operations.get(operationId)?.responses?.[String(status)])
    const schema = response?.content?.['application/json']?.schema
    if (!schema) throw new Error(`No JSON schema for ${operationId} ${status}`)
    const validate = ajv.compile(schema.$ref ? { $ref: `techpulse-openapi-admin-governance${schema.$ref}` } : schema)
    if (!validate(body)) throw new Error(`Invalid ${operationId} ${status}: ${ajv.errorsText(validate.errors)}`)
  }
}

function fixtureServices() {
  const authService = {
    async authenticate({ token }) {
      if (![ADMIN_TOKEN, USER_TOKEN].includes(token)) throw new AuthError(401, 'unauthorized', 'Session is invalid')
      return { user: { id: '507f1f77bcf86cd799439017', role: token === ADMIN_TOKEN ? 'admin' : 'user', status: 'active', sessionVersion: 4 }, session: { _id: '507f1f77bcf86cd799439018', userSessionVersion: 4 } }
    },
    async verifyCsrf({ token }) { if (token !== CSRF_TOKEN) throw new AuthError(403, 'csrf_invalid', 'CSRF token is invalid') },
    async listAdminUsers() { return { users: [ADMIN_USER], hasNext: false, nextCursor: null } },
    async getAdminUser({ userId }) { if (userId !== USER_ID) throw new AuthError(404, 'not_found', 'User not found'); return ADMIN_USER },
    async updateUserStatus({ userId, status }) { if (userId !== USER_ID) throw new AuthError(404, 'not_found', 'User not found'); return { ...ADMIN_USER, status, updatedAt: new Date(NOW) } },
  }
  const adminGovernanceService = {
    async getAdminOverview() { return { activeSources: 4, pausedSources: 1, sourcesNeedingReview: 2, queuedJobs: 3, failedJobs: 1, articlesNeedingReview: 2, failedIndexes: 1, openTakedowns: 1, failedAccountDeletions: 1, lastSuccessfulIngestionAt: NOW } },
    async listAdminArticles({ query } = {}) { if (query?.status === 'hidden') throw new AdminGovernanceError(422, 'validation_error', 'Article filter is invalid'); return { articles: [ARTICLE], hasNext: false, nextCursor: null } },
    async getAdminArticle({ articleId }) { if (articleId !== ARTICLE_ID) throw new AdminGovernanceError(404, 'not_found', 'Article not found'); return ARTICLE_DETAIL },
    async updateAdminArticle({ articleId, patch }) {
      if (articleId === CONFLICT_ARTICLE_ID) throw new AdminGovernanceError(409, 'conflict', 'Article changed concurrently')
      if (articleId === LIMITED_ARTICLE_ID) throw new AdminGovernanceError(429, 'rate_limit_exceeded', 'Admin mutation limit reached', { retryAfter: 30 })
      if (articleId === UNAVAILABLE_ARTICLE_ID) throw new AdminGovernanceError(503, 'service_unavailable', 'Article mutation is temporarily unavailable')
      if (articleId !== ARTICLE_ID) throw new AdminGovernanceError(404, 'not_found', 'Article not found')
      return { ...ARTICLE, ...Object.fromEntries(Object.entries(patch).filter(([key]) => key !== 'reasonCode')) }
    },
    async mergeDuplicateArticles() { return ARTICLE },
    async listTakedownRequests() { return { requests: [TAKEDOWN_SUMMARY], hasNext: false, nextCursor: null } },
    async createTakedownRequest() { return TAKEDOWN },
    async getTakedownRequest({ takedownRequestId }) { if (takedownRequestId !== TAKEDOWN_ID) throw new AdminGovernanceError(404, 'not_found', 'Takedown request not found'); return TAKEDOWN },
    async updateTakedownRequest({ takedownRequestId, input }) { if (takedownRequestId !== TAKEDOWN_ID) throw new AdminGovernanceError(404, 'not_found', 'Takedown request not found'); return { ...TAKEDOWN, status: input.status, decisionReasonCode: input.reasonCode } },
    async listAccountDeletionRequests() { return { requests: [DELETION], hasNext: false, nextCursor: null } },
    async getAccountDeletionRequest({ deletionRequestId }) { if (deletionRequestId !== DELETION_ID) throw new AdminGovernanceError(404, 'not_found', 'Deletion request not found'); return DELETION },
    async retryAccountDeletionRequest({ deletionRequestId }) { if (deletionRequestId !== DELETION_ID) throw new AdminGovernanceError(404, 'not_found', 'Deletion request not found'); return { ...DELETION, status: 'queued', attempt: 3, error: null } },
    async listAuditLogs({ query } = {}) { if (query?.actorType === 'system-worker') throw new AdminGovernanceError(422, 'validation_error', 'Audit filter is invalid'); return { logs: [AUDIT], hasNext: false, nextCursor: null } },
  }
  return { authService, adminGovernanceService }
}

async function start(app) {
  const server = http.createServer(app)
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  return server
}

export async function runAdminGovernanceContractFixtures({ document } = {}) {
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
  try {
    await request('getAdminOverview', '/api/v1/admin/overview', { headers: { Cookie: adminCookie } }, 200)
    await request('getAdminOverview', '/api/v1/admin/overview', {}, 401)
    await request('getAdminOverview', '/api/v1/admin/overview', { headers: { Cookie: userCookie } }, 403)
    await request('listAdminArticles', '/api/v1/admin/articles', { headers: { Cookie: adminCookie } }, 200)
    await request('listAdminArticles', '/api/v1/admin/articles?status=hidden', { headers: { Cookie: adminCookie } }, 422)
    await request('getAdminArticle', `/api/v1/admin/articles/${ARTICLE_ID}`, { headers: { Cookie: adminCookie } }, 200)
    await request('getAdminArticle', '/api/v1/admin/articles/507f1f77bcf86cd799439099', { headers: { Cookie: adminCookie } }, 404)
    await request('updateAdminArticle', `/api/v1/admin/articles/${ARTICLE_ID}`, { method: 'PATCH', headers: jsonHeaders, body: JSON.stringify({ status: 'hidden', reasonCode: 'article_status_changed' }) }, 200)
    await request('updateAdminArticle', `/api/v1/admin/articles/${CONFLICT_ARTICLE_ID}`, { method: 'PATCH', headers: jsonHeaders, body: JSON.stringify({ status: 'hidden', reasonCode: 'article_status_changed' }) }, 409)
    await request('updateAdminArticle', `/api/v1/admin/articles/${LIMITED_ARTICLE_ID}`, { method: 'PATCH', headers: jsonHeaders, body: JSON.stringify({ status: 'hidden', reasonCode: 'article_status_changed' }) }, 429)
    await request('updateAdminArticle', `/api/v1/admin/articles/${UNAVAILABLE_ARTICLE_ID}`, { method: 'PATCH', headers: jsonHeaders, body: JSON.stringify({ status: 'hidden', reasonCode: 'article_status_changed' }) }, 503)
    await request('updateAdminArticle', `/api/v1/admin/articles/${ARTICLE_ID}`, { method: 'PATCH', headers: jsonHeaders, body: JSON.stringify({ status: 'hidden', topics: ['AI'], reasonCode: 'article_status_changed' }) }, 422)
    await request('mergeDuplicateArticles', '/api/v1/admin/duplicate-merges', { method: 'POST', headers: { ...jsonHeaders, 'Idempotency-Key': 'contract-duplicate-merge-0001' }, body: JSON.stringify({ canonicalArticleId: ARTICLE_ID, duplicateArticleIds: ['507f1f77bcf86cd799439019'], reasonCode: 'duplicate_merge_confirmed' }) }, 200)
    await request('listTakedownRequests', '/api/v1/admin/takedown-requests', { headers: { Cookie: adminCookie } }, 200)
    await request('createTakedownRequest', '/api/v1/admin/takedown-requests', { method: 'POST', headers: jsonHeaders, body: JSON.stringify({ requesterName: 'Đại diện', requesterContact: 'rights@example.com', targetType: 'article', targetIds: [ARTICLE_ID], reason: 'Yêu cầu quyền nội dung', requestedScope: ['summary', 'embedding'] }) }, 201)
    await request('getTakedownRequest', `/api/v1/admin/takedown-requests/${TAKEDOWN_ID}`, { headers: { Cookie: adminCookie } }, 200)
    await request('getTakedownRequest', '/api/v1/admin/takedown-requests/507f1f77bcf86cd799439099', { headers: { Cookie: adminCookie } }, 404)
    await request('updateTakedownRequest', `/api/v1/admin/takedown-requests/${TAKEDOWN_ID}`, { method: 'PATCH', headers: jsonHeaders, body: JSON.stringify({ status: 'approved', reasonCode: 'takedown_approved' }) }, 200)
    await request('updateTakedownRequest', `/api/v1/admin/takedown-requests/${TAKEDOWN_ID}`, { method: 'PATCH', headers: jsonHeaders, body: JSON.stringify({ status: 'approved', reasonCode: 'takedown_rejected' }) }, 422)
    await request('listAccountDeletionRequests', '/api/v1/admin/account-deletion-requests', { headers: { Cookie: adminCookie } }, 200)
    await request('getAccountDeletionRequest', `/api/v1/admin/account-deletion-requests/${DELETION_ID}`, { headers: { Cookie: adminCookie } }, 200)
    await request('getAccountDeletionRequest', '/api/v1/admin/account-deletion-requests/507f1f77bcf86cd799439099', { headers: { Cookie: adminCookie } }, 404)
    await request('retryAccountDeletionRequest', `/api/v1/admin/account-deletion-requests/${DELETION_ID}/retries`, { method: 'POST', headers: { ...jsonHeaders, 'Idempotency-Key': 'contract-deletion-retry-0001' }, body: JSON.stringify({ reasonCode: 'account_deletion_retry_requested' }) }, 202)
    await request('listAdminUsers', '/api/v1/admin/users', { headers: { Cookie: adminCookie } }, 200)
    await request('getAdminUser', `/api/v1/admin/users/${USER_ID}`, { headers: { Cookie: adminCookie } }, 200)
    await request('updateUserStatus', `/api/v1/admin/users/${USER_ID}`, { method: 'PATCH', headers: jsonHeaders, body: JSON.stringify({ status: 'suspended', reasonCode: 'user_suspended' }) }, 200)
    await request('listAuditLogs', '/api/v1/admin/audit-logs', { headers: { Cookie: adminCookie } }, 200)
    await request('listAuditLogs', '/api/v1/admin/audit-logs?actorType=system-worker', { headers: { Cookie: adminCookie } }, 422)
  } finally {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
  }
  return { cases }
}
