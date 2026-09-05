import { describe, expect, it, vi } from 'vitest'
import { createQaService as createQaServiceImpl, scopeValue } from '../../../server/application/qa/service.js'
import { ProviderRoutingError } from '../../../server/ai/provider-router.js'
import { ProviderAdapterError } from '../../../server/ai/provider-error-taxonomy.js'

const auth = {
  user: { id: 'user-1', status: 'active', sessionVersion: 3 },
  session: { id: 'session-1', userSessionVersion: 3 },
}

function routerFixture({ routes = {}, providerAdmission } = {}) {
  const route = (routeId, providerFailureDomainId = 'domain-a', model = `${routeId}-model`) => ({ routeId: routeId ?? 'qa-primary', providerFailureDomainId, model })
  const primary = route(routes.primary ?? 'primary')
  const fallback = routes.fallback ? route(routes.fallback, routes.fallbackDomain ?? primary.providerFailureDomainId, `${routes.fallback}-model`) : null
  const support = route(routes.support ?? 'support', routes.supportDomain ?? primary.providerFailureDomainId, 'support-model')
  const call = async ({ routeValue, workloadId, admittedInput, invoke }) => {
    const kind = workloadId === 'qa-generation' ? 'answer-primary' : 'answer-support'
    if (providerAdmission?.run) return providerAdmission.run({ routeId: routeValue.routeId, capability: 'zdr-verified', attemptId: 'test-attempt', kind, invoke: () => invoke({ route: routeValue, admittedInput }) })
    return invoke({ route: routeValue, admittedInput })
  }
  return {
    async execute({ workloadId, admittedInput, invoke, validateOutput }) {
      if (workloadId === 'qa-support') {
        const output = await call({ routeValue: support, workloadId, admittedInput, invoke })
        return { output: validateOutput({ route: support, output, admittedInput }), metadata: { routeId: support.routeId, providerFailureDomainId: support.providerFailureDomainId, fallback: 'none' } }
      }
      try {
        const output = await call({ routeValue: primary, workloadId, admittedInput, invoke })
        return { output: validateOutput({ route: primary, output, admittedInput }), metadata: { routeId: primary.routeId, providerFailureDomainId: primary.providerFailureDomainId, fallback: 'none' } }
      } catch (error) {
        if (!fallback || !error?.retryable && !['model-retryable', 'provider-retryable'].includes(error?.failureClass)) throw error
        const output = await call({ routeValue: fallback, workloadId, admittedInput, invoke })
        return { output: validateOutput({ route: fallback, output, admittedInput }), metadata: { routeId: fallback.routeId, providerFailureDomainId: fallback.providerFailureDomainId, fallback: fallback.providerFailureDomainId === primary.providerFailureDomainId ? 'model' : 'provider' } }
      }
    },
  }
}

function createQaService(options = {}) {
  return createQaServiceImpl({ ...options, providerRouter: options.providerRouter ?? routerFixture(options) })
}

function repository({ records = [] } = {}) {
  const attempts = new Map()
  const sessions = []
  return {
    attempts,
    sessions,
    async reserveAnswerAttempt({ idempotencyKeyHash, requestHash, chatSessionId }) {
      const current = attempts.get(idempotencyKeyHash)
      if (current) {
        if (current.requestHash !== requestHash) Object.assign(current, { status: 'mismatch' })
        return current
      }
      const value = { _id: `attempt-${attempts.size + 1}`, idempotencyKeyHash, requestHash, status: 'reserved', ...(chatSessionId ? { chatSessionId } : {}) }
      attempts.set(idempotencyKeyHash, value)
      return value
    },
    async updateAnswerAttempt(id, update) {
      const value = [...attempts.values()].find((item) => item._id === id)
      Object.assign(value, update)
      return value
    },
    async appendAnswer({ answer, question, chatSessionId, citations }) {
      const value = { chatSessionId: chatSessionId ?? 'chat-1', messageId: answer.id, answer: { ...answer, chatSessionId: chatSessionId ?? 'chat-1' }, question, citations }
      sessions.push(value)
      return value
    },
    async appendRefusalWithoutQuestion({ answer, chatSessionId, attempt }) {
      const value = { chatSessionId: chatSessionId ?? 'chat-1', messageId: answer.id, answer: { ...answer, chatSessionId: chatSessionId ?? 'chat-1' } }
      sessions.push(value)
      if (attempt?.id) {
        const receipt = [...attempts.values()].find((item) => item._id === attempt.id)
        Object.assign(receipt, { status: 'refused', resultStatus: 'refused', chatSessionId: value.chatSessionId, messageId: value.messageId })
      }
      return { ...value, ...(attempt?.id ? { attemptCommitted: true } : {}) }
    },
    async findQnaEvidence() { return records },
  }
}

function evidence() {
  return [{
    article: { id: 'article-1', sourceId: 'source-1', status: 'published', evidenceEligible: true, titleOriginal: 'Nghiên cứu AI', originalUrl: 'https://example.com/a', publishedAt: '2026-08-10T00:00:00Z', excerptOriginal: 'Kết quả cho thấy hệ thống hoạt động ổn định.', rightsSnapshot: { sourcePolicyVersion: 1, licenseStatus: 'permitted', llmInputScope: 'excerpt' } },
    source: { id: 'source-1', name: 'Nguồn biên tập', authorityTier: 'editorial', operationalStatus: 'active', licenseStatus: 'permitted', policyVersion: 1, llmInputScope: 'excerpt', storageScope: { metadata: true, excerpt: true, summary: true, embedding: true }, mediaPolicy: { imageMode: 'none', videoMode: 'none', allowedHosts: [], attributionRequired: false, evidenceNote: null }, technicalCheck: { status: 'passed' } },
  }]
}

