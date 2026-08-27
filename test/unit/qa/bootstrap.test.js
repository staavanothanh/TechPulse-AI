import { ObjectId } from 'mongodb'
import { readFileSync } from 'node:fs'
import { describe, expect, it, vi } from 'vitest'
import { assertChatSessionsReady, assertQaEvidenceFenceReady, createConfiguredQaService } from '../../../server/bootstrap/qa.js'
import { MongoChatRepository } from '../../../server/repositories/mongo/chat-repository.js'
import { MongoArticleRepository } from '../../../server/repositories/mongo/article-repository.js'
import { CHAT_SESSION_COLLECTIONS, CHAT_SESSION_INDEXES } from '../../../scripts/migrations/chat-sessions.js'
import { PROVIDER_ROUTING_ANSWER_ATTEMPT_VALIDATOR, PROVIDER_ROUTING_V2_COLLECTIONS, PROVIDER_ROUTING_V2_INDEXES } from '../../../scripts/migrations/provider-routing-v2.js'
import { QA_EVIDENCE_FENCE_SOURCE_VALIDATOR } from '../../../scripts/migrations/qa-evidence-fence.js'
import { SUMMARY_DETAIL_ARTICLE_VALIDATOR } from '../../../scripts/migrations/summary-detail-v1.js'
import { SOURCE_COLLECTIONS } from '../../../scripts/migrations/sources.js'

function indexesFor(name) {
  const merged = new Map([...(CHAT_SESSION_INDEXES[name] ?? []), ...(PROVIDER_ROUTING_V2_INDEXES[name] ?? [])].map((index) => [index.name, index]))
  return [...merged.values()].map((index) => {
    const textFields = Object.entries(index.key ?? {}).filter(([, direction]) => direction === 'text').map(([field]) => field)
    return textFields.length > 0
      ? { name: index.name, key: { _fts: 'text', _ftsx: 1 }, weights: Object.fromEntries(textFields.map((field) => [field, 1])), default_language: index.options?.default_language ?? 'english' }
      : { name: index.name, key: index.key, ...(index.options ?? {}) }
  })
}

function readyContext({ indexOverride = {}, validatorOverride = {} } = {}) {
  const definitions = new Map(Object.entries(CHAT_SESSION_COLLECTIONS))
  for (const entry of Object.entries(PROVIDER_ROUTING_V2_COLLECTIONS)) definitions.set(entry[0], entry[1])
  definitions.set('sources', SOURCE_COLLECTIONS.sources)
  const fencedDefaults = {
    articles: SUMMARY_DETAIL_ARTICLE_VALIDATOR,
    sources: QA_EVIDENCE_FENCE_SOURCE_VALIDATOR,
  }
  const collections = [...definitions].map(([name, definition]) => ({
    name,
    options: { validator: validatorOverride[name] ?? fencedDefaults[name] ?? definition.validator, validationLevel: 'strict', validationAction: 'error' },
  }))
  return {
    client: {},
    db: {
      listCollections: () => ({ toArray: async () => collections }),
      collection: (name) => ({
        indexes: async () => indexOverride[name] ?? indexesFor(name),
      }),
    },
  }
}

const qaPolicies = [
  { workloadId: 'qa-generation', operation: 'answer', requiredCapability: 'nonconfidential', maxExternalAttempts: 2, primaryRouteId: 'qa-answer', modelFallbackRouteIds: [], providerFallbackRouteIds: [] },
  { workloadId: 'qa-support', operation: 'support', requiredCapability: 'nonconfidential', maxExternalAttempts: 1, primaryRouteId: 'qa-support', modelFallbackRouteIds: [], providerFallbackRouteIds: [] },
]

