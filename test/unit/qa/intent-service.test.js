import { describe, expect, it, vi } from 'vitest'
import { createQaService as createQaServiceImpl } from '../../../server/application/qa/service.js'
import { planQaIntent, QA_TIME_ZONE } from '../../../server/application/qa/intent-planner.js'
import { compileQaExecutionPlan } from '../../../server/application/qa/intent-compiler.js'
import { createProviderRouterFixture } from './provider-router-fixture.js'

const auth = {
  user: { id: 'user-intent', status: 'active', sessionVersion: 1 },
  session: { id: 'session-intent', userSessionVersion: 1 },
}

const FIXED_NOW = new Date('2026-09-04T15:30:00.000Z')
const SERVER_TIMEZONE = QA_TIME_ZONE ?? 'Asia/Ho_Chi_Minh'
// Local HCMC day for FIXED_NOW: 2026-09-04 (UTC+7), so deterministic today range is:
const TODAY_AFTER = '2026-09-03T17:00:00.000Z'
const TODAY_BEFORE = '2026-09-04T16:59:59.999Z'

function createQaService(options = {}) {
  return createQaServiceImpl({ ...options, providerRouter: options.providerRouter ?? createProviderRouterFixture(options) })
}

function evidence() {
  return [{
    article: {
      id: 'article-intent',
      sourceId: 'source-intent',
      status: 'published',
      evidenceEligible: true,
      titleOriginal: 'Nghien cuu chip AI',
      excerptOriginal: 'Ket qua cho thay chip AI tiet kiem dien.',
      originalUrl: 'https://example.test/articles/intent',
      publishedAt: '2026-08-10T00:00:00.000Z',
      rightsSnapshot: { sourcePolicyVersion: 1, licenseStatus: 'permitted', llmInputScope: 'excerpt' },
    },
    source: {
      id: 'source-intent',
      name: 'Nguon bien tap',
      authorityTier: 'editorial',
      operationalStatus: 'active',
      licenseStatus: 'permitted',
      policyVersion: 1,
      llmInputScope: 'excerpt',
      storageScope: { metadata: true, excerpt: true, summary: true, embedding: true },
      mediaPolicy: { imageMode: 'none', videoMode: 'none', allowedHosts: [], attributionRequired: false, evidenceNote: null },
      technicalCheck: { status: 'passed' },
    },
  }]
}

function repository(records = []) {
  const attempts = new Map()
  const repo = {
    attempts,
    async reserveAnswerAttempt({ idempotencyKeyHash, requestHash, chatSessionId }) {
      const current = attempts.get(idempotencyKeyHash)
      if (current) return current
      const attempt = { _id: `attempt-${attempts.size + 1}`, idempotencyKeyHash, requestHash, status: 'reserved', chatSessionId }
      attempts.set(idempotencyKeyHash, attempt)
      return attempt
    },
    async updateAnswerAttempt(id, update) {
      const attempt = [...attempts.values()].find((item) => item._id === id)
      Object.assign(attempt, update)
      return attempt
    },
    async appendAnswer({ answer, chatSessionId }) {
      const id = chatSessionId ?? '507f1f77bcf86cd799439099'
      return { chatSessionId: id, messageId: answer.id, answer: { ...answer, chatSessionId: id }, attemptCommitted: true }
    },
    async appendRefusalWithoutQuestion({ answer, chatSessionId }) {
      const id = chatSessionId ?? '507f1f77bcf86cd799439099'
      return { chatSessionId: id, messageId: answer.id, answer: { ...answer, chatSessionId: id }, attemptCommitted: true }
    },
    async findQnaEvidence(input) {
      repo.lastEvidenceQuery = input
      repo.evidenceQueries = [...(repo.evidenceQueries ?? []), input]
      return records
    },
  }
  return repo
}

function iso(value) {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString()
}

function findInstantAndZone(args) {
  const text = JSON.stringify(args ?? null)
  const instantMatch = text.match(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z/)
  const zoneMatch = text.match(/Asia\/Ho_Chi_Minh/)
  return { text, instantMatch: instantMatch?.[0] ?? null, zoneMatch: zoneMatch?.[0] ?? null }
}

