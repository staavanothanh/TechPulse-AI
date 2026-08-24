import { describe, expect, it, vi } from 'vitest'
import { createQaService } from '../../../server/application/qa/service.js'
import { ContentError } from '../../../server/application/articles/query.js'
import { createProviderRouterFixture } from './provider-router-fixture.js'

const auth = {
  user: { id: 'user-1', status: 'active', sessionVersion: 3 },
  session: { id: 'session-1', userSessionVersion: 3 },
}

function mongoServerError() {
  return Object.assign(new Error('Mongo write failed'), { name: 'MongoServerError', code: 117 })
}

function evidence() {
  return [{
    article: {
      id: 'article-1',
      sourceId: 'source-1',
      status: 'published',
      evidenceEligible: true,
      titleOriginal: 'Nghiên cứu AI',
      originalUrl: 'https://example.com/articles/1',
      publishedAt: '2026-08-10T00:00:00.000Z',
      excerptOriginal: 'Kết quả cho thấy hệ thống hoạt động ổn định.',
      rightsSnapshot: { sourcePolicyVersion: 1, licenseStatus: 'permitted', llmInputScope: 'excerpt' },
    },
    source: {
      id: 'source-1',
      name: 'Nguồn biên tập',
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

function repository({ reserveError, appendError, records = evidence(), errors = {}, attempt: attemptOverrides = {} } = {}) {
  const attempt = { _id: 'attempt-1', status: 'reserved', ...attemptOverrides }
  let evidenceReads = 0
  return {
    attempt,
    reserveAnswerAttempt: vi.fn(async () => {
      if (reserveError) throw reserveError
      return attempt
    }),
    updateAnswerAttempt: vi.fn(async (_id, update) => {
      if (errors.updateAnswerAttempt) throw errors.updateAnswerAttempt
      return Object.assign(attempt, update)
    }),
    getChatSession: vi.fn(async () => {
      if (errors.getChatSession) throw errors.getChatSession
      return { scope: { articleId: 'article-1' } }
    }),
    getAnswerResult: vi.fn(async () => {
      if (errors.getAnswerResult) throw errors.getAnswerResult
      return null
    }),
    assertActorFence: vi.fn(async () => {
      if (errors.assertActorFence) throw errors.assertActorFence
      return true
    }),
    findQnaEvidence: vi.fn(async () => {
      evidenceReads += 1
      if (errors.findQnaEvidence && (!errors.findQnaEvidenceCall || evidenceReads === errors.findQnaEvidenceCall)) throw errors.findQnaEvidence
      return records
    }),
    appendAnswer: vi.fn(async ({ answer, chatSessionId }) => {
      if (appendError) throw appendError
      return { chatSessionId: chatSessionId ?? 'chat-1', messageId: answer.id, answer }
    }),
  }
}

function assertServiceUnavailable(error) {
  expect(error).toBeInstanceOf(ContentError)
  expect(error).toMatchObject({ name: 'ContentError', status: 503, code: 'service_unavailable' })
  expect(error).not.toMatchObject({ status: 500, code: 'provider_unavailable' })
}

describe('Q&A infrastructure error mapping', () => {
  it('maps MongoServerError code 117 from reserveAnswerAttempt before provider I/O', async () => {
    const repo = repository({ reserveError: mongoServerError() })
    const provider = vi.fn()
    const service = createQaService({
      chatRepository: repo,
      articleRepository: repo,
      providerRouter: createProviderRouterFixture(),
      providerAdapters: { llmProvider: { answer: provider } },
    })

    let error
    try {
      await service.createAnswer({ auth, question: 'Bài viết kết luận gì?', scope: { articleId: 'article-1' }, idempotencyKey: 'reserve-mongo-117' })
    } catch (caught) {
      error = caught
    }

    assertServiceUnavailable(error)
    expect(repo.reserveAnswerAttempt).toHaveBeenCalledTimes(1)
    expect(provider).not.toHaveBeenCalled()
  })

  it('maps Mongo failures from chat ownership, replay, retrieval, actor fence, and attempt renewal', async () => {
    const scenarios = [
      { stage: 'getChatSession', options: { errors: { getChatSession: mongoServerError() } }, request: { chatSessionId: 'chat-1' } },
      { stage: 'getAnswerResult', options: { attempt: { status: 'completed', resultStatus: 'answered', chatSessionId: 'chat-1', messageId: 'message-1' }, errors: { getAnswerResult: mongoServerError() } } },
      { stage: 'findQnaEvidence', options: { errors: { findQnaEvidence: mongoServerError() } } },
      { stage: 'assertActorFence', options: { errors: { assertActorFence: mongoServerError() } } },
      { stage: 'updateAnswerAttempt', options: { errors: { updateAnswerAttempt: mongoServerError() } } },
      { stage: 'recheckEvidence', options: { errors: { findQnaEvidence: mongoServerError(), findQnaEvidenceCall: 2 } } },
    ]

    for (const scenario of scenarios) {
      const repo = repository(scenario.options)
      const provider = vi.fn(async () => ({ paragraphs: [{ text: 'Kết luận có căn cứ.', citationIds: ['C1'], evidenceBlockIds: ['E1'] }] }))
      const service = createQaService({
        chatRepository: repo,
        articleRepository: repo,
        providerRouter: createProviderRouterFixture(),
        providerAdapters: { llmProvider: { answer: provider } },
        supportVerifier: vi.fn(async () => ({ verdict: 'supported', addressesQuestion: true, evidenceBlockIds: ['E1'] })),
      })

      let error
      try {
        await service.createAnswer({ auth, question: 'Bài viết kết luận gì?', scope: { articleId: 'article-1' }, idempotencyKey: `mongo-${scenario.stage}-117`, ...scenario.request })
      } catch (caught) {
        error = caught
      }
      assertServiceUnavailable(error)
      expect(provider, scenario.stage).not.toHaveBeenCalled()
    }
  })

  it('maps MongoServerError code 117 from appendAnswer after provider completion', async () => {
    const repo = repository({ appendError: mongoServerError() })
    const provider = vi.fn(async () => ({ paragraphs: [{ text: 'Kết luận có căn cứ.', citationIds: ['C1'], evidenceBlockIds: ['E1'] }] }))
    const supportVerifier = vi.fn(async () => ({ verdict: 'supported', addressesQuestion: true, evidenceBlockIds: ['E1'] }))
    const service = createQaService({
      chatRepository: repo,
      articleRepository: repo,
      providerRouter: createProviderRouterFixture(),
      providerAdapters: { llmProvider: { answer: provider } },
      supportVerifier,
    })

    let error
    try {
      await service.createAnswer({ auth, question: 'Bài viết kết luận gì?', scope: { articleId: 'article-1' }, idempotencyKey: 'append-mongo-117' })
    } catch (caught) {
      error = caught
    }

    expect(provider).toHaveBeenCalledTimes(1)
    expect(supportVerifier).toHaveBeenCalledTimes(1)
    expect(repo.appendAnswer).toHaveBeenCalledTimes(1)
    assertServiceUnavailable(error)
  })
})
