import http from 'node:http'
import Ajv from 'ajv'
import addFormats from 'ajv-formats'
import { createApp } from '../../server/app.js'
import { ContentError, createArticleService } from '../../server/application/articles/service.js'
import { createSearchService } from '../../server/application/search/service.js'
import { createSavedService } from '../../server/application/saved/service.js'
import { collectOperations, dereference } from './openapi-utils.js'

const USER_TOKEN = 'step8-contract-user-session'
const CSRF_TOKEN = 'step8-contract-csrf-token'
const USER_ID = '507f1f77bcf86cd799439001'
const ARTICLE_ID = '507f1f77bcf86cd799439011'
const HIDDEN_ID = '507f1f77bcf86cd799439012'
const SOURCE_ID = '507f1f77bcf86cd799439021'
const NOW = '2026-08-10T08:00:00.000Z'

const CARD = Object.freeze({
  id: ARTICLE_ID,
  titleOriginal: 'Verified technology article',
  titleVi: 'Bài công nghệ đã kiểm chứng',
  source: { id: SOURCE_ID, name: 'Tech Review', authorityTier: 'editorial' },
  publishedAt: NOW,
  sourceLanguage: 'en',
  topics: ['AI'],
  summaryVi: null,
  summaryStatus: 'pending',
  summaryBasis: null,
  leadMedia: null,
  isSaved: false,
})

const DETAIL = Object.freeze({
  ...CARD,
  summaryParagraphsVi: null,
  summaryDetailStatus: 'pending',
  originalUrl: 'https://example.com/article',
  author: null,
  retrievedAt: '2026-08-10T09:00:00.000Z',
  citation: { sourceId: SOURCE_ID, sourceName: 'Tech Review', titleOriginal: CARD.titleOriginal, originalUrl: 'https://example.com/article', author: null, publishedAt: NOW, sourceLanguage: 'en' },
  aiDisclosure: 'AI tổng hợp; hãy kiểm chứng với nguồn gốc.',
})

function responseValidator(document) {
  const ajv = new Ajv({ allErrors: true, strict: false })
  addFormats(ajv)
  ajv.addSchema({ ...document, $id: 'techpulse-openapi-step8' })
  const operations = new Map(collectOperations(document).map(({ operation }) => [operation.operationId, operation]))
  return (operationId, status, body) => {
    const response = dereference(document, operations.get(operationId)?.responses?.[String(status)])
    const schema = response?.content?.['application/json']?.schema
    if (!schema) throw new Error(`No JSON schema for ${operationId} ${status}`)
    const validate = ajv.compile(schema.$ref ? { $ref: `techpulse-openapi-step8${schema.$ref}` } : schema)
    if (!validate(body)) throw new Error(`Invalid ${operationId} ${status}: ${ajv.errorsText(validate.errors)}`)
  }
}

function services() {
  const authService = {
    async authenticate({ token }) {
      if (token !== USER_TOKEN) throw new ContentError(401, 'unauthorized', 'Session is invalid')
      return {
        user: { _id: USER_ID, role: 'user', status: 'active', sessionVersion: 4 },
        session: { _id: '507f1f77bcf86cd799439002', userSessionVersion: 4 },
      }
    },
    async verifyCsrf({ token }) {
      if (token !== CSRF_TOKEN) throw new ContentError(403, 'csrf_invalid', 'CSRF token is invalid')
    },
  }
  const repository = {
    async listVisibleArticles({ topic }) { return { articles: topic === 'empty' ? [] : [CARD], hasNext: false, nextCursor: null } },
    async getVisibleArticle({ articleId }) { return articleId === ARTICLE_ID ? DETAIL : null },
    async searchVisibleArticles({ q }) {
      if (q === 'rate limit') {
        const error = new ContentError(429, 'rate_limit_exceeded', 'Rate limit exceeded')
        error.retryAfter = 17
        throw error
      }
      return { results: [{ article: CARD, score: 0.75, textScore: 0.75, semanticScore: null }], hasNext: false, nextCursor: null }
    },
    async listSavedVisibleArticles() { return { articles: [], hasNext: false, nextCursor: null } },
    async saveVisibleArticle({ articleId }) { return articleId !== HIDDEN_ID },
    async unsaveArticle() {},
    async clearSavedArticles() {},
  }
  return {
    authService,
    articleService: createArticleService({ repository }),
    searchService: createSearchService({ repository, embeddingAvailable: () => false }),
    savedService: createSavedService({ repository }),
  }
}

async function start(app) {
  const server = http.createServer(app)
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  return server
}

export async function runStep8ContentContractFixtures({ document } = {}) {
  if (!document) throw new Error('OpenAPI document is required')
  const validate = responseValidator(document)
  const server = await start(createApp(services()))
  const origin = `http://127.0.0.1:${server.address().port}`
  const cookie = `__Host-techpulse_session=${USER_TOKEN}`
  const mutationHeaders = { Origin: 'http://localhost:3000', Cookie: cookie, 'X-CSRF-Token': CSRF_TOKEN }
  let cases = 0
  async function request(operationId, path, init, expected) {
    const response = await globalThis.fetch(`${origin}${path}`, init)
    if (response.status !== expected) throw new Error(`${operationId} expected ${expected}, got ${response.status}`)
    if (expected === 204) {
      if (await response.text() !== '') throw new Error(`${operationId} 204 must not include a body`)
    } else validate(operationId, expected, await response.json())
    cases += 1
  }
  try {
    await request('listArticles', '/api/v1/articles', { headers: { Cookie: cookie } }, 200)
    await request('listArticles', '/api/v1/articles?topic=empty', { headers: { Cookie: cookie } }, 200)
    await request('listArticles', '/api/v1/articles', {}, 401)
    await request('listArticles', '/api/v1/articles?publishedAfter=2026-08-12T00%3A00%3A00.000Z&publishedBefore=2026-08-11T00%3A00%3A00.000Z', { headers: { Cookie: cookie } }, 422)
    await request('getArticle', `/api/v1/articles/${ARTICLE_ID}`, { headers: { Cookie: cookie } }, 200)
    await request('getArticle', `/api/v1/articles/${HIDDEN_ID}`, { headers: { Cookie: cookie } }, 404)
    await request('searchArticles', '/api/v1/search-results?q=artificial+intelligence&mode=hybrid', { headers: { Cookie: cookie } }, 200)
    await request('searchArticles', '/api/v1/search-results?q=rate+limit&mode=text', { headers: { Cookie: cookie } }, 429)
    await request('listSavedArticles', '/api/v1/me/saved-articles', { headers: { Cookie: cookie } }, 200)
    await request('saveArticle', `/api/v1/me/saved-articles/${ARTICLE_ID}`, { method: 'PUT', headers: mutationHeaders }, 204)
    await request('saveArticle', `/api/v1/me/saved-articles/${HIDDEN_ID}`, { method: 'PUT', headers: mutationHeaders }, 404)
    await request('unsaveArticle', `/api/v1/me/saved-articles/${ARTICLE_ID}`, { method: 'DELETE', headers: mutationHeaders }, 204)
    await request('clearSavedArticles', '/api/v1/me/saved-articles', { method: 'DELETE', headers: mutationHeaders }, 204)
    await request('clearSavedArticles', '/api/v1/me/saved-articles', { method: 'DELETE', headers: { Origin: 'http://localhost:3000', Cookie: cookie } }, 403)
  } finally { await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())) }
  return { cases }
}
