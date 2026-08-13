import { describe, expect, it, vi } from 'vitest'
import { createQaService } from '../../../server/application/qa/service.js'

const auth = {
  user: { id: 'user-1', status: 'active', sessionVersion: 3 },
  session: { id: 'session-1', userSessionVersion: 3 },
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
    const supportVerifier = vi.fn(async () => ({ verdict: 'supported', evidenceBlockIds: ['E1'] }))
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
    const service = createQaService({ chatRepository: repo, articleRepository: repo, providerAdapters: { llmProvider: { answer: async () => ({ paragraphs: [{ text: 'Kết luận có căn cứ.', citationIds: ['C1'], evidenceBlockIds: ['E1'] }] }) } }, routes: { primary: 'primary' }, supportVerifier: async () => ({ verdict: 'supported', evidenceBlockIds: ['E1'] }) })

    await service.createAnswer({ auth, question: 'Kết luận là gì?', scope: { articleId: 'article-1' }, idempotencyKey: 'atomic-receipt-key' })

    expect(repo.appendAnswer).toHaveBeenCalledWith(expect.objectContaining({ attempt: expect.objectContaining({ outcome: 'completed' }) }))
    expect(updateAttempt).toHaveBeenCalledTimes(2)
  })

  it('rejects a provider paragraph that lacks the exact internal evidence block ID', async () => {
    const repo = repository({ records: evidence() })
    const provider = vi.fn(async () => ({ paragraphs: [{ text: 'Kết luận không có block.', citationIds: ['C1'] }] }))
    const service = createQaService({ chatRepository: repo, articleRepository: repo, providerAdapters: { llmProvider: { answer: provider } }, routes: { primary: 'primary' }, supportVerifier: async () => ({ verdict: 'supported', evidenceBlockIds: ['E1'] }) })

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
    const supportVerifier = vi.fn(async () => ({ verdict: 'supported', evidenceBlockIds: ['E1'] }))
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
    const service = createQaService({ chatRepository: repo, articleRepository: repo, providerAdapters: { llmProvider: { answer: vi.fn(async ({ route }) => route === 'primary' ? primary() : fallback()) } }, routes: { primary: 'primary', fallback: 'fallback' } })

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
    const answer = vi.fn(async ({ route }) => route === 'primary' ? primary() : fallback())
    const service = createQaService({ chatRepository: repo, articleRepository: repo, providerAdapters: { llmProvider: { answer } }, routes: { primary: 'primary', fallback: 'fallback' } })

    const result = await service.createAnswer({ auth, question: 'Bài viết kết luận gì?', scope: { articleId: 'article-1' }, idempotencyKey: 'policy-before-fallback' })

    expect(result.answer).toMatchObject({ status: 'refused', refusalReason: 'policy-blocked' })
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

    const result = await service.createAnswer({ auth, question: 'Bài viết kết luận gì?', scope: { articleId: 'article-1' }, idempotencyKey: 'scope-before-support' })

    expect(result.answer).toMatchObject({ status: 'refused', refusalReason: 'policy-blocked' })
    expect(answer).toHaveBeenCalledTimes(1)
    expect(supportVerifier).not.toHaveBeenCalled()
    expect(repo.findQnaEvidence).toHaveBeenCalledTimes(3)
  })

  it('fails closed when the support verdict is not bound to the exact evidence block set', async () => {
    const repo = repository({ records: evidence() })
    const answer = vi.fn(async () => ({ paragraphs: [{ text: 'Kết luận có căn cứ.', citationIds: ['C1'], evidenceBlockIds: ['E1'] }] }))
    const supportVerifier = vi.fn(async () => ({ verdict: 'supported', evidenceBlockIds: ['E2'] }))
    const service = createQaService({ chatRepository: repo, articleRepository: repo, providerAdapters: { llmProvider: { answer } }, routes: { primary: 'primary', support: 'support' }, supportVerifier })

    const result = await service.createAnswer({ auth, question: 'Bài viết kết luận gì?', scope: { articleId: 'article-1' }, idempotencyKey: 'mismatched-support-set' })

    expect(result.answer).toMatchObject({ status: 'refused', refusalReason: 'insufficient-evidence' })
    expect(repo.sessions[0].answer.paragraphs).toEqual([])
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

    const result = await service.createAnswer({ auth, question: 'Bài viết kết luận gì?', scope: { articleId: 'article-1' }, idempotencyKey: 'admission-primary-race' })

    expect(result.answer).toMatchObject({ status: 'refused', refusalReason: 'policy-blocked' })
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

    const result = await service.createAnswer({ auth, question: 'Bài viết kết luận gì?', scope: { articleId: 'article-1' }, idempotencyKey: 'admission-support-race' })

    expect(result.answer).toMatchObject({ status: 'refused', refusalReason: 'policy-blocked' })
    expect(answer).toHaveBeenCalledTimes(1)
    expect(supportVerifier).not.toHaveBeenCalled()
  })

  it('renews the provider-running receipt before primary, fallback, and support stages', async () => {
    const repo = repository({ records: evidence() })
    repo.assertActorFence = vi.fn(async () => true)
    const updateAttempt = vi.spyOn(repo, 'updateAnswerAttempt')
    const answer = vi.fn(async ({ route }) => {
      if (route === 'primary') throw Object.assign(new Error('retryable'), { retryable: true })
      return { paragraphs: [{ text: 'Kết luận có căn cứ.', citationIds: ['C1'], evidenceBlockIds: ['E1'] }] }
    })
    const service = createQaService({ chatRepository: repo, articleRepository: repo, providerAdapters: { llmProvider: { answer } }, routes: { primary: 'primary', fallback: 'fallback', support: 'support' }, supportVerifier: async () => ({ verdict: 'supported', evidenceBlockIds: ['E1'] }) })

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
})
