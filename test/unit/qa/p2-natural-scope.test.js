import Ajv from 'ajv'
import addFormats from 'ajv-formats'
import { describe, expect, it, vi } from 'vitest'
import { loadOpenApi } from '../../../scripts/contracts/openapi-utils.js'
import { createQaService } from '../../../server/application/qa/service.js'

const OPENAPI_ID = 'techpulse-openapi-p2-natural-scope'
const QUESTION = 'Hôm nay có tin gì mới về AI không?'
const SCOPE_CONFIRMATION_SECRET = 'p2-natural-scope-secret-0123456789abcdef0123456789abcdef'
const PREVIEW_REQUEST = Object.freeze({
  question: QUESTION,
  scopeMode: 'preview',
})
const CONFIRMED_REQUEST = Object.freeze({
  question: QUESTION,
  scopeMode: 'confirmed',
  scopeConfirmation: Object.freeze({
    version: 'qa-scope-confirmation-v1',
    token: 'forged-client-token-0123456789abcdef',
    scopeDigest: 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef',
    expiresAt: '2026-09-06T13:00:00.000Z',
  }),
})
const EXPLICIT_REQUEST = Object.freeze({
  question: 'Bài viết này kết luận gì?',
  scope: Object.freeze({ topics: Object.freeze(['ai']) }),
})
const AUTH = Object.freeze({
  user: Object.freeze({ id: 'user-p2-natural-scope', status: 'active', sessionVersion: 1 }),
  session: Object.freeze({ id: 'session-p2-natural-scope', userSessionVersion: 1 }),
})
const OTHER_AUTH = Object.freeze({
  user: Object.freeze({ id: 'user-p2-natural-scope-other', status: 'active', sessionVersion: 1 }),
  session: Object.freeze({ id: 'session-p2-natural-scope-other', userSessionVersion: 1 }),
})
const ROTATED_AUTH = Object.freeze({
  user: Object.freeze({ id: 'user-p2-natural-scope', status: 'active', sessionVersion: 2 }),
  session: Object.freeze({ id: 'session-p2-natural-scope', userSessionVersion: 2 }),
})

function validatorsFor(document) {
  const ajv = new Ajv({ allErrors: true, strict: false })
  addFormats(ajv)
  ajv.addSchema({ ...document, $id: OPENAPI_ID })
  return {
    request: ajv.compile({ $ref: `${OPENAPI_ID}#/components/schemas/AnswerRequest` }),
    errorResponse: ajv.compile({ $ref: `${OPENAPI_ID}#/components/schemas/ErrorResponse` }),
  }
}

function boundedScope(scope) {
  if (!scope || typeof scope !== 'object' || Array.isArray(scope)) return false
  const allowedKeys = new Set(['articleId', 'topics', 'publishedAfter', 'publishedBefore'])
  if (Object.keys(scope).some((key) => !allowedKeys.has(key))) return false
  const hasArticle = typeof scope.articleId === 'string' && scope.articleId.length > 0
  const hasTopics = Array.isArray(scope.topics) && scope.topics.length > 0 && scope.topics.length <= 10 && scope.topics.every((topic) => typeof topic === 'string' && topic.length > 0)
  const hasRange = typeof scope.publishedAfter === 'string' && typeof scope.publishedBefore === 'string'
    && Number.isFinite(Date.parse(scope.publishedAfter))
    && Number.isFinite(Date.parse(scope.publishedBefore))
    && Date.parse(scope.publishedAfter) <= Date.parse(scope.publishedBefore)
  return hasArticle || hasTopics || hasRange
}

function captureFailure(operation) {
  return Promise.resolve().then(operation).then(
    (value) => ({ value, error: null }),
    (error) => ({ value: null, error }),
  )
}

