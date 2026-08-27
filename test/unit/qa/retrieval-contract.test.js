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
    const queryEmbedding = vi.fn(async (question) => ({ model: 'baai/bge-m3', dimensions: 1024, version: 1, artifactCompatibilityId: 'bge-m3-v1-1024', embedding: new Array(1024).fill(0.01), question }))
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
    expect(repo.lastEvidenceQuery).toEqual(expect.objectContaining({ queryEmbedding: expect.objectContaining({ model: 'baai/bge-m3', dimensions: 1024, version: 1, artifactCompatibilityId: 'bge-m3-v1-1024' }) }))
  })

  it('does not invoke queryEmbedding when privacy admission rejects sensitive input', async () => {
    const repo = repository()
    const queryEmbedding = vi.fn()
    const provider = vi.fn()
    const service = createQaService({
      chatRepository: repo,
      articleRepository: repo,
      queryEmbedding,
      providerAdapters: { llmProvider: { answer: provider } },
      routes: { primary: 'primary', support: 'support' },
    })

    const result = await service.createAnswer({
      auth,
      question: 'Khoa bi mat la sk-1234567890abcdefghijklmnop',
      scope: { articleId: 'article-retrieval' },
      idempotencyKey: 'retrieval-sensitive-1',
    })

    expect(queryEmbedding).not.toHaveBeenCalled()
    expect(result.answer).toMatchObject({ status: 'refused', refusalReason: 'sensitive-input' })
  })

  it('preserves the original admitted question without rewriting or LLM query-understanding', async () => {
    const repo = repository()
    const rawQuestion = 'Bao mat va cybersecurity cua he thong cloud the nao???'
    const capturedInputs = []
    const provider = vi.fn(async ({ input }) => {
      capturedInputs.push(input)
      return { paragraphs: [{ text: 'Ket qua bao mat cloud.', citationIds: ['C1'], evidenceBlockIds: ['E1'] }] }
    })
    const supportVerifier = vi.fn(async () => ({ verdict: 'supported', evidenceBlockIds: ['E1'], addressesQuestion: true }))
    const queryEmbedding = vi.fn(async (q) => ({ model: 'baai/bge-m3', dimensions: 1024, version: 1, artifactCompatibilityId: 'bge-m3-v1-1024', embedding: new Array(1024).fill(0.01), question: q }))
    const service = createQaService({
      chatRepository: repo,
      articleRepository: repo,
      queryEmbedding,
      providerAdapters: { llmProvider: { answer: provider } },
      routes: { primary: 'primary', support: 'support' },
      supportVerifier,
    })

    const result = await service.createAnswer({
      auth,
      question: rawQuestion,
      scope: { articleId: 'article-retrieval' },
      idempotencyKey: 'retrieval-original-q-1',
    })

    expect(queryEmbedding).toHaveBeenCalledWith(rawQuestion)
    expect(repo.lastEvidenceQuery.question).toBe(rawQuestion)
    expect(supportVerifier).toHaveBeenCalledWith(expect.objectContaining({ question: rawQuestion }))
    expect(capturedInputs[0]).toContain(rawQuestion)
    expect(result.answer.status).toBe('answered')
  })

  it('safely projects provider input without exposing vectors, embeddings, internal scores, or raw article fields', async () => {
    const testEvidence = [{
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
        embedding: new Array(1024).fill(0.5),
        embeddingStatus: 'ready',
        embeddingModel: 'baai/bge-m3',
        embeddingDimensions: 1024,
        embeddingVersion: 1,
        embeddingArtifactCompatibilityId: 'bge-m3-v1-1024',
        searchTextNormalized: 'nghien cuu chip ai',
        rawTextScore: 4.5,
        canonicalUrlHash: 'a'.repeat(64),
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
    const repo = repository(testEvidence)
    const executedWorkloads = []
    const routerMock = {
      async execute({ workloadId, admittedInput, invoke, validateOutput }) {
        executedWorkloads.push({ workloadId, admittedInput })
        if (workloadId === 'qa-generation') {
          const output = await invoke({ route: { routeId: 'primary', providerFailureDomainId: 'domain-a', model: 'primary-model' }, admittedInput })
          return { output: validateOutput({ route: { routeId: 'primary' }, output, admittedInput }), metadata: { routeId: 'primary', providerFailureDomainId: 'domain-a', fallback: 'none' } }
        }
        if (workloadId === 'qa-support') {
          const output = await invoke({ route: { routeId: 'support', providerFailureDomainId: 'domain-a', model: 'support-model' }, admittedInput })
          return { output: validateOutput({ route: { routeId: 'support' }, output, admittedInput }), metadata: { routeId: 'support', providerFailureDomainId: 'domain-a', fallback: 'none' } }
        }
        throw new Error(`Unexpected workload: ${workloadId}`)
      },
    }
    const provider = vi.fn(async () => ({ paragraphs: [{ text: 'Ket qua tiet kiem dien.', citationIds: ['C1'], evidenceBlockIds: ['E1'] }] }))
    const supportVerifier = vi.fn(async () => ({ verdict: 'supported', evidenceBlockIds: ['E1'], addressesQuestion: true }))
    const queryEmbedding = vi.fn(async () => ({ model: 'baai/bge-m3', dimensions: 1024, version: 1, artifactCompatibilityId: 'bge-m3-v1-1024', embedding: new Array(1024).fill(0.01) }))
    const service = createQaService({
      chatRepository: repo,
      articleRepository: repo,
      queryEmbedding,
      providerRouter: routerMock,
      providerAdapters: { llmProvider: { answer: provider } },
      supportVerifier,
    })

    await service.createAnswer({
      auth,
      question: 'Chip AI tiet kiem dien the nao?',
      scope: { articleId: 'article-retrieval' },
      idempotencyKey: 'retrieval-projection-1',
    })

    expect(executedWorkloads.map(({ workloadId }) => workloadId)).toEqual(['qa-generation', 'qa-support'])

    const genInput = executedWorkloads.find((w) => w.workloadId === 'qa-generation').admittedInput
    const genJson = JSON.stringify(genInput)
    expect(genJson).not.toContain('embedding')
    expect(genJson).not.toContain('searchTextNormalized')
    expect(genJson).not.toContain('rawTextScore')
    expect(genJson).not.toContain('canonicalUrlHash')
    expect(genInput.prompt).not.toHaveProperty('evidence')

    const supportInput = executedWorkloads.find((w) => w.workloadId === 'qa-support').admittedInput
    const supportJson = JSON.stringify(supportInput)
    expect(supportJson).not.toContain('embedding')
    expect(supportJson).not.toContain('searchTextNormalized')
    expect(supportJson).not.toContain('rawTextScore')
  })

  it('freezes selected evidence article IDs and prevents silent candidate set changes during fence recheck', async () => {
    let callCount = 0
    const repo = repository()
    const capturedScopes = []
    repo.findQnaEvidence = vi.fn(async (input) => {
      callCount += 1
      capturedScopes.push(input.scope)
      return evidence()
    })
    const provider = vi.fn(async () => ({ paragraphs: [{ text: 'Ket qua tiet kiem dien.', citationIds: ['C1'], evidenceBlockIds: ['E1'] }] }))
    const supportVerifier = vi.fn(async () => ({ verdict: 'supported', evidenceBlockIds: ['E1'], addressesQuestion: true }))
    const service = createQaService({
      chatRepository: repo,
      articleRepository: repo,
      providerAdapters: { llmProvider: { answer: provider } },
      routes: { primary: 'primary', support: 'support' },
      supportVerifier,
    })

    await service.createAnswer({
      auth,
      question: 'Chip AI tiet kiem dien the nao?',
      scope: { articleId: 'article-retrieval' },
      idempotencyKey: 'retrieval-fence-freeze-1',
    })

    expect(capturedScopes[0]).toEqual({ articleId: 'article-retrieval' })
    expect(capturedScopes[1]).toEqual(expect.objectContaining({ articleIds: ['article-retrieval'] }))
    expect(capturedScopes[2]).toEqual(expect.objectContaining({ articleIds: ['article-retrieval'] }))
  })

  it('fails fence recheck if a frozen selected article is no longer visible', async () => {
    let callCount = 0
    const repo = repository()
    repo.findQnaEvidence = vi.fn(async () => {
      callCount += 1
      if (callCount === 1) return evidence()
      return []
    })
    const provider = vi.fn(async () => ({ paragraphs: [{ text: 'Ket qua tiet kiem dien.', citationIds: ['C1'], evidenceBlockIds: ['E1'] }] }))
    const service = createQaService({
      chatRepository: repo,
      articleRepository: repo,
      providerAdapters: { llmProvider: { answer: provider } },
      routes: { primary: 'primary', support: 'support' },
    })

    await expect(service.createAnswer({
      auth,
      question: 'Chip AI tiet kiem dien the nao?',
      scope: { articleId: 'article-retrieval' },
      idempotencyKey: 'retrieval-fence-removed-1',
    })).rejects.toMatchObject({ status: 409, code: 'conflict' })
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
