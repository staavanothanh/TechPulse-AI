import { describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { createConfiguredProviderAdapters } from '../../../server/ai/provider-adapters.js'
import { validateProviderConfiguration } from '../../../server/ai/provider-registry.js'
import { buildPolicyDerivedInput } from '../../../server/ai/policy-input.js'
import { validateVietnameseSummary } from '../../../server/ai/summary.js'
import { applyProviderReservation } from '../../../server/repositories/mongo/provider-admission-repository.js'
import { MongoIndexingJobRepository } from '../../../server/repositories/mongo/indexing-job-repository.js'
import { createIndexingQueueAdapter } from '../../../server/jobs/indexing-queue.js'

const SOURCE_ID = '507f1f77bcf86cd799439021'
const ARTICLE_ID = '507f1f77bcf86cd799439011'
const now = new Date('2026-08-10T00:00:00.000Z')
const source = {
  id: SOURCE_ID, name: 'Tech Review', policyVersion: 4, operationalStatus: 'active', technicalCheck: { status: 'passed' }, licenseStatus: 'permitted', llmInputScope: 'metadata',
  storageScope: { metadata: true, excerpt: false, summary: true, embedding: true }, mediaPolicy: { imageMode: 'none', videoMode: 'none', allowedHosts: [], attributionRequired: false },
}
const article = { id: ARTICLE_ID, sourceId: SOURCE_ID, titleOriginal: 'An toàn AI', topics: ['ai'], publishedAt: now, summaryStatus: 'pending' }
const installedAdapters = [{ adapterId: 'openai-compatible', protocol: 'openai-compatible-v1', supportedOperations: ['summary', 'embedding'] }]
const trustedEndpointProfiles = [
  { trustedEndpointProfileId: 'summary-endpoint', adapterId: 'openai-compatible', operationEndpoints: { summary: 'https://summary.example/v1/chat/completions' }, allowRedirects: false },
  { trustedEndpointProfileId: 'embedding-endpoint', adapterId: 'openai-compatible', operationEndpoints: { embedding: 'https://embedding.example/v1/embeddings' }, allowRedirects: false },
]
const domain = { admissionDomainId: 'summary-admission', providerId: 'summary-provider', credentialEnvName: 'SUMMARY_KEY_ENV', maxConcurrency: 1, budgetLimit: 5, budgetWindow: 'day' }
const route = { routeId: 'summary-primary', providerId: 'summary-provider', admissionDomainId: 'summary-admission', model: 'summary-model-v1' }

function providerGraph(overrides = {}) {
  return {
    providerFailureDomains: [{ providerFailureDomainId: 'summary-failure-domain', configVersion: 1, failureThreshold: 3, cooldownSeconds: 60 }, { providerFailureDomainId: 'embedding-failure-domain', configVersion: 1, failureThreshold: 3, cooldownSeconds: 60 }],
    providers: [
      { providerId: 'summary-provider', providerFailureDomainId: 'summary-failure-domain', adapterId: 'openai-compatible', trustedEndpointProfileId: 'summary-endpoint' },
      { providerId: 'embedding-provider', providerFailureDomainId: 'embedding-failure-domain', adapterId: 'openai-compatible', trustedEndpointProfileId: 'embedding-endpoint' },
    ],
    admissionDomains: [domain, { admissionDomainId: 'embedding-admission', providerId: 'embedding-provider', credentialEnvName: 'EMBEDDING_KEY_ENV', maxConcurrency: 1, budgetLimit: 5, budgetWindow: 'day' }],
    routes: [
      { ...route, operations: ['summary'], capability: 'nonconfidential', evidenceUrl: 'https://evidence.example/summary', reviewedAt: '2026-08-01T00:00:00.000Z', evidenceExpiresAt: '2026-09-01T00:00:00.000Z', artifactCompatibilityId: null, enabled: true, routeFailureThreshold: 3, routeCooldownSeconds: 60 },
      { routeId: 'embedding-primary', providerId: 'embedding-provider', admissionDomainId: 'embedding-admission', model: 'embedding-model-v1', operations: ['embedding'], capability: 'nonconfidential', evidenceUrl: 'https://evidence.example/embedding', reviewedAt: '2026-08-01T00:00:00.000Z', evidenceExpiresAt: '2026-09-01T00:00:00.000Z', artifactCompatibilityId: 'embedding-compat-v1', embeddingDimensions: 3, embeddingVersion: 7, enabled: true, routeFailureThreshold: 3, routeCooldownSeconds: 60 },
    ],
    workloadPolicies: [
      { workloadId: 'summary', operation: 'summary', requiredCapability: 'nonconfidential', maxExternalAttempts: 2, primaryRouteId: 'summary-primary', modelFallbackRouteIds: [], providerFallbackRouteIds: [] },
      { workloadId: 'embedding', operation: 'embedding', requiredCapability: 'nonconfidential', maxExternalAttempts: 1, primaryRouteId: 'embedding-primary', modelFallbackRouteIds: [], providerFallbackRouteIds: [] },
    ],
    ...overrides,
  }
}

function validatedProviderGraph(overrides = {}) {
  return validateProviderConfiguration(providerGraph(overrides), { now, installedAdapters, trustedEndpointProfiles })
}

describe('Step 9 remediation adversarial regressions', () => {
  it('projects an adapter summary before strict validation and keeps the configured summary timeout bounded', async () => {
    const harness = readFileSync(new URL('../../../scripts/step9-real-provider-smoke.js', import.meta.url), 'utf8')
    const adapterResult = { titleVi: 'Tiêu đề tiếng Việt', summaryVi: 'Nội dung tiếng Việt an toàn có nguồn.', summaryParagraphsVi: ['Đoạn chi tiết thứ nhất chỉ dùng dữ liệu nguồn đã được cấp.', 'Đoạn chi tiết thứ hai giữ nguyên các thuật ngữ kỹ thuật cần thiết.'] }
    const providerResponse = { model: 'summary-model-v1', choices: [{ message: { content: JSON.stringify(adapterResult) } }] }
    expect(validateVietnameseSummary(adapterResult)).toEqual(expect.objectContaining({ titleVi: adapterResult.titleVi, summaryVi: adapterResult.summaryVi, summaryParagraphsVi: adapterResult.summaryParagraphsVi }))
    expect(() => validateVietnameseSummary({ titleVi: adapterResult.titleVi, summaryVi: adapterResult.summaryVi })).toThrow(/shape/i)
    expect(harness).toContain('validateVietnameseSummary({')
    expect(harness).toContain('summaryParagraphsVi: output?.summaryParagraphsVi')

    const registry = validatedProviderGraph()
    const abortTimeout = vi.spyOn(globalThis.AbortSignal, 'timeout').mockReturnValue(new globalThis.AbortController().signal)
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify(providerResponse), { headers: { 'Content-Type': 'application/json' } }))
    const adapters = createConfiguredProviderAdapters({ registry, trustedEndpointProfiles, fetchImpl, resolveCredential: () => 'secret' })
    await adapters.llmProvider.summarize({ route: registry.routes[0], input: 'safe', locale: 'vi', tools: [] })
    expect(abortTimeout).toHaveBeenCalledWith(30_000)
    expect(fetchImpl.mock.calls[0][0]).toBe('https://summary.example/v1/chat/completions')
    abortTimeout.mockRestore()
  })

  it('binds the configured adapter profile and rejects unknown provider startup routes', async () => {
    const registry = validatedProviderGraph()
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ titleVi: 'Tiêu đề', summaryVi: 'Tóm tắt tiếng Việt.', summaryParagraphsVi: ['Đoạn chi tiết thứ nhất nêu kết quả chính của bài viết.', 'Đoạn chi tiết thứ hai mô tả bối cảnh và giới hạn.'] }) } }] }), { headers: { 'Content-Type': 'application/json' } }))
    const adapters = createConfiguredProviderAdapters({ registry, trustedEndpointProfiles, fetchImpl, resolveCredential: () => 'secret' })
    await expect(adapters.llmProvider.summarize({ route: registry.routes[0], input: 'safe', locale: 'vi', tools: [] })).resolves.toMatchObject({ model: 'summary-model-v1' })
    expect(fetchImpl.mock.calls[0][0]).toBe('https://summary.example/v1/chat/completions')
    expect(() => validateProviderConfiguration(providerGraph({ providers: [{ ...providerGraph().providers[0], adapterId: 'missing-adapter' }, providerGraph().providers[1]] }), { now, installedAdapters, trustedEndpointProfiles })).toThrow(/adapter/i)
  })

  it('sends a bounded configured embedding batch in one adapter request and preserves every vector', async () => {
    const registry = validatedProviderGraph()
    const vectors = [Array(3).fill(0.01), Array(3).fill(0.02)]
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ data: vectors.map((embedding) => ({ embedding })) }), { headers: { 'Content-Type': 'application/json' } }))
    const adapters = createConfiguredProviderAdapters({ registry, trustedEndpointProfiles, fetchImpl, resolveCredential: () => 'secret' })
    await expect(adapters.embeddingProvider.embedBatch({ route: registry.routes[1], inputs: ['truy vấn tiếng Việt', 'tài liệu tiếng Việt'], model: 'embedding-model-v1', dimensions: 3 }))
      .resolves.toEqual({ model: 'embedding-model-v1', embeddings: vectors })
    expect(fetchImpl).toHaveBeenCalledTimes(1)
    expect(fetchImpl.mock.calls[0][0]).toBe('https://embedding.example/v1/embeddings')
    expect(JSON.parse(fetchImpl.mock.calls[0][1].body)).toEqual({ model: 'embedding-model-v1', input: ['truy vấn tiếng Việt', 'tài liệu tiếng Việt'], dimensions: 3 })
  })

  it('recovers an expired half-open probe so its route cannot remain permanently stuck', () => {
    const state = {
      admissionDomainId: domain.admissionDomainId, providerId: domain.providerId, maxConcurrency: 1, budgetWindowStart: now, spentUnits: 0, budgetLimit: 5,
      activeReservations: [{ reservationId: 'expired-probe', routeId: route.routeId, attemptId: '507f1f77bcf86cd799439041', kind: 'summary', expiresAt: new Date(now.getTime() - 1) }],
      routeCircuits: [{ routeId: route.routeId, state: 'half-open', consecutiveRetryableFailures: 3, halfOpenProbeReservationId: 'expired-probe' }], updatedAt: now,
    }
    const replacement = applyProviderReservation(state, { domain, route, reservationId: 'replacement-probe', attemptId: '507f1f77bcf86cd799439042', kind: 'summary', now, expiresAt: new Date(now.getTime() + 60_000) })
    expect(replacement.allowed).toBe(true)
    expect(replacement.state.routeCircuits[0].halfOpenProbeReservationId).toBe('replacement-probe')
  })

  it('fails closed before provider admission for email, credential-like text, or missing fulltext-temporary input', () => {
    expect(() => buildPolicyDerivedInput({ article: { ...article, titleOriginal: 'contact me@example.com sk-test-secret' }, source, purpose: 'summary' })).toThrow(/privacy/i)
    expect(() => buildPolicyDerivedInput({ article: { ...article, titleOriginal: 'sk-test-secret' }, source, purpose: 'summary' })).toThrow(/privacy/i)
    const temporary = { ...source, llmInputScope: 'fulltext-temporary' }
    expect(() => buildPolicyDerivedInput({ article, source: temporary, purpose: 'summary' })).toThrow(/temporary/i)
  })

  it('cancels a fenced running job before executor/provider work begins', async () => {
    const candidate = { id: '507f1f77bcf86cd799439041', articleId: ARTICLE_ID, task: 'summary' }
    const jobRepository = { selectDueIndexing: vi.fn(), recoverExpiredIndexing: vi.fn(), nextAvailableAt: vi.fn(), claimQueuedWithFence: vi.fn(async () => true), cancellationRequestedWithFence: vi.fn(async () => true), completeWithFence: vi.fn() }
    const leaseRepository = { acquire: vi.fn(async ({ key }) => ({ key, ownerTokenHash: 'a'.repeat(64), leaseGeneration: 1 })), release: vi.fn() }
    const executor = vi.fn()
    const queue = createIndexingQueueAdapter({ jobRepository, leaseRepository, executor, ownerToken: () => 'owner-token' })
    await expect(queue.claimAndExecute({ candidate, now })).resolves.toEqual({ status: 'partial', claimed: true })
    expect(executor).not.toHaveBeenCalled()
    expect(jobRepository.completeWithFence).toHaveBeenCalledWith(expect.objectContaining({ status: 'cancelled' }))
  })

  it('maps all list-indexing semantic query failures to canonical 422 validation_error', async () => {
    const repository = new MongoIndexingJobRepository({ db: {}, client: {} })
    await expect(repository.listIndexingJobs({ articleId: 'not-an-object-id' })).rejects.toMatchObject({ status: 422, code: 'validation_error' })
    await expect(repository.listIndexingJobs({ limit: '0' })).rejects.toMatchObject({ status: 422, code: 'validation_error' })
  })

  it('keeps indexing and retrieval integration free of vendor/model literals', () => {
    const ownedFiles = [
      '../../../server/bootstrap/indexing.js',
      '../../../server/application/indexing/artifact-processor.js',
      '../../../server/application/indexing/service.js',
      '../../../server/repositories/mongo/article-repository.js',
      '../../../server/repositories/mongo/indexing-job-repository.js',
      '../../../server/application/search/service.js',
      '../../../server/ai/retrieval.js',
    ]
    for (const file of ownedFiles) expect(readFileSync(new URL(file, import.meta.url), 'utf8')).not.toMatch(/opencode|openrouter|deepseek|baai|bge-m3/i)
  })
})