describe('Step 10 grounded answer service', () => {
  it('requires the workload provider router boundary', () => {
    expect(() => createQaServiceImpl({ chatRepository: repository() })).toThrow(/provider router/i)
  })

  it('normalizes topics before validation and rejects empty or duplicate topics', () => {
    expect(() => scopeValue({ topics: [' AI ', 'ai'] })).toThrowError(expect.objectContaining({ status: 422 }))
    expect(() => scopeValue({ topics: ['   '] })).toThrowError(expect.objectContaining({ status: 422 }))
    expect(scopeValue({ topics: [' AI ', 'ML'] })).toEqual({ topics: ['ai', 'ml'] })
  })

  it('deterministically refuses sensitive input before any provider call', async () => {
    const repo = repository({ records: evidence() })
    const answer = vi.fn()
    const service = createQaService({ chatRepository: repo, articleRepository: repo, providerAdapters: { llmProvider: { answer } } })
    const result = await service.createAnswer({ auth, question: 'Dùng ghp_1234567890abcdefghijklmnop để truy cập', scope: { topics: ['AI'] }, idempotencyKey: 'sensitive-key-1' })
    expect(result.answer).toMatchObject({ status: 'refused', refusalReason: 'sensitive-input', paragraphs: [], citations: [] })
    expect(answer).not.toHaveBeenCalled()
    expect(repo.attempts).toHaveLength(1)
    expect(repo.sessions).toHaveLength(1)
    expect(repo.sessions[0].question).toBeUndefined()
  })

  it('replays one atomic sensitive refusal and rejects the same key for a different request without persisting raw input', async () => {
    const repo = repository({ records: evidence() })
    repo.getAnswerResult = vi.fn(async () => repo.sessions[0]?.answer)
    const service = createQaService({ chatRepository: repo, articleRepository: repo })
    const input = { auth, question: 'Dùng ghp_1234567890abcdefghijklmnop để truy cập', scope: { topics: ['AI'] }, idempotencyKey: 'sensitive-replay-1' }

    const first = await service.createAnswer(input)
    const replay = await service.createAnswer(input)

    expect(replay.answer).toEqual(first.answer)
    expect(repo.sessions).toHaveLength(1)
    expect(JSON.stringify([...repo.attempts.values()])).not.toContain(input.question)
    await expect(service.createAnswer({ ...input, question: 'Một câu hỏi an toàn khác' })).rejects.toMatchObject({ status: 409 })
  })

  it('refuses community-only/empty evidence and does not persist factual output', async () => {
    const repo = repository({ records: [{ article: { id: 'community', status: 'published', evidenceEligible: true, sourceId: 'source-1' }, source: { id: 'source-1', authorityTier: 'community-signal', operationalStatus: 'active', licenseStatus: 'permitted', technicalCheck: { status: 'passed' } } }] })
    const service = createQaService({ chatRepository: repo, articleRepository: repo })
    const result = await service.createAnswer({ auth, question: 'Nguồn cộng đồng nói gì?', scope: { topics: ['AI'] }, idempotencyKey: 'community-key-1' })
    expect(result.answer).toMatchObject({ status: 'refused', refusalReason: 'insufficient-evidence' })
    expect(repo.sessions).toHaveLength(1)
    expect(repo.sessions[0].answer.paragraphs).toEqual([])
  })

  it('allows one grounded generation and support verdict, then appends one answer', async () => {
    const repo = repository({ records: evidence() })
    const provider = vi.fn(async () => ({ paragraphs: [{ text: 'Bài viết mô tả kết quả ổn định.', citationIds: ['C1'], evidenceBlockIds: ['E1'] }] }))
    const supportVerifier = vi.fn(async () => ({ verdict: 'supported', addressesQuestion: true, evidenceBlockIds: ['E1'] }))
    const service = createQaService({ chatRepository: repo, articleRepository: repo, providerAdapters: { llmProvider: { answer: provider } }, routes: { primary: 'primary' }, supportVerifier })
    const result = await service.createAnswer({ auth, question: 'Bài viết kết luận gì?', scope: { articleId: 'article-1' }, idempotencyKey: 'grounded-key-1' })
    expect(result.answer).toMatchObject({ status: 'answered', citations: [{ id: 'C1', originalUrl: 'https://example.com/a' }] })
    expect(provider).toHaveBeenCalledTimes(1)
    expect(repo.sessions).toHaveLength(1)
    expect([...repo.attempts.values()][0]).toMatchObject({ status: 'completed', resultStatus: 'answered' })
    expect(supportVerifier).toHaveBeenCalledWith(expect.objectContaining({
      paragraphs: [expect.objectContaining({ evidenceBlockIds: ['E1'] })],
      evidenceBlocks: [expect.objectContaining({ id: 'E1', citationId: 'C1', text: expect.stringContaining('Kết quả cho thấy hệ thống hoạt động ổn định.') })],
      evidenceMap: { E1: 'C1' },
    }))
  })

  it('uses the repository transaction to bind an answered chat write to its receipt', async () => {
    const repo = repository({ records: evidence() })
    const originalAppend = repo.appendAnswer
    repo.appendAnswer = vi.fn(async (input) => ({ ...await originalAppend(input), attemptCommitted: true }))
    const updateAttempt = vi.spyOn(repo, 'updateAnswerAttempt')
    const service = createQaService({ chatRepository: repo, articleRepository: repo, providerAdapters: { llmProvider: { answer: async () => ({ paragraphs: [{ text: 'Kết luận có căn cứ.', citationIds: ['C1'], evidenceBlockIds: ['E1'] }] }) } }, routes: { primary: 'primary' }, supportVerifier: async () => ({ verdict: 'supported', addressesQuestion: true, evidenceBlockIds: ['E1'] }) })

    await service.createAnswer({ auth, question: 'Kết luận là gì?', scope: { articleId: 'article-1' }, idempotencyKey: 'atomic-receipt-key' })

    expect(repo.appendAnswer).toHaveBeenCalledWith(expect.objectContaining({ attempt: expect.objectContaining({ outcome: 'completed' }) }))
    expect(updateAttempt).toHaveBeenCalledTimes(3)
  })

  it('rejects a provider paragraph that lacks the exact internal evidence block ID', async () => {
    const repo = repository({ records: evidence() })
    const provider = vi.fn(async () => ({ paragraphs: [{ text: 'Kết luận không có block.', citationIds: ['C1'] }] }))
    const service = createQaService({ chatRepository: repo, articleRepository: repo, providerAdapters: { llmProvider: { answer: provider } }, routes: { primary: 'primary' }, supportVerifier: async () => ({ verdict: 'supported', addressesQuestion: true, evidenceBlockIds: ['E1'] }) })

    const result = await service.createAnswer({ auth, question: 'Bài viết kết luận gì?', scope: { articleId: 'article-1' }, idempotencyKey: 'missing-block-key' })

    expect(result.answer).toMatchObject({ status: 'refused', refusalReason: 'provider-unavailable', paragraphs: [], citations: [] })
    expect(repo.sessions).toHaveLength(1)
    expect(repo.sessions[0].answer).not.toHaveProperty('evidenceBlockIds')
  })

  it('rejects idempotency key reuse with a different request hash', async () => {
    const repo = repository({ records: evidence() })
    const service = createQaService({ chatRepository: repo, articleRepository: repo })
    await service.createAnswer({ auth, question: 'Câu hỏi đầu tiên', scope: { topics: ['AI'] }, idempotencyKey: 'same-key-1' })
    await expect(service.createAnswer({ auth, question: 'Câu hỏi khác', scope: { topics: ['AI'] }, idempotencyKey: 'same-key-1' })).rejects.toMatchObject({ status: 409, code: 'idempotency_mismatch' })
  })

  it('binds idempotency to the exact normalized time range', async () => {
    const repo = repository({ records: evidence() })
    const service = createQaService({ chatRepository: repo, articleRepository: repo })
    const base = { auth, question: 'Câu hỏi theo thời gian', idempotencyKey: 'date-range-key' }
    await service.createAnswer({ ...base, scope: { publishedAfter: '2026-08-01T00:00:00.000Z', publishedBefore: '2026-08-02T00:00:00.000Z' } })
    await expect(service.createAnswer({ ...base, scope: { publishedAfter: '2026-08-03T00:00:00.000Z', publishedBefore: '2026-08-04T00:00:00.000Z' } })).rejects.toMatchObject({ status: 409, code: 'idempotency_mismatch' })
  })

  it('derives UTC temporal bounds before repository retrieval and persists the effective scope', async () => {
    const fixedNow = new Date('2026-09-04T15:30:00.000Z')
    const repo = repository({ records: evidence() })
    const findScopes = []
    const originalFind = repo.findQnaEvidence
    repo.findQnaEvidence = vi.fn(async (input) => {
      findScopes.push(input.scope)
      return originalFind()
    })
    const originalAppend = repo.appendAnswer
    repo.appendAnswer = vi.fn(async (input) => originalAppend(input))
    const service = createQaService({ chatRepository: repo, articleRepository: repo, now: () => fixedNow })

    const result = await service.createAnswer({
      auth,
      question: 'tháng 9 này có tin tức gì về các model AI mới không',
      scope: { topics: ['AI'] },
      idempotencyKey: 'temporal-service-key',
    })

    expect(result.answer.status).toBe('refused')
    expect(findScopes[0]).toEqual({
      topics: ['ai'],
      publishedAfter: new Date('2026-09-01T00:00:00.000Z'),
      publishedBefore: new Date('2026-09-30T23:59:59.999Z'),
    })
    expect(repo.appendAnswer).toHaveBeenCalledWith(expect.objectContaining({
      scope: {
        topics: ['ai'],
        publishedAfter: new Date('2026-09-01T00:00:00.000Z'),
        publishedBefore: new Date('2026-09-30T23:59:59.999Z'),
      },
    }))
  })

  it('does not reserve quota or call a provider for a missing or foreign continuation session', async () => {
    const repo = repository({ records: evidence() })
    repo.getChatSession = vi.fn(async () => null)
    const provider = vi.fn()
    const service = createQaService({ chatRepository: repo, articleRepository: repo, providerAdapters: { llmProvider: { answer: provider } } })

    await expect(service.createAnswer({ auth, question: 'Tiếp tục cuộc trò chuyện này', scope: { topics: ['AI'] }, chatSessionId: '507f1f77bcf86cd799439099', idempotencyKey: 'missing-session-key' })).rejects.toMatchObject({ status: 404, code: 'not_found' })

    expect(repo.getChatSession).toHaveBeenCalledTimes(1)
    expect(repo.attempts).toHaveLength(0)
    expect(provider).not.toHaveBeenCalled()
  })

  it('rejects continuation when its scope differs from the persisted session scope', async () => {
    const repo = repository({ records: evidence() })
    repo.getChatSession = vi.fn(async () => ({ id: '507f1f77bcf86cd799439099', scope: { topics: ['ml'] } }))
    const service = createQaService({ chatRepository: repo, articleRepository: repo })

    await expect(service.createAnswer({ auth, question: 'Tiếp tục phiên này', scope: { topics: ['AI'] }, chatSessionId: '507f1f77bcf86cd799439099', idempotencyKey: 'scope-conflict-key' })).rejects.toMatchObject({ status: 409, code: 'conflict' })
    expect(repo.attempts).toHaveLength(0)
  })

  it('treats normalized continuation topics as an unordered scope', async () => {
    const repo = repository({ records: evidence() })
    repo.getChatSession = vi.fn(async () => ({ id: '507f1f77bcf86cd799439099', scope: { topics: ['ml', 'ai'] } }))
    const provider = vi.fn(async () => ({ paragraphs: [{ text: 'Kết luận có căn cứ.', citationIds: ['C1'], evidenceBlockIds: ['E1'] }] }))
    const service = createQaService({ chatRepository: repo, articleRepository: repo, providerAdapters: { llmProvider: { answer: provider } }, routes: { primary: 'primary' }, supportVerifier: async () => ({ verdict: 'supported', addressesQuestion: true, evidenceBlockIds: ['E1'] }) })

    const result = await service.createAnswer({ auth, question: 'Tiếp tục phiên này', scope: { topics: [' AI ', 'ML'] }, chatSessionId: '507f1f77bcf86cd799439099', idempotencyKey: 'scope-order-key' })

    expect(result.answer.status).toBe('answered')
    expect(provider).toHaveBeenCalledTimes(1)
  })

  it('appends a provider-unavailable refusal to the selected continuation session', async () => {
    const repo = repository({ records: evidence() })
    repo.getChatSession = vi.fn(async () => ({ id: '507f1f77bcf86cd799439099' }))
    const service = createQaService({ chatRepository: repo, articleRepository: repo, providerAdapters: { llmProvider: { answer: vi.fn() } }, routes: { primary: 'primary' } })

    const result = await service.createAnswer({ auth, question: 'Tiếp tục với nguồn này', scope: { topics: ['AI'] }, chatSessionId: '507f1f77bcf86cd799439099', idempotencyKey: 'continuation-refusal-key' })

    expect(result.answer).toMatchObject({ status: 'refused', chatSessionId: '507f1f77bcf86cd799439099' })
    expect(repo.sessions).toHaveLength(1)
    expect(repo.sessions[0].chatSessionId).toBe('507f1f77bcf86cd799439099')
  })

  it('fails closed before answer or support providers when current source input contains a credential', async () => {
    const repo = repository({ records: evidence().map((record) => ({ ...record, article: { ...record.article, excerptOriginal: 'github_pat_1234567890abcdefghijklmnop' } })) })
    const answer = vi.fn()
    const supportVerifier = vi.fn()
    const service = createQaService({ chatRepository: repo, articleRepository: repo, providerAdapters: { llmProvider: { answer } }, supportVerifier, routes: { primary: 'primary' } })
    const result = await service.createAnswer({ auth, question: 'Bài viết nói gì?', scope: { topics: ['AI'] }, idempotencyKey: 'source-credential-key' })
    expect(result.answer).toMatchObject({ status: 'refused', refusalReason: 'policy-blocked' })
    expect(answer).not.toHaveBeenCalled()
    expect(supportVerifier).not.toHaveBeenCalled()
  })

  it('does not call a provider after the actor fence is lost during provider reservation', async () => {
    const repo = repository({ records: evidence() })
    repo.assertActorFence = vi.fn(async () => false)
    const answer = vi.fn()
    const service = createQaService({ chatRepository: repo, articleRepository: repo, providerAdapters: { llmProvider: { answer } }, routes: { primary: 'primary' } })

    await expect(service.createAnswer({ auth, question: 'Bài viết kết luận gì?', scope: { articleId: 'article-1' }, idempotencyKey: 'lost-fence-key' })).rejects.toMatchObject({ status: 401, code: 'unauthorized' })

    expect(answer).not.toHaveBeenCalled()
    expect([...repo.attempts.values()][0]).toMatchObject({ status: 'failed', error: expect.objectContaining({ code: 'actor_fence_lost' }) })
  })

  it('rechecks the actor fence before the support provider after answer generation', async () => {
    const repo = repository({ records: evidence() })
    repo.assertActorFence = vi.fn()
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(false)
    const answer = vi.fn(async () => ({ paragraphs: [{ text: 'Kết luận có căn cứ.', citationIds: ['C1'], evidenceBlockIds: ['E1'] }] }))
    const supportVerifier = vi.fn(async () => ({ verdict: 'supported', addressesQuestion: true, evidenceBlockIds: ['E1'] }))
    const service = createQaService({ chatRepository: repo, articleRepository: repo, providerAdapters: { llmProvider: { answer } }, routes: { primary: 'primary', support: 'support' }, supportVerifier })

    await expect(service.createAnswer({ auth, question: 'Bài viết kết luận gì?', scope: { articleId: 'article-1' }, idempotencyKey: 'lost-before-support-key' })).rejects.toMatchObject({ status: 401, code: 'unauthorized' })

    expect(answer).toHaveBeenCalledTimes(1)
    expect(supportVerifier).not.toHaveBeenCalled()
  })

  it('does not call a fallback provider after the actor fence is lost following a retryable primary failure', async () => {
    const repo = repository({ records: evidence() })
    repo.assertActorFence = vi.fn()
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(false)
    const primary = vi.fn(async () => { throw Object.assign(new Error('retryable'), { retryable: true }) })
    const fallback = vi.fn()
    const service = createQaService({ chatRepository: repo, articleRepository: repo, providerAdapters: { llmProvider: { answer: vi.fn(async ({ route }) => route.routeId === 'primary' ? primary() : fallback()) } }, routes: { primary: 'primary', fallback: 'fallback' } })

    await expect(service.createAnswer({ auth, question: 'Bài viết kết luận gì?', scope: { articleId: 'article-1' }, idempotencyKey: 'lost-before-fallback-key' })).rejects.toMatchObject({ status: 401, code: 'unauthorized' })

    expect(primary).toHaveBeenCalledTimes(1)
    expect(fallback).not.toHaveBeenCalled()
  })

  it('re-reads evidence after the actor fence and blocks a revoked article before the primary provider', async () => {
    const repo = repository({ records: evidence() })
    let records = evidence()
    repo.findQnaEvidence = vi.fn(async () => records)
    repo.assertActorFence = vi.fn(async () => {
      records = records.map((record) => ({ ...record, article: { ...record.article, status: 'hidden' } }))
      return true
    })
    const answer = vi.fn()
    const service = createQaService({ chatRepository: repo, articleRepository: repo, providerAdapters: { llmProvider: { answer } }, routes: { primary: 'primary' } })

    const result = await service.createAnswer({ auth, question: 'Bài viết kết luận gì?', scope: { articleId: 'article-1' }, idempotencyKey: 'revoke-before-primary' })

    expect(result.answer).toMatchObject({ status: 'refused', refusalReason: 'insufficient-evidence' })
    expect(answer).not.toHaveBeenCalled()
  })

  it('re-reads evidence and blocks a policy-version change before the fallback provider', async () => {
    const repo = repository({ records: evidence() })
    let records = evidence()
    repo.findQnaEvidence = vi.fn(async () => records)
    const primary = vi.fn(async () => {
      records = records.map((record) => ({ ...record, source: { ...record.source, policyVersion: 2 } }))
      throw Object.assign(new Error('retryable'), { retryable: true })
    })
    const fallback = vi.fn()
    const answer = vi.fn(async ({ route }) => route.routeId === 'primary' ? primary() : fallback())
    const service = createQaService({ chatRepository: repo, articleRepository: repo, providerAdapters: { llmProvider: { answer } }, routes: { primary: 'primary', fallback: 'fallback' } })

    await expect(service.createAnswer({ auth, question: 'Bài viết kết luận gì?', scope: { articleId: 'article-1' }, idempotencyKey: 'policy-before-fallback' })).rejects.toMatchObject({ status: 409, code: 'conflict' })
    expect(primary).toHaveBeenCalledTimes(1)
    expect(fallback).not.toHaveBeenCalled()
    expect(repo.findQnaEvidence).toHaveBeenCalledTimes(3)
  })

  it('re-reads evidence and blocks an input-scope change before the support provider', async () => {
    const repo = repository({ records: evidence() })
    let records = evidence()
    repo.findQnaEvidence = vi.fn(async () => records)
    const answer = vi.fn(async () => {
      records = records.map((record) => ({
        ...record,
        article: { ...record.article, rightsSnapshot: { ...record.article.rightsSnapshot, licenseStatus: 'metadata-only', llmInputScope: 'metadata' } },
        source: { ...record.source, licenseStatus: 'metadata-only', llmInputScope: 'metadata', storageScope: { ...record.source.storageScope, excerpt: false } },
      }))
      return { paragraphs: [{ text: 'Kết luận có căn cứ.', citationIds: ['C1'], evidenceBlockIds: ['E1'] }] }
    })
    const supportVerifier = vi.fn()
    const service = createQaService({ chatRepository: repo, articleRepository: repo, providerAdapters: { llmProvider: { answer } }, routes: { primary: 'primary', support: 'support' }, supportVerifier })

    await expect(service.createAnswer({ auth, question: 'Bài viết kết luận gì?', scope: { articleId: 'article-1' }, idempotencyKey: 'scope-before-support' })).rejects.toMatchObject({ status: 409, code: 'conflict' })
    expect(answer).toHaveBeenCalledTimes(1)
    expect(supportVerifier).not.toHaveBeenCalled()
    expect(repo.findQnaEvidence).toHaveBeenCalledTimes(3)
  })

  it('fails closed when the support verdict is not bound to the exact evidence block set', async () => {
    const repo = repository({ records: evidence() })
    const answer = vi.fn(async () => ({ paragraphs: [{ text: 'Kết luận có căn cứ.', citationIds: ['C1'], evidenceBlockIds: ['E1'] }] }))
    const supportVerifier = vi.fn(async () => ({ verdict: 'supported', addressesQuestion: true, evidenceBlockIds: ['E2'] }))
    const service = createQaService({ chatRepository: repo, articleRepository: repo, providerAdapters: { llmProvider: { answer } }, routes: { primary: 'primary', support: 'support' }, supportVerifier })

    const result = await service.createAnswer({ auth, question: 'Bài viết kết luận gì?', scope: { articleId: 'article-1' }, idempotencyKey: 'mismatched-support-set' })

    expect(result.answer).toMatchObject({ status: 'refused', refusalReason: 'insufficient-evidence' })
    expect(repo.sessions[0].answer.paragraphs).toEqual([])
  })

  it('refuses visible evidence that does not address the admitted question', async () => {
    const repo = repository({ records: evidence() })
    const answer = vi.fn(async () => ({ paragraphs: [{ text: 'Kết luận có căn cứ.', citationIds: ['C1'], evidenceBlockIds: ['E1'] }] }))
    const supportVerifier = vi.fn(async () => ({ verdict: 'supported', addressesQuestion: false, evidenceBlockIds: ['E1'] }))
    const service = createQaService({ chatRepository: repo, articleRepository: repo, providerAdapters: { llmProvider: { answer } }, routes: { primary: 'primary', support: 'support' }, supportVerifier })

    const result = await service.createAnswer({ auth, question: 'Dữ liệu này nói về thời tiết gì?', scope: { articleId: 'article-1' }, idempotencyKey: 'irrelevant-visible-key' })

    expect(result.answer).toMatchObject({ status: 'refused', refusalReason: 'insufficient-evidence' })
    expect(supportVerifier).toHaveBeenCalledWith(expect.objectContaining({ question: 'Dữ liệu này nói về thời tiết gì?' }))
  })

  it('fails closed when the support verifier does not explicitly confirm the question is addressed', async () => {
    const repo = repository({ records: evidence() })
    const answer = vi.fn(async () => ({ paragraphs: [{ text: 'Kết luận có căn cứ.', citationIds: ['C1'], evidenceBlockIds: ['E1'] }] }))
    const supportVerifier = vi.fn(async () => ({ verdict: 'supported', evidenceBlockIds: ['E1'] }))
    const service = createQaService({ chatRepository: repo, articleRepository: repo, providerAdapters: { llmProvider: { answer } }, routes: { primary: 'primary', support: 'support' }, supportVerifier })

    const result = await service.createAnswer({ auth, question: 'Bài viết kết luận gì?', scope: { articleId: 'article-1' }, idempotencyKey: 'missing-address-confirmation' })

    expect(result.answer).toMatchObject({ status: 'refused', refusalReason: 'provider-unavailable' })
    expect(repo.sessions[0].answer.paragraphs).toEqual([])
  })

  it('discards a lifecycle or policy race without appending refusal chat or terminal outcome', async () => {
    const repo = repository({ records: evidence() })
    let records = evidence()
    repo.findQnaEvidence = vi.fn(async () => records)
    const providerAdmission = {
      run: vi.fn(async ({ invoke, routeId }) => {
        records = records.map((record) => ({ ...record, article: { ...record.article, status: 'hidden' } }))
        return invoke(routeId)
      }),
    }
    const answer = vi.fn()
    const service = createQaService({ chatRepository: repo, articleRepository: repo, providerAdmission, providerAdapters: { llmProvider: { answer } }, routes: { primary: 'primary' } })

    await expect(service.createAnswer({ auth, question: 'Bài viết kết luận gì?', scope: { articleId: 'article-1' }, idempotencyKey: 'discard-race-key' })).rejects.toMatchObject({ status: 409, code: 'conflict' })
    expect(answer).not.toHaveBeenCalled()
    expect(repo.sessions).toHaveLength(0)
    expect([...repo.attempts.values()][0]).not.toMatchObject({ status: 'refused', resultStatus: 'refused' })
  })

  it('discards a newly sensitive source input race without appending refusal chat or terminal outcome', async () => {
    const repo = repository({ records: evidence() })
    let records = evidence()
    repo.findQnaEvidence = vi.fn(async () => records)
    const providerAdmission = {
      run: vi.fn(async ({ invoke, routeId, kind }) => {
        if (kind === 'answer-primary') records = records.map((record) => ({ ...record, article: { ...record.article, excerptOriginal: 'ghp_1234567890abcdefghijklmnop' } }))
        return invoke(routeId)
      }),
    }
    const answer = vi.fn()
    const service = createQaService({ chatRepository: repo, articleRepository: repo, providerAdmission, providerAdapters: { llmProvider: { answer } }, routes: { primary: 'primary' } })

    await expect(service.createAnswer({ auth, question: 'Bài viết kết luận gì?', scope: { articleId: 'article-1' }, idempotencyKey: 'discard-sensitive-race' })).rejects.toMatchObject({ status: 409, code: 'conflict' })
    expect(answer).not.toHaveBeenCalled()
    expect(repo.sessions).toHaveLength(0)
    expect([...repo.attempts.values()][0]).not.toMatchObject({ status: 'refused', resultStatus: 'refused' })
  })

  it('does not create a refusal when final append CAS loses the article lifecycle race', async () => {
    const repo = repository({ records: evidence() })
    repo.appendAnswer = vi.fn(async () => { throw Object.assign(new Error('article lifecycle changed'), { status: 409, code: 'conflict' }) })
    const answer = vi.fn(async () => ({ paragraphs: [{ text: 'Kết luận có căn cứ.', citationIds: ['C1'], evidenceBlockIds: ['E1'] }] }))
    const service = createQaService({ chatRepository: repo, articleRepository: repo, providerAdapters: { llmProvider: { answer } }, routes: { primary: 'primary' }, supportVerifier: async () => ({ verdict: 'supported', addressesQuestion: true, evidenceBlockIds: ['E1'] }) })

    await expect(service.createAnswer({ auth, question: 'Bài viết kết luận gì?', scope: { articleId: 'article-1' }, idempotencyKey: 'append-cas-race' })).rejects.toMatchObject({ status: 409, code: 'conflict' })
    expect(repo.sessions).toHaveLength(0)
    expect([...repo.attempts.values()][0]).not.toMatchObject({ status: 'refused', resultStatus: 'refused' })
  })

  it('does not create a refusal when final append CAS loses the active user lifecycle race', async () => {
    const repo = repository({ records: evidence() })
    repo.appendAnswer = vi.fn(async () => { throw Object.assign(new Error('user lifecycle changed'), { status: 409, code: 'conflict' }) })
    const answer = vi.fn(async () => ({ paragraphs: [{ text: 'Kết luận có căn cứ.', citationIds: ['C1'], evidenceBlockIds: ['E1'] }] }))
    const service = createQaService({ chatRepository: repo, articleRepository: repo, providerAdapters: { llmProvider: { answer } }, routes: { primary: 'primary' }, supportVerifier: async () => ({ verdict: 'supported', addressesQuestion: true, evidenceBlockIds: ['E1'] }) })

    await expect(service.createAnswer({ auth, question: 'Bài viết kết luận gì?', scope: { articleId: 'article-1' }, idempotencyKey: 'append-user-cas-race' })).rejects.toMatchObject({ status: 409, code: 'conflict' })
    expect(repo.sessions).toHaveLength(0)
  })

  it('allows one execution owner for twenty concurrent same-key requests', async () => {
    const records = evidence()
    const attempts = new Map()
    const sessions = []
    let providerCalls = 0
    let quotaReservations = 0
    const repo = {
      attempts,
      sessions,
      async reserveAnswerAttempt({ idempotencyKeyHash, requestHash, chatSessionId, rateLimitAdmission }) {
        await new Promise((resolve) => setTimeout(resolve, 0))
        const current = attempts.get(idempotencyKeyHash)
        if (current) return { ...current, reused: true }
        for (const scope of ['answer-minute', 'answer-daily']) {
          await rateLimitAdmission.reserve({ scope })
          quotaReservations += 1
        }
        const value = { _id: 'attempt-concurrent', idempotencyKeyHash, requestHash, status: 'reserved', ...(chatSessionId ? { chatSessionId } : {}) }
        attempts.set(idempotencyKeyHash, value)
        return value
      },
      async updateAnswerAttempt(_id, update) { const value = [...attempts.values()][0]; Object.assign(value, update); return value },
      async appendAnswer({ answer, chatSessionId }) { const value = { chatSessionId: chatSessionId ?? 'chat-1', messageId: answer.id, answer: { ...answer, chatSessionId: chatSessionId ?? 'chat-1' } }; sessions.push(value); return value },
      async findQnaEvidence() { return records },
    }
    const answer = vi.fn(async () => { providerCalls += 1; await new Promise((resolve) => setTimeout(resolve, 15)); return { paragraphs: [{ text: 'Kết luận có căn cứ.', citationIds: ['C1'], evidenceBlockIds: ['E1'] }] } })
    const rateLimitAdmission = { reserve: vi.fn(async () => ({ allowed: true })) }
    const service = createQaService({ chatRepository: repo, articleRepository: repo, rateLimitAdmission, providerAdapters: { llmProvider: { answer } }, routes: { primary: 'primary' }, supportVerifier: async () => ({ verdict: 'supported', addressesQuestion: true, evidenceBlockIds: ['E1'] }) })

    const results = await Promise.allSettled(Array.from({ length: 20 }, () => service.createAnswer({ auth, question: 'Bài viết kết luận gì?', scope: { articleId: 'article-1' }, idempotencyKey: 'concurrent-same-key' })))

    expect(providerCalls).toBe(1)
    expect(quotaReservations).toBe(2)
    expect(rateLimitAdmission.reserve).toHaveBeenCalledTimes(2)
    expect(sessions).toHaveLength(1)
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1)
  })

  it('performs the final primary evidence read inside provider admission invoke', async () => {
    const repo = repository({ records: evidence() })
    let records = evidence()
    repo.findQnaEvidence = vi.fn(async () => records)
    const answer = vi.fn()
    const providerAdmission = {
      run: vi.fn(async ({ invoke, routeId }) => {
        records = records.map((record) => ({ ...record, article: { ...record.article, status: 'hidden' } }))
        return invoke(routeId)
      }),
    }
    const service = createQaService({ chatRepository: repo, articleRepository: repo, providerAdmission, providerAdapters: { llmProvider: { answer } }, routes: { primary: 'primary' } })

    await expect(service.createAnswer({ auth, question: 'Bài viết kết luận gì?', scope: { articleId: 'article-1' }, idempotencyKey: 'admission-primary-race' })).rejects.toMatchObject({ status: 409, code: 'conflict' })
    expect(answer).not.toHaveBeenCalled()
  })

  it('performs the final support evidence read inside provider admission invoke', async () => {
    const repo = repository({ records: evidence() })
    let records = evidence()
    repo.findQnaEvidence = vi.fn(async () => records)
    const answer = vi.fn(async () => ({ paragraphs: [{ text: 'Kết luận có căn cứ.', citationIds: ['C1'], evidenceBlockIds: ['E1'] }] }))
    const supportVerifier = vi.fn()
    const providerAdmission = {
      run: vi.fn(async ({ invoke, kind, routeId }) => {
        if (kind === 'answer-support') records = records.map((record) => ({ ...record, source: { ...record.source, policyVersion: 2 } }))
        return invoke(routeId)
      }),
    }
    const service = createQaService({ chatRepository: repo, articleRepository: repo, providerAdmission, providerAdapters: { llmProvider: { answer } }, routes: { primary: 'primary', support: 'support' }, supportVerifier })

    await expect(service.createAnswer({ auth, question: 'Bài viết kết luận gì?', scope: { articleId: 'article-1' }, idempotencyKey: 'admission-support-race' })).rejects.toMatchObject({ status: 409, code: 'conflict' })
    expect(answer).toHaveBeenCalledTimes(1)
    expect(supportVerifier).not.toHaveBeenCalled()
  })

  it('renews the provider-running receipt before primary, fallback, and support stages', async () => {
    const repo = repository({ records: evidence() })
    repo.assertActorFence = vi.fn(async () => true)
    const updateAttempt = vi.spyOn(repo, 'updateAnswerAttempt')
    const answer = vi.fn(async ({ route }) => {
      if (route.routeId === 'primary') throw Object.assign(new Error('retryable'), { retryable: true })
      return { paragraphs: [{ text: 'Kết luận có căn cứ.', citationIds: ['C1'], evidenceBlockIds: ['E1'] }] }
    })
    const service = createQaService({ chatRepository: repo, articleRepository: repo, providerAdapters: { llmProvider: { answer } }, routes: { primary: 'primary', fallback: 'fallback', support: 'support' }, supportVerifier: async () => ({ verdict: 'supported', addressesQuestion: true, evidenceBlockIds: ['E1'] }) })

    await service.createAnswer({ auth, question: 'Bài viết kết luận gì?', scope: { articleId: 'article-1' }, idempotencyKey: 'renew-each-stage' })

    expect(updateAttempt.mock.calls.filter(([, update]) => update.providerReservationExpiresAt)).toHaveLength(3)
  })

  it('checks the actor fence inside each admission callback before provider I/O', async () => {
    const repo = repository({ records: evidence() })
    repo.assertActorFence = vi.fn().mockResolvedValueOnce(true).mockResolvedValueOnce(false)
    const answer = vi.fn()
    const providerAdmission = { run: vi.fn(async ({ invoke, routeId }) => invoke(routeId)) }
    const service = createQaService({ chatRepository: repo, articleRepository: repo, providerAdmission, providerAdapters: { llmProvider: { answer } }, routes: { primary: 'primary' } })

    await expect(service.createAnswer({ auth, question: 'Bài viết kết luận gì?', scope: { articleId: 'article-1' }, idempotencyKey: 'invoke-actor-fence' })).rejects.toMatchObject({ status: 401 })
    expect(answer).not.toHaveBeenCalled()
  })

  it('delegates generation and support to workload router with one immutable input and safe route metadata', async () => {
    const repo = repository({ records: evidence() })
    const answer = vi.fn(async ({ route }) => {
      if (route.routeId === 'qa-primary') throw Object.assign(new Error('model unavailable'), { failureClass: 'model-retryable' })
      return { paragraphs: [{ text: 'Kết luận có căn cứ.', citationIds: ['C1'], evidenceBlockIds: ['E1'] }] }
    })
    const verifySupport = vi.fn(async () => ({ verdict: 'supported', addressesQuestion: true, evidenceBlockIds: ['E1'] }))
    const generationInputs = []
    const invocationInputs = []
    const providerRouter = {
      execute: vi.fn(async ({ workloadId, admittedInput, invoke, validateOutput }) => {
        if (workloadId === 'qa-generation') {
          generationInputs.push(admittedInput)
          const primary = { routeId: 'qa-primary', providerId: 'provider-a', providerFailureDomainId: 'domain-a', model: 'model-a' }
          const fallback = { routeId: 'qa-model-fallback', providerId: 'provider-a', providerFailureDomainId: 'domain-a', model: 'model-b' }
          invocationInputs.push(admittedInput)
          await expect(invoke({ route: primary, admittedInput })).rejects.toMatchObject({ failureClass: 'model-retryable' })
          invocationInputs.push(admittedInput)
          const output = await invoke({ route: fallback, admittedInput })
          return { output: validateOutput({ route: fallback, output, admittedInput }), metadata: { workloadId, operation: 'answer', routeId: fallback.routeId, providerId: fallback.providerId, providerFailureDomainId: fallback.providerFailureDomainId, model: fallback.model, externalAttempts: 2, fallback: 'model' } }
        }
        const route = { routeId: 'qa-support', providerId: 'provider-a', providerFailureDomainId: 'domain-a', model: 'support-model' }
        const output = await invoke({ route, admittedInput })
        return { output, metadata: { workloadId, operation: 'support', routeId: route.routeId, providerId: route.providerId, providerFailureDomainId: route.providerFailureDomainId, model: route.model, externalAttempts: 1, fallback: 'none' } }
      }),
    }
    const service = createQaService({
      chatRepository: repo,
      articleRepository: repo,
      providerRouter,
      providerAdapters: { llmProvider: { answer, verifySupport } },
      supportVerifier: verifySupport,
    })

    const result = await service.createAnswer({ auth, question: 'Bài viết kết luận gì?', scope: { articleId: 'article-1' }, idempotencyKey: 'router-integration-key' })

    expect(result.answer.status).toBe('answered')
    expect(providerRouter.execute.mock.calls.map(([input]) => input.workloadId)).toEqual(['qa-generation', 'qa-support'])
    expect(generationInputs).toHaveLength(1)
    expect(Object.isFrozen(generationInputs[0])).toBe(true)
    expect(invocationInputs[1]).toBe(invocationInputs[0])
    expect(Object.isFrozen(invocationInputs[0].prompt)).toBe(true)
    expect(generationInputs[0].question).toBe('Bài viết kết luận gì?')
    expect(answer).toHaveBeenCalledTimes(2)
    expect(answer.mock.calls[0][0].input).toBe(answer.mock.calls[1][0].input)
    expect([...repo.attempts.values()][0]).toMatchObject({ providerRouteId: 'qa-model-fallback', providerFailureDomainId: 'domain-a', fallbackKind: 'model' })
  })

  it.each([
    ['policy', 'policy-blocked'],
    ['privacy', 'provider-unavailable'],
    ['sensitive-input', 'sensitive-input'],
    ['schema', 'provider-unavailable'],
    ['support', 'provider-unavailable'],
  ])('keeps %s routing errors terminal without a fallback call', async (failureClass, expectedReason) => {
    const repo = repository({ records: evidence() })
    const answer = vi.fn()
    const providerRouter = { execute: vi.fn(async () => { throw new ProviderRoutingError({ failureClass, code: `provider_${failureClass}`, retryable: false }) }) }
    const service = createQaService({ chatRepository: repo, articleRepository: repo, providerRouter, providerAdapters: { llmProvider: { answer } } })

    const result = await service.createAnswer({ auth, question: 'Bài viết kết luận gì?', scope: { articleId: 'article-1' }, idempotencyKey: `terminal-${failureClass}` })

    expect(result.answer).toMatchObject({ status: 'refused', refusalReason: expectedReason })
    expect(providerRouter.execute).toHaveBeenCalledTimes(1)
    expect(answer).not.toHaveBeenCalled()
  })

  it('persists cross-provider fallback metadata without starting a second fallback family', async () => {
    const repo = repository({ records: evidence() })
    const answer = vi.fn(async ({ route }) => route.routeId === 'qa-provider-primary'
      ? Promise.reject(Object.assign(new Error('provider domain unavailable'), { failureClass: 'provider-retryable' }))
      : { paragraphs: [{ text: 'Kết luận có căn cứ.', citationIds: ['C1'], evidenceBlockIds: ['E1'] }] })
    const providerRouter = {
      execute: vi.fn(async ({ workloadId, admittedInput, invoke, validateOutput }) => {
        if (workloadId === 'qa-generation') {
          const primary = { routeId: 'qa-provider-primary', providerId: 'provider-a', providerFailureDomainId: 'domain-a', model: 'model-a' }
          const fallback = { routeId: 'qa-provider-fallback', providerId: 'provider-b', providerFailureDomainId: 'domain-b', model: 'model-b' }
          await expect(invoke({ route: primary, admittedInput })).rejects.toMatchObject({ failureClass: 'provider-retryable' })
          const output = await invoke({ route: fallback, admittedInput })
          return { output: validateOutput({ route: fallback, output, admittedInput }), metadata: { workloadId, operation: 'answer', routeId: fallback.routeId, providerId: fallback.providerId, providerFailureDomainId: fallback.providerFailureDomainId, model: fallback.model, externalAttempts: 2, fallback: 'provider' } }
        }
        const route = { routeId: 'qa-provider-support', providerId: 'provider-b', providerFailureDomainId: 'domain-b', model: 'support-model' }
        return { output: await invoke({ route, admittedInput }), metadata: { workloadId, operation: 'support', routeId: route.routeId, providerId: route.providerId, providerFailureDomainId: route.providerFailureDomainId, model: route.model, externalAttempts: 1, fallback: 'none' } }
      }),
    }
    const service = createQaService({ chatRepository: repo, articleRepository: repo, providerRouter, providerAdapters: { llmProvider: { answer, verifySupport: async () => ({ verdict: 'supported', addressesQuestion: true, evidenceBlockIds: ['E1'] }) } } })

    await expect(service.createAnswer({ auth, question: 'Bài viết kết luận gì?', scope: { articleId: 'article-1' }, idempotencyKey: 'provider-fallback-metadata' })).resolves.toMatchObject({ answer: { status: 'answered' } })
    expect(answer).toHaveBeenCalledTimes(2)
    expect([...repo.attempts.values()][0]).toMatchObject({ providerRouteId: 'qa-provider-fallback', providerFailureDomainId: 'domain-b', fallbackKind: 'provider' })
  })

  it('keeps an ambiguous provider outcome terminal and does not start a second provider operation', async () => {
    const repo = repository({ records: evidence() })
    const providerRouter = { execute: vi.fn(async () => { throw new ProviderRoutingError({ failureClass: 'ambiguous', code: 'ambiguous_provider_outcome', retryable: false }) }) }
    const service = createQaService({ chatRepository: repo, articleRepository: repo, providerRouter, providerAdapters: { llmProvider: { answer: vi.fn() } } })

    await expect(service.createAnswer({ auth, question: 'Bài viết kết luận gì?', scope: { articleId: 'article-1' }, idempotencyKey: 'ambiguous-router-key' })).rejects.toMatchObject({ status: 503, code: 'service_unavailable' })
    expect(providerRouter.execute).toHaveBeenCalledTimes(1)
    expect([...repo.attempts.values()][0]).toMatchObject({ status: 'failed', error: expect.objectContaining({ code: 'ambiguous_provider_outcome', retryable: false }) })
  })

  it('keeps actor fence loss as canonical unauthorized instead of ambiguous provider outcome', async () => {
    const repo = repository({ records: evidence() })
    repo.assertActorFence = vi.fn().mockResolvedValueOnce(true).mockResolvedValueOnce(false)
    const providerRouter = {
      execute: vi.fn(async ({ invoke, admittedInput }) => {
        try { return { output: await invoke({ route: { routeId: 'qa-primary', providerFailureDomainId: 'domain-a' }, admittedInput }) } } catch { throw new ProviderRoutingError({ failureClass: 'ambiguous', code: 'ambiguous_provider_outcome', retryable: false }) }
      }),
    }
    const service = createQaService({ chatRepository: repo, articleRepository: repo, providerRouter, providerAdapters: { llmProvider: { answer: vi.fn() } } })

    await expect(service.createAnswer({ auth, question: 'Bài viết kết luận gì?', scope: { articleId: 'article-1' }, idempotencyKey: 'router-actor-fence' })).rejects.toMatchObject({ status: 401, code: 'unauthorized' })
    expect([...repo.attempts.values()][0]).not.toMatchObject({ error: expect.objectContaining({ code: 'ambiguous_provider_outcome' }) })
  })

  it('keeps evidence fence loss as canonical conflict instead of ambiguous provider outcome', async () => {
    const repo = repository({ records: evidence() })
    repo.findQnaEvidence = vi.fn()
      .mockResolvedValueOnce(evidence())
      .mockResolvedValueOnce([])
    const providerRouter = {
      execute: vi.fn(async ({ invoke, admittedInput }) => {
        try { return { output: await invoke({ route: { routeId: 'qa-primary', providerFailureDomainId: 'domain-a' }, admittedInput }) } } catch { throw new ProviderRoutingError({ failureClass: 'ambiguous', code: 'ambiguous_provider_outcome', retryable: false }) }
      }),
    }
    const service = createQaService({ chatRepository: repo, articleRepository: repo, providerRouter, providerAdapters: { llmProvider: { answer: vi.fn() } } })

    await expect(service.createAnswer({ auth, question: 'Bài viết kết luận gì?', scope: { articleId: 'article-1' }, idempotencyKey: 'router-evidence-fence' })).rejects.toMatchObject({ status: 409, code: 'conflict' })
    expect([...repo.attempts.values()][0]).not.toMatchObject({ error: expect.objectContaining({ code: 'ambiguous_provider_outcome' }) })
  })

  it.each([
    ['schema', 'refused'],
    ['ambiguous', 'failed'],
  ])('persists fallback route/domain/kind when fallback ends %s', async (failureClass, status) => {
    const repo = repository({ records: evidence() })
    const answer = vi.fn(async ({ route }) => {
      if (route.routeId === 'qa-primary') throw new ProviderAdapterError('model-retryable')
      throw new ProviderAdapterError('schema')
    })
    const providerRouter = {
      execute: vi.fn(async ({ invoke, admittedInput }) => {
        const primary = { routeId: 'qa-primary', providerFailureDomainId: 'domain-a', model: 'model-a' }
        const fallback = { routeId: 'qa-model-fallback', providerFailureDomainId: 'domain-a', model: 'model-b' }
        await expect(invoke({ route: primary, admittedInput })).rejects.toMatchObject({ failureClass: 'model-retryable' })
        await expect(invoke({ route: fallback, admittedInput })).rejects.toMatchObject({ failureClass: 'schema' })
        throw new ProviderRoutingError({ failureClass, code: failureClass === 'ambiguous' ? 'ambiguous_provider_outcome' : 'provider_schema_invalid', retryable: false })
      }),
    }
    const service = createQaService({ chatRepository: repo, articleRepository: repo, providerRouter, providerAdapters: { llmProvider: { answer } } })

    if (failureClass === 'schema') await expect(service.createAnswer({ auth, question: 'Bài viết kết luận gì?', scope: { articleId: 'article-1' }, idempotencyKey: `terminal-fallback-${failureClass}` })).resolves.toMatchObject({ answer: { status } })
    else await expect(service.createAnswer({ auth, question: 'Bài viết kết luận gì?', scope: { articleId: 'article-1' }, idempotencyKey: `terminal-fallback-${failureClass}` })).rejects.toMatchObject({ status: 503 })
    expect([...repo.attempts.values()][0]).toMatchObject({ status, providerRouteId: 'qa-model-fallback', providerFailureDomainId: 'domain-a', fallbackKind: 'model' })
  })
})
