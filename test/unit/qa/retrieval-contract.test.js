import { describe, expect, it, vi } from 'vitest'
import { createQaService as createQaServiceImpl } from '../../../server/application/qa/service.js'
import { createProviderRouterFixture } from './provider-router-fixture.js'

const auth = {
  user: { id: 'user-retrieval', status: 'active', sessionVersion: 1 },
  session: { id: 'session-retrieval', userSessionVersion: 1 },
}

function createQaService(options = {}) {
  return createQaServiceImpl({ ...options, providerRouter: options.providerRouter ?? createProviderRouterFixture(options) })
}

function evidence() {
  return [{
    article: {
      id: 'article-retrieval',
      sourceId: 'source-retrieval',
      status: 'published',
      evidenceEligible: true,
      titleOriginal: 'Nghien cuu chip AI',
      excerptOriginal: 'Ket qua cho thay chip AI tiet kiem dien.',
      originalUrl: 'https://example.test/articles/retrieval',
      publishedAt: '2026-08-10T00:00:00.000Z',
      rightsSnapshot: { sourcePolicyVersion: 1, licenseStatus: 'permitted', llmInputScope: 'excerpt' },
    },
    source: {
      id: 'source-retrieval',
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

function repository(records = evidence()) {
  const attempts = new Map()
  return {
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
      this.lastEvidenceQuery = input
      return records
    },
  }
}

describe('Step 10 admitted-question retrieval/support contract', () => {
  it('passes the admitted question into Q&A evidence retrieval and support verification', async () => {
    const repo = repository()
    const provider = vi.fn(async () => ({ paragraphs: [{ text: 'Ket qua tiet kiem dien.', citationIds: ['C1'], evidenceBlockIds: ['E1'] }] }))
    const supportVerifier = vi.fn(async () => ({ verdict: 'supported', evidenceBlockIds: ['E1'], addressesQuestion: true }))
    const service = createQaService({
      chatRepository: repo,
      articleRepository: repo,
      providerAdapters: { llmProvider: { answer: provider } },
      routes: { primary: 'primary', support: 'support' },
      supportVerifier,
    })

    await service.createAnswer({ auth, question: 'Chip AI tiet kiem dien the nao?', scope: { articleId: 'article-retrieval' }, idempotencyKey: 'retrieval-question-1' })

    expect(repo.lastEvidenceQuery).toEqual(expect.objectContaining({ question: 'Chip AI tiet kiem dien the nao?' }))
    expect(supportVerifier).toHaveBeenCalledWith(expect.objectContaining({
      question: 'Chip AI tiet kiem dien the nao?',
      paragraphs: expect.any(Array),
      addressesQuestion: expect.anything(),
    }))
  })

  it('passes an approved BGE-M3 query embedding after privacy admission', async () => {
    const repo = repository()
    const provider = vi.fn(async () => ({ paragraphs: [{ text: 'Ket qua tiet kiem dien.', citationIds: ['C1'], evidenceBlockIds: ['E1'] }] }))
    const supportVerifier = vi.fn(async () => ({ verdict: 'supported', evidenceBlockIds: ['E1'], addressesQuestion: true }))
    const queryEmbedding = vi.fn(async (question) => ({ model: 'baai/bge-m3', dimensions: 1024, version: 1, embedding: new Array(1024).fill(0.01), question }))
    const service = createQaService({
      chatRepository: repo,
      articleRepository: repo,
      queryEmbedding,
      providerAdapters: { llmProvider: { answer: provider } },
      routes: { primary: 'primary', support: 'support' },
      supportVerifier,
    })

    await service.createAnswer({ auth, question: 'Chip AI tiet kiem dien the nao?', scope: { articleId: 'article-retrieval' }, idempotencyKey: 'retrieval-embedding-1' })

    expect(queryEmbedding).toHaveBeenCalledWith('Chip AI tiet kiem dien the nao?')
    expect(repo.lastEvidenceQuery).toEqual(expect.objectContaining({ queryEmbedding: expect.objectContaining({ model: 'baai/bge-m3', dimensions: 1024, version: 1 }) }))
  })

  it('refuses a visible but irrelevant evidence answer when support says it does not address the question', async () => {
    const repo = repository()
    const provider = vi.fn(async () => ({ paragraphs: [{ text: 'Noi dung khong lien quan.', citationIds: ['C1'], evidenceBlockIds: ['E1'] }] }))
    const supportVerifier = vi.fn(async () => ({ verdict: 'supported', evidenceBlockIds: ['E1'], addressesQuestion: false }))
    const service = createQaService({
      chatRepository: repo,
      articleRepository: repo,
      providerAdapters: { llmProvider: { answer: provider } },
      routes: { primary: 'primary', support: 'support' },
      supportVerifier,
    })

    const result = await service.createAnswer({ auth, question: 'Thoi tiet ngay mai the nao?', scope: { articleId: 'article-retrieval' }, idempotencyKey: 'retrieval-irrelevant-1' })

    expect(result.answer).toMatchObject({ status: 'refused', refusalReason: 'insufficient-evidence', paragraphs: [], citations: [] })
  })
})