describe('QA intent service boundary (planner/compiler)', () => {
  it('derives a today publication range before evidence retrieval and passes the same effective range to the repository', async () => {
    // Arrange: ordinary question with an explicit topic scope and a fixed server clock.
    const repo = repository()
    const service = createQaService({ chatRepository: repo, articleRepository: repo, now: () => new Date(FIXED_NOW) })

    // Act
    await service.createAnswer({
      auth,
      question: 'Tin hôm nay có gì mới về AI?',
      scope: { topics: ['AI'] },
      idempotencyKey: 'intent-today-range-1',
    }).catch(() => null)
    const scope = repo.lastEvidenceQuery?.scope

    // Assert: compiler-derived HCMC today range reaches the repository unchanged.
    expect(repo.lastEvidenceQuery).toBeDefined()
    expect(iso(scope.publishedAfter)).toBe(TODAY_AFTER)
    expect(iso(scope.publishedBefore)).toBe(TODAY_BEFORE)
  })

  it('rejects a bare month without retrieval, embedding, generation, or support', async () => {
    // Arrange
    const repo = repository(evidence())
    const queryEmbedding = vi.fn(async () => ({ model: 'baai/bge-m3', dimensions: 1, version: 1, artifactCompatibilityId: 'bge-m3-v1-1', embedding: [0.5] }))
    const provider = vi.fn(async () => ({ paragraphs: [{ text: 'Ket qua.', citationIds: ['C1'], evidenceBlockIds: ['E1'] }] }))
    const supportVerifier = vi.fn(async () => ({ verdict: 'supported', evidenceBlockIds: ['E1'], addressesQuestion: true }))
    const service = createQaService({
      chatRepository: repo,
      articleRepository: repo,
      queryEmbedding,
      providerAdapters: { llmProvider: { answer: provider } },
      supportVerifier,
      now: () => new Date(FIXED_NOW),
    })

    // Act
    const failure = await service.createAnswer({
      auth,
      question: 'Tin tháng 9 có gì mới về AI?',
      scope: { topics: ['AI'] },
      idempotencyKey: 'intent-missing-year-1',
    }).then(() => null, (error) => error)

    // Assert: safe clarification, no downstream side effects.
    expect(failure).toMatchObject({ status: 422, code: 'validation_error' })
    expect(Array.isArray(failure?.details)).toBe(true)
    expect(failure.details).toHaveLength(1)
    expect(failure.details[0]).toMatchObject({ field: '/question', code: 'qa_clarify_missing_year' })
    expect(queryEmbedding).not.toHaveBeenCalled()
    expect(repo.evidenceQueries ?? []).toHaveLength(0)
    expect(provider).not.toHaveBeenCalled()
    expect(supportVerifier).not.toHaveBeenCalled()
    for (const attempt of repo.attempts.values()) {
      const serialized = JSON.stringify(attempt ?? {})
      expect(serialized).not.toContain('Tin tháng 9')
    }
  })

  it('calls planner and compiler once with one server instant/timezone and drops an untrusted compiler scope field', async () => {
    // Arrange: injectable planner/compiler boundary with a fixed server clock.
    const repo = repository()
    const intentPlanner = vi.fn((input) => planQaIntent(input))
    const intentCompiler = vi.fn((input) => {
      const plan = compileQaExecutionPlan(input)
      return { ...plan, effectiveScope: { ...plan.effectiveScope, injectedAdmin: true } }
    })
    const service = createQaService({
      chatRepository: repo,
      articleRepository: repo,
      intentPlanner,
      intentCompiler,
      now: () => new Date(FIXED_NOW),
    })
    const question = 'Tin hôm nay có gì mới về AI?'

    // Act
    await service.createAnswer({ auth, question, scope: { topics: ['AI'] }, idempotencyKey: 'intent-planner-once-1' }).catch(() => null)

    // Assert: single deterministic call each, sharing one server instant/timezone and the explicit scope.
    expect(intentPlanner).toHaveBeenCalledTimes(1)
    expect(intentCompiler).toHaveBeenCalledTimes(1)
    const plannerArgs = intentPlanner.mock.calls[0][0]
    const compilerArgs = intentCompiler.mock.calls[0][0]
    expect(JSON.stringify(plannerArgs)).toContain('AI')
    expect(JSON.stringify(compilerArgs)).toContain('AI')
    const plannerClock = findInstantAndZone(plannerArgs)
    const compilerClock = findInstantAndZone(compilerArgs)
    expect(plannerClock.zoneMatch).toBe(SERVER_TIMEZONE)
    expect(compilerClock.zoneMatch).toBe(SERVER_TIMEZONE)
    expect(plannerClock.instantMatch).toBe(FIXED_NOW.toISOString())
    expect(compilerClock.instantMatch).toBe(FIXED_NOW.toISOString())
    expect(repo.lastEvidenceQuery).toBeDefined()
    expect(repo.lastEvidenceQuery.scope).not.toHaveProperty('injectedAdmin')
  })

  it('fails closed when the planner fails, without retrieval or provider calls', async () => {
    // Arrange
    const repo = repository(evidence())
    const queryEmbedding = vi.fn(async () => ({ model: 'baai/bge-m3', dimensions: 1, version: 1, artifactCompatibilityId: 'bge-m3-v1-1', embedding: [0.5] }))
    const provider = vi.fn(async () => ({ paragraphs: [{ text: 'Ket qua.', citationIds: ['C1'], evidenceBlockIds: ['E1'] }] }))
    const supportVerifier = vi.fn(async () => ({ verdict: 'supported', evidenceBlockIds: ['E1'], addressesQuestion: true }))
    const intentPlanner = vi.fn(() => { throw new Error('planner unavailable') })
    const service = createQaService({
      chatRepository: repo,
      articleRepository: repo,
      queryEmbedding,
      providerAdapters: { llmProvider: { answer: provider } },
      supportVerifier,
      intentPlanner,
      now: () => new Date(FIXED_NOW),
    })

    // Act
    const failure = await service.createAnswer({
      auth,
      question: 'Tin hôm nay có gì mới về AI?',
      scope: { topics: ['AI'] },
      idempotencyKey: 'intent-planner-fails-1',
    }).then(() => null, (error) => error)

    // Assert: closed failure, no downstream retrieval or generation.
    expect(failure).toBeTruthy()
    expect(intentPlanner).toHaveBeenCalledTimes(1)
    expect(queryEmbedding).not.toHaveBeenCalled()
    expect(repo.evidenceQueries ?? []).toHaveLength(0)
    expect(provider).not.toHaveBeenCalled()
    expect(supportVerifier).not.toHaveBeenCalled()
  })
  it('keeps inferred temporal bounds out of the continuation scope fence', async () => {
    const repo = repository(evidence())
    repo.getChatSession = vi.fn(async () => ({ scope: { topics: ['ai'] } }))
    const service = createQaService({ chatRepository: repo, articleRepository: repo, now: () => new Date(FIXED_NOW) })

    const first = await service.createAnswer({ auth, question: 'Tin AI hôm nay có gì mới?', scope: { topics: ['AI'] }, idempotencyKey: 'intent-continuation-first' })
    const second = await service.createAnswer({ auth, question: 'Còn bài nào đáng chú ý?', scope: { topics: ['AI'] }, chatSessionId: first.answer.chatSessionId, idempotencyKey: 'intent-continuation-second' })

    expect(first.answer.chatSessionId).toBe('507f1f77bcf86cd799439099')
    expect(second.answer).toMatchObject({ chatSessionId: '507f1f77bcf86cd799439099', status: 'refused' })
    expect(repo.getChatSession).toHaveBeenCalledWith(expect.objectContaining({ chatSessionId: '507f1f77bcf86cd799439099' }))
  })

})
