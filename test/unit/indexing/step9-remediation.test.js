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
const domain = { admissionDomainId: 'zen-main', provider: 'opencode-zen', maxConcurrency: 1, budgetLimit: 5, budgetWindow: 'day' }
const route = { routeId: 'zen-primary', admissionDomainId: 'zen-main' }

describe('Step 9 remediation adversarial regressions', () => {
  it('projects an adapter summary before strict validation and keeps the Zen summary timeout at thirty seconds', async () => {
    const harness = readFileSync(new URL('../../../scripts/step9-real-provider-smoke.js', import.meta.url), 'utf8')
    const adapterResult = { titleVi: 'Tiêu đề tiếng Việt', summaryVi: 'Nội dung tiếng Việt an toàn có nguồn.', model: 'deepseek-v4-flash-free' }
    expect(validateVietnameseSummary({ titleVi: adapterResult.titleVi, summaryVi: adapterResult.summaryVi })).toEqual({ titleVi: adapterResult.titleVi, summaryVi: adapterResult.summaryVi })
    expect(() => validateVietnameseSummary(adapterResult)).toThrow(/shape/i)
    expect(harness).toContain('validateVietnameseSummary({ titleVi: summaryResult.titleVi, summaryVi: summaryResult.summaryVi })')

    const registry = { domains: [{ ...domain, credentialEnvName: 'ZEN_KEY_ENV' }], routes: [{ ...route, provider: 'opencode-zen', model: 'deepseek-v4-flash-free' }] }
    const abortTimeout = vi.spyOn(globalThis.AbortSignal, 'timeout').mockReturnValue(new globalThis.AbortController().signal)
    const adapters = createConfiguredProviderAdapters({ registry, fetchImpl: vi.fn(async () => new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(adapterResult) } }] }), { headers: { 'Content-Type': 'application/json' } })), resolveCredential: () => 'secret' })
    await adapters.llmProvider.summarize({ route: registry.routes[0], input: 'safe', locale: 'vi', tools: [] })
    expect(abortTimeout).toHaveBeenCalledWith(30_000)
    abortTimeout.mockRestore()
  })

  it('binds the approved OpenCode Zen primary adapter and rejects unknown provider startup routes', async () => {
    const registry = { domains: [{ ...domain, credentialEnvName: 'ZEN_KEY_ENV' }], routes: [{ ...route, provider: 'opencode-zen', model: 'deepseek-v4-flash-free' }] }
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ titleVi: 'Tieu de', summaryVi: 'Tom tat.' }) } }] }), { headers: { 'Content-Type': 'application/json' } }))
    const adapters = createConfiguredProviderAdapters({ registry, fetchImpl, resolveCredential: () => 'secret' })
    await expect(adapters.llmProvider.summarize({ route: registry.routes[0], input: 'safe', locale: 'vi', tools: [] })).resolves.toMatchObject({ model: 'deepseek-v4-flash-free' })
    expect(fetchImpl.mock.calls[0][0]).toBe('https://opencode.ai/zen/v1/chat/completions')
    expect(() => validateProviderConfiguration([{ ...domain, provider: 'unknown-provider', credentialEnvName: 'UNKNOWN_KEY_ENV', routes: [{ ...route, model: 'model', capability: 'nonconfidential', enabled: true, evidenceUrl: 'https://evidence.example/route', reviewedAt: '2026-08-01T00:00:00.000Z', evidenceExpiresAt: '2026-09-01T00:00:00.000Z', retryableFailureThreshold: 3, cooldownSeconds: 60 }] }], { now })).toThrow(/adapter/i)
  })

  it('sends a bounded BGE-M3 batch in one adapter request and preserves every vector', async () => {
    const registry = { domains: [{ admissionDomainId: 'router-main', provider: 'openrouter', credentialEnvName: 'ROUTER_KEY_ENV', maxConcurrency: 1, budgetLimit: 5, budgetWindow: 'day' }], routes: [{ routeId: 'bge-m3', admissionDomainId: 'router-main', provider: 'openrouter', model: 'baai/bge-m3' }] }
    const vectors = [Array(1024).fill(0.01), Array(1024).fill(0.02)]
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ data: vectors.map((embedding) => ({ embedding })) }), { headers: { 'Content-Type': 'application/json' } }))
    const adapters = createConfiguredProviderAdapters({ registry, fetchImpl, resolveCredential: () => 'secret' })
    await expect(adapters.embeddingProvider.embedBatch({ route: registry.routes[0], inputs: ['truy vấn tiếng Việt', 'tài liệu tiếng Việt'], model: 'baai/bge-m3', dimensions: 1024 }))
      .resolves.toEqual({ model: 'baai/bge-m3', embeddings: vectors })
    expect(fetchImpl).toHaveBeenCalledTimes(1)
    expect(JSON.parse(fetchImpl.mock.calls[0][1].body)).toEqual({ model: 'baai/bge-m3', input: ['truy vấn tiếng Việt', 'tài liệu tiếng Việt'], dimensions: 1024 })
  })

  it('recovers an expired half-open probe so its route cannot remain permanently stuck', () => {
    const state = {
      admissionDomainId: domain.admissionDomainId, provider: domain.provider, maxConcurrency: 1, budgetWindowStart: now, spentUnits: 0, budgetLimit: 5,
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
})