describe('Step 10 Q&A bootstrap', () => {
  it('binds Q&A to workload policies without vendor, model, or embedding literals', async () => {
    const source = readFileSync(new URL('../../../server/bootstrap/qa.js', import.meta.url), 'utf8')
    expect(source).not.toMatch(/opencode-zen|openrouter|deepseek|bge-m3|baai\/bge-m3/i)
    expect(source).toMatch(/queryEmbedding\?\.capability === 'zdr-verified'/)

    const providerRouter = { execute: vi.fn() }
    const providerRegistry = {
      domains: [{}],
      routes: [
        { routeId: 'policy-answer', providerId: 'vendor-a', providerFailureDomainId: 'domain-a', model: 'answer-model', capability: 'zdr-verified', enabled: true, operations: ['answer'] },
        { routeId: 'policy-support', providerId: 'vendor-a', providerFailureDomainId: 'domain-a', model: 'support-model', capability: 'zdr-verified', enabled: true, operations: ['support'] },
      ],
      workloadPolicies: [
        { workloadId: 'qa-generation', operation: 'answer', requiredCapability: 'nonconfidential', maxExternalAttempts: 2, primaryRouteId: 'policy-answer', modelFallbackRouteIds: [], providerFallbackRouteIds: [] },
        { workloadId: 'qa-support', operation: 'support', requiredCapability: 'nonconfidential', maxExternalAttempts: 1, primaryRouteId: 'policy-support', modelFallbackRouteIds: [], providerFallbackRouteIds: [] },
      ],
    }
    const maintenanceRegistry = { register: vi.fn() }

    await expect(createConfiguredQaService({
      context: readyContext(),
      maintenanceRegistry,
      providerRegistry,
      providerRouter,
      providerAdmission: { run: vi.fn() },
      providerAdapters: { llmProvider: { answer: vi.fn(), verifySupport: vi.fn() } },
    })).resolves.toBeDefined()
  })
  it('passes a nonconfidential query embedding through to Q&A retrieval', async () => {
    const queryEmbedding = vi.fn(async () => ({
      model: 'embedding-model',
      dimensions: 2,
      version: 1,
      artifactCompatibilityId: 'embedding-compat-v1',
      embedding: [1, 0],
    }))
    queryEmbedding.capability = 'nonconfidential'
    const findEvidence = vi.spyOn(MongoArticleRepository.prototype, 'findQnaEvidence').mockResolvedValue([])
    vi.spyOn(MongoChatRepository.prototype, 'reserveAnswerAttempt').mockResolvedValue({ _id: new ObjectId(), status: 'reserved' })
    vi.spyOn(MongoChatRepository.prototype, 'assertActorFence').mockResolvedValue(true)
    vi.spyOn(MongoChatRepository.prototype, 'appendAnswer').mockResolvedValue({
      attemptCommitted: true,
      chatSessionId: 'chat-1',
      messageId: 'answer-1',
      answer: { id: 'answer-1', status: 'refused', paragraphs: [], citations: [], refusalReason: 'insufficient-evidence', chatSessionId: 'chat-1', createdAt: '2026-08-27T00:00:00.000Z' },
    })
    try {
      const service = await createConfiguredQaService({
        context: readyContext(),
        maintenanceRegistry: { register: vi.fn() },
        providerRegistry: { routes: [], domains: [{}], workloadPolicies: qaPolicies },
        providerRouter: { execute: vi.fn() },
        providerAdmission: { run: vi.fn() },
        providerAdapters: { llmProvider: { answer: vi.fn(), verifySupport: vi.fn() } },
        queryEmbedding,
      })

      await service.createAnswer({
        auth: { user: { id: '507f1f77bcf86cd799439001', status: 'active', sessionVersion: 3 }, session: { id: '507f1f77bcf86cd799439002', userSessionVersion: 3 } },
        question: 'Tìm bài viết về tác nhân',
        scope: { topics: ['ai'] },
        idempotencyKey: 'bootstrap-embedding-capability-key',
      })

      expect(queryEmbedding).toHaveBeenCalledWith('Tìm bài viết về tác nhân')
      expect(findEvidence).toHaveBeenCalledWith(expect.objectContaining({ queryEmbedding: expect.objectContaining({ model: 'embedding-model', artifactCompatibilityId: 'embedding-compat-v1' }) }))
    } finally {
      vi.restoreAllMocks()
    }
  })

  it('constructs the provider admission boundary for a normalized workload graph', async () => {
    const providerRegistry = {
      domains: [{}],
      routes: [
        { routeId: 'policy-answer', providerId: 'vendor-a', providerFailureDomainId: 'domain-a', model: 'answer-model', capability: 'zdr-verified', enabled: true, operations: ['answer'], evidenceExpiresAt: '2099-01-01T00:00:00.000Z' },
        { routeId: 'policy-support', providerId: 'vendor-a', providerFailureDomainId: 'domain-a', model: 'support-model', capability: 'zdr-verified', enabled: true, operations: ['support'], evidenceExpiresAt: '2099-01-01T00:00:00.000Z' },
      ],
      workloadPolicies: [
        { workloadId: 'qa-generation', operation: 'answer', requiredCapability: 'nonconfidential', maxExternalAttempts: 2, primaryRouteId: 'policy-answer', modelFallbackRouteIds: [], providerFallbackRouteIds: [] },
        { workloadId: 'qa-support', operation: 'support', requiredCapability: 'nonconfidential', maxExternalAttempts: 1, primaryRouteId: 'policy-support', modelFallbackRouteIds: [], providerFallbackRouteIds: [] },
      ],
    }

    await expect(createConfiguredQaService({
      context: readyContext(),
      maintenanceRegistry: { register: vi.fn() },
      providerRegistry,
      providerAdapters: { llmProvider: { answer: vi.fn(), verifySupport: vi.fn() } },
    })).resolves.toBeDefined()
  })

  it('requires exact generation and support workloads even when a router is injected', async () => {
    const base = {
      context: readyContext(),
      maintenanceRegistry: { register: vi.fn() },
      providerAdmission: { run: vi.fn() },
      providerRouter: { execute: vi.fn() },
      providerAdapters: { llmProvider: { answer: vi.fn(), verifySupport: vi.fn() } },
      providerRegistry: { domains: [{}], routes: [], workloadPolicies: [] },
    }
    await expect(createConfiguredQaService({
      ...base,
      providerRegistry: { ...base.providerRegistry, workloadPolicies: [{ workloadId: 'qa-generation', operation: 'answer', requiredCapability: 'zdr-verified', maxExternalAttempts: 2, primaryRouteId: 'answer', modelFallbackRouteIds: [], providerFallbackRouteIds: [] }] },
    })).rejects.toThrow(/qa-generation.*qa-support|workload policy/i)
    await expect(createConfiguredQaService({
      ...base,
      providerRegistry: { ...base.providerRegistry, workloadPolicies: [
        { workloadId: 'qa-generation', operation: 'answer', requiredCapability: 'zdr-verified', maxExternalAttempts: 2, primaryRouteId: 'answer', modelFallbackRouteIds: [], providerFallbackRouteIds: [] },
        { workloadId: 'qa-support', operation: 'answer', requiredCapability: 'zdr-verified', maxExternalAttempts: 2, primaryRouteId: 'support', modelFallbackRouteIds: [], providerFallbackRouteIds: [] },
      ] },
    })).rejects.toThrow(/qa-support|workload policy/i)
    await expect(createConfiguredQaService({
      ...base,
      providerRegistry: { ...base.providerRegistry, workloadPolicies: [qaPolicies[0], qaPolicies[0], qaPolicies[1]] },
    })).rejects.toThrow(/workload polic(?:y|ies)/i)
  })

  it('fails closed unless exact chat validators and indexes are deployed', async () => {
    await expect(assertChatSessionsReady(readyContext())).resolves.toBeUndefined()
    await expect(assertChatSessionsReady(readyContext({ indexOverride: { answerAttempts: [] } }))).rejects.toThrow(/indexes/i)
  })

  it('accepts the exact provider-routing-v2 answer-attempt validator after collMod', async () => {
    await expect(assertChatSessionsReady(readyContext({ validatorOverride: { answerAttempts: PROVIDER_ROUTING_ANSWER_ATTEMPT_VALIDATOR } }))).resolves.toBeUndefined()
    const altered = { ...PROVIDER_ROUTING_ANSWER_ATTEMPT_VALIDATOR, $and: PROVIDER_ROUTING_ANSWER_ATTEMPT_VALIDATOR.$and.slice(0, -1) }
    await expect(assertChatSessionsReady(readyContext({ validatorOverride: { answerAttempts: altered } }))).rejects.toThrow(/migration/i)
  })

  it('fails closed when the live article or source validator no longer has the QA fence', async () => {
    const fenced = readyContext({ validatorOverride: {
      articles: SUMMARY_DETAIL_ARTICLE_VALIDATOR,
      sources: QA_EVIDENCE_FENCE_SOURCE_VALIDATOR,
    } })

    await expect(assertQaEvidenceFenceReady(fenced)).resolves.toBeUndefined()
    await expect(assertQaEvidenceFenceReady(readyContext({ validatorOverride: {
      articles: PROVIDER_ROUTING_V2_COLLECTIONS.articles.validator,
      sources: QA_EVIDENCE_FENCE_SOURCE_VALIDATOR,
    } }))).rejects.toThrow(/qa evidence fence/i)
  })

  it('verifies the live QA evidence fence inside every configured service bootstrap', async () => {
    const verifySchema = vi.fn(async () => undefined)
    const verifyProviderSchema = vi.fn(async () => undefined)
    const options = {
      context: readyContext({ validatorOverride: { articles: PROVIDER_ROUTING_V2_COLLECTIONS.articles.validator } }),
      maintenanceRegistry: { register: vi.fn() },
      providerRegistry: { routes: [], domains: [{}], workloadPolicies: qaPolicies },
      providerAdmission: { run: vi.fn() },
      providerRouter: { execute: vi.fn() },
      providerAdapters: { llmProvider: { answer: vi.fn(), verifySupport: vi.fn() } },
      verifySchema,
      verifyProviderSchema,
    }

    await expect(createConfiguredQaService(options)).rejects.toThrow(/qa evidence fence/i)
    expect(verifySchema).toHaveBeenCalledOnce()
    expect(verifyProviderSchema).toHaveBeenCalledOnce()
  })

  it('registers bounded answer-attempt cleanup only after readiness succeeds', async () => {
    const registered = []
    const maintenanceRegistry = { register: vi.fn((name, handler) => { registered.push([name, handler]); return handler }) }
    await createConfiguredQaService({
      context: readyContext(),
      maintenanceRegistry,
      providerRegistry: { routes: [], domains: [{}], workloadPolicies: qaPolicies },
      providerAdmission: { run: vi.fn() },
      providerRouter: { execute: vi.fn() },
      providerAdapters: { llmProvider: { answer: vi.fn(), verifySupport: vi.fn() } },
    })
    expect(registered.map(([name]) => name)).toEqual(['purge-answer-attempts'])
  })

  it('fails closed when the maintenance cleanup registry is unavailable', async () => {
    const options = {
      context: readyContext(),
      providerRegistry: { routes: [], domains: [{}], workloadPolicies: qaPolicies },
      providerAdmission: { run: vi.fn() },
      providerRouter: { execute: vi.fn() },
      providerAdapters: { llmProvider: { answer: vi.fn(), verifySupport: vi.fn() } },
    }

    await expect(createConfiguredQaService(options)).rejects.toThrow(/maintenance/i)
    await expect(createConfiguredQaService({ ...options, maintenanceRegistry: {} })).rejects.toThrow(/maintenance/i)
    await expect(createConfiguredQaService({
      ...options,
      maintenanceRegistry: { register: vi.fn(() => { throw new Error('Maintenance registration failed') }) },
    })).rejects.toThrow('Maintenance registration failed')
  })

  it('requires a real provider admission boundary and exact workload policies', async () => {
    const base = {
      context: readyContext(),
      maintenanceRegistry: { register: vi.fn() },
      providerAdapters: { llmProvider: { answer: vi.fn(), verifySupport: vi.fn() } },
      providerRouter: { execute: vi.fn() },
    }
    await expect(createConfiguredQaService({ ...base, providerRegistry: { routes: [], domains: [{}], workloadPolicies: qaPolicies }, providerAdmission: {} })).rejects.toThrow(/admission/i)
    await expect(createConfiguredQaService({ ...base, providerRegistry: { routes: [], domains: [{}], workloadPolicies: [] }, providerAdmission: { run: vi.fn() } })).rejects.toThrow(/workload/i)
  })
})

describe('Step 10 answer-attempt retention', () => {
  it('selects and deletes at most one bounded page of expired opaque receipts', async () => {
    const first = new ObjectId()
    const second = new ObjectId()
    const third = new ObjectId()
    const toArray = vi.fn(async () => [{ _id: first }, { _id: second }, { _id: third }])
    const find = vi.fn(() => ({ sort() { return this }, hint() { return this }, project() { return this }, limit() { return this }, toArray }))
    const deleteMany = vi.fn(async () => ({ deletedCount: 2 }))
    const repository = new MongoChatRepository({ db: {}, client: {} })
    repository.answerAttempts = () => ({ find, deleteMany })
    const cutoff = new Date('2026-08-12T00:00:00.000Z')

    await expect(repository.purgeDueAnswerAttempts({ cutoff, limit: 2 })).resolves.toEqual({ inspected: 2, affected: 2, hasMore: true })
    expect(find).toHaveBeenCalledWith({ expiresAt: { $lte: cutoff } })
    expect(deleteMany).toHaveBeenCalledWith({ _id: { $in: [first, second] }, expiresAt: { $lte: cutoff } })
  })
})