function repositoryFixture(calls) {
  const record = (name, value) => vi.fn(async (...args) => {
    calls.push({ name, args })
    return value
  })
  const attempt = { _id: 'attempt-p2-natural-scope', status: 'reserved' }
  return {
    reserveAnswerAttempt: record('reserveAnswerAttempt', attempt),
    updateAnswerAttempt: record('updateAnswerAttempt', attempt),
    appendAnswer: record('appendAnswer', { attemptCommitted: true, answer: {} }),
    appendRefusalWithoutQuestion: record('appendRefusalWithoutQuestion', { attemptCommitted: true, answer: {} }),
    findQnaEvidence: record('findQnaEvidence', []),
    assertActorFence: record('assertActorFence', true),
  }
}

describe('P2 natural-language scope confirmation contract', () => {
  it('fails closed before any work when natural-scope confirmation secret is missing', async () => {
    const repositoryCalls = []
    const repository = repositoryFixture(repositoryCalls)
    const providerRouter = { execute: vi.fn(async () => ({ output: {} })) }
    const service = createQaService({ articleRepository: repository, chatRepository: repository, providerRouter, now: () => new Date('2026-09-06T12:00:00.000Z') })

    const failure = await captureFailure(() => service.createAnswer({
      ...PREVIEW_REQUEST,
      auth: AUTH,
      idempotencyKey: 'p2-natural-missing-secret-key',
    }))

    const shortSecretService = createQaService({ articleRepository: repository, chatRepository: repository, providerRouter, scopeConfirmationSecret: 'short-secret', now: () => new Date('2026-09-06T12:00:00.000Z') })
    const shortSecretFailure = await captureFailure(() => shortSecretService.createAnswer({
      ...PREVIEW_REQUEST,
      auth: AUTH,
      idempotencyKey: 'p2-natural-short-secret-key',
    }))
    expect(shortSecretFailure.error).toMatchObject({ status: 503, code: 'service_unavailable' })
    expect(repositoryCalls).toEqual([])
    expect(providerRouter.execute).not.toHaveBeenCalled()
    expect(failure.error).toMatchObject({ status: 503, code: 'service_unavailable' })
    expect(repositoryCalls).toEqual([])
    expect(providerRouter.execute).not.toHaveBeenCalled()
  })
  it('previews a bounded scope without retrieval, then requires a server-issued confirmation for execution', async () => {
    const validators = validatorsFor(loadOpenApi())
    const repositoryCalls = []
    const repository = repositoryFixture(repositoryCalls)
    const providerRouter = { execute: vi.fn(async () => ({ output: {} })) }
    const service = createQaService({
      articleRepository: repository,
      chatRepository: repository,
      providerRouter,
      scopeConfirmationSecret: SCOPE_CONFIRMATION_SECRET,
      now: () => new Date('2026-09-06T12:00:00.000Z'),
    })

    const preview = await captureFailure(() => service.createAnswer({
      ...PREVIEW_REQUEST,
      auth: AUTH,
      idempotencyKey: 'p2-natural-preview-key',
    }))

    expect.soft(validators.request(PREVIEW_REQUEST), JSON.stringify(validators.request.errors ?? [])).toBe(true)
    expect.soft(validators.request(EXPLICIT_REQUEST), JSON.stringify(validators.request.errors ?? [])).toBe(true)
    expect.soft(preview.error).toMatchObject({
      status: 422,
      code: 'validation_error',
      details: [expect.objectContaining({
        field: '/scopeMode',
        code: 'qa_clarify_scope_confirmation',
        message: expect.any(String),
        proposedScope: expect.any(Object),
        confirmation: expect.objectContaining({
          version: 'qa-scope-confirmation-v1',
          token: expect.any(String),
          scopeDigest: expect.any(String),
          expiresAt: expect.any(String),
        }),
      })],
    })
    expect.soft(boundedScope(preview.error?.details?.[0]?.proposedScope)).toBe(true)
    expect.soft(Date.parse(preview.error?.details?.[0]?.confirmation?.expiresAt ?? '')).toBeGreaterThan(Date.parse('2026-09-06T12:00:00.000Z'))
    expect.soft(validators.errorResponse({
      error: {
        code: preview.error?.code,
        message: preview.error?.message,
        requestId: 'p2-natural-scope-test',
        details: preview.error?.details,
      },
    }), JSON.stringify(validators.errorResponse.errors ?? [])).toBe(true)
    expect.soft(repositoryCalls).toEqual([])
    expect.soft(providerRouter.execute).not.toHaveBeenCalled()
    const confirmation = preview.error?.details?.[0]?.confirmation
    const crossUserReplay = await captureFailure(() => service.createAnswer({
      ...PREVIEW_REQUEST,
      scopeMode: 'confirmed',
      scopeConfirmation: confirmation,
      auth: OTHER_AUTH,
      idempotencyKey: 'p2-natural-cross-user-key',
    }))
    expect.soft(crossUserReplay.error).toMatchObject({ status: 422, code: 'validation_error' })
    expect.soft(repositoryCalls).toEqual([])
    expect.soft(providerRouter.execute).not.toHaveBeenCalled()
    const rotatedSessionReplay = await captureFailure(() => service.createAnswer({
      question: QUESTION,
      scopeMode: 'confirmed',
      scopeConfirmation: confirmation,
      auth: ROTATED_AUTH,
      idempotencyKey: 'p2-natural-rotated-session-key',
    }))
    expect.soft(rotatedSessionReplay.error).toMatchObject({ status: 422, code: 'validation_error' })
    expect.soft(repositoryCalls).toEqual([])
    expect.soft(providerRouter.execute).not.toHaveBeenCalled()

    const alteredConfirmation = await captureFailure(() => service.createAnswer({
      question: QUESTION,
      scopeMode: 'confirmed',
      scopeConfirmation: { ...confirmation, scopeDigest: 'a'.repeat(64) },
      auth: AUTH,
      idempotencyKey: 'p2-natural-altered-scope-key',
    }))
    expect.soft(alteredConfirmation.error).toMatchObject({ status: 422, code: 'validation_error' })
    expect.soft(repositoryCalls).toEqual([])
    expect.soft(providerRouter.execute).not.toHaveBeenCalled()

    const expiredConfirmation = await captureFailure(() => service.createAnswer({
      question: QUESTION,
      scopeMode: 'confirmed',
      scopeConfirmation: { ...confirmation, expiresAt: '2026-09-06T11:59:59.999Z' },
      auth: AUTH,
      idempotencyKey: 'p2-natural-expired-key',
    }))
    expect.soft(expiredConfirmation.error).toMatchObject({ status: 422, code: 'validation_error' })
    expect.soft(repositoryCalls).toEqual([])
    expect.soft(providerRouter.execute).not.toHaveBeenCalled()

    const fakeConfirmation = await captureFailure(() => service.createAnswer({
      ...CONFIRMED_REQUEST,
      auth: AUTH,
      idempotencyKey: 'p2-natural-confirmed-key',
    }))

    expect.soft(validators.request(CONFIRMED_REQUEST), JSON.stringify(validators.request.errors ?? [])).toBe(true)
    expect.soft(fakeConfirmation.error).toMatchObject({ status: 422, code: 'validation_error' })
    expect.soft(repositoryCalls).toEqual([])
    expect.soft(providerRouter.execute).not.toHaveBeenCalled()

    const validConfirmation = await captureFailure(() => service.createAnswer({
      question: QUESTION,
      scopeMode: 'confirmed',
      scopeConfirmation: confirmation,
      auth: AUTH,
      idempotencyKey: 'p2-natural-valid-key',
    }))

    expect.soft(validConfirmation.error).toBeNull()
    expect.soft(validConfirmation.value).toEqual({ answer: {} })
    expect.soft(repositoryCalls.map(({ name }) => name)).toEqual(expect.arrayContaining(['reserveAnswerAttempt', 'appendAnswer']))
    expect.soft(providerRouter.execute).not.toHaveBeenCalled()
  })
})
