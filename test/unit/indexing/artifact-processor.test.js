import { describe, expect, it, vi } from 'vitest'
import { createArtifactProcessor } from '../../../server/application/indexing/artifact-processor.js'
import { ProviderAdapterError, providerFailure } from '../../../server/ai/provider-error-taxonomy.js'
import { ProviderRoutingError } from '../../../server/ai/provider-router.js'
import { buildPolicyDerivedInput } from '../../../server/ai/policy-input.js'

const ARTICLE_ID = '507f1f77bcf86cd799439011'
const SOURCE_ID = '507f1f77bcf86cd799439021'
const source = {
  id: SOURCE_ID, name: 'Tech Review', policyVersion: 4, operationalStatus: 'active', technicalCheck: { status: 'passed' },
  licenseStatus: 'permitted', llmInputScope: 'metadata', storageScope: { metadata: true, excerpt: false, summary: true, embedding: true },
  mediaPolicy: { imageMode: 'none', videoMode: 'none', allowedHosts: [], attributionRequired: false },
}
const article = {
  id: ARTICLE_ID, sourceId: SOURCE_ID, status: 'published', titleOriginal: 'A safer AI accelerator', titleVi: null,
  author: null, publishedAt: new Date('2026-08-10T00:00:00.000Z'), topics: ['AI'], summaryStatus: 'pending', summaryVi: null,
}
const fence = { key: `indexing:article:${ARTICLE_ID}`, ownerTokenHash: 'a'.repeat(64), leaseGeneration: 1 }
const embeddingTarget = { model: 'embedding-model-v1', dimensions: 3, version: 7, artifactCompatibilityId: 'embedding-compat-v1' }
const routes = {
  summary: { routeId: 'summary-primary', model: 'summary-model-v1', providerId: 'summary-adapter', artifactCompatibilityId: 'summary-compat-v1' },
  embedding: { routeId: 'embedding-primary', model: embeddingTarget.model, providerId: 'embedding-adapter', artifactCompatibilityId: embeddingTarget.artifactCompatibilityId },
}

function makeRouter({ routeOverrides = {}, onInvoke } = {}) {
  return {
    execute: vi.fn(async ({ workloadId, admittedInput, invoke, validateOutput }) => {
      const route = { ...routes[workloadId], ...(routeOverrides[workloadId] ?? {}) }
      onInvoke?.({ workloadId, route, admittedInput })
      const output = await invoke({ route, admittedInput })
      return { output: validateOutput({ route, output, admittedInput }), metadata: { routeId: route.routeId, model: route.model, fallback: 'none' } }
    }),
  }
}

function setup({ providerRouter = makeRouter(), sourceLookup = () => source, articleLookup = () => article, indexingJobRepository, llmProvider, embeddingProvider, target = embeddingTarget } = {}) {
  const articleRepository = {
    findArticleForIndexing: vi.fn(async () => articleLookup()),
    commitSummaryArtifact: vi.fn(async () => true),
    commitEmbeddingArtifact: vi.fn(async () => true),
    markArtifactProcessing: vi.fn(async () => true),
    markArtifactFailed: vi.fn(async () => true),
    resetArtifactPending: vi.fn(async () => true),
    reconcileArticleVisibility: vi.fn(async () => true),
  }
  const sourceRepository = { findSourceById: vi.fn(async () => sourceLookup()) }
  const providerAdmission = { getRoute: vi.fn((routeId) => Object.values(routes).find((route) => route.routeId === routeId) ?? null) }
  const llm = llmProvider ?? { summarize: vi.fn(async () => ({ titleVi: 'Bộ tăng tốc AI an toàn hơn', summaryVi: 'Thiết kế mới giúp tăng tốc khối lượng công việc AI trong khi duy trì các ràng buộc an toàn đã công bố.' })) }
  const embedding = embeddingProvider ?? { embed: vi.fn(async () => ({ model: target.model, embedding: [0.01, 0.02, 0.03] })) }
  const processor = createArtifactProcessor({ articleRepository, sourceRepository, indexingJobRepository, providerAdmission, providerRouter, llmProvider: llm, embeddingProvider: embedding, embeddingTarget: target, now: () => new Date('2026-08-10T01:00:00.000Z') })
  return { processor, articleRepository, sourceRepository, providerAdmission, providerRouter, llmProvider: llm, embeddingProvider: embedding }
}

describe('Step 9 artifact processor', () => {
  it('runs visibility reconciliation through the exact commit fence', async () => {
    const { processor, articleRepository, providerRouter } = setup()
    const job = { id: '507f1f77bcf86cd799439053', articleId: ARTICLE_ID, sourceId: SOURCE_ID, expectedSourcePolicyVersion: 4, task: 'visibility-reconcile' }

    await expect(processor.execute({ job, fence })).resolves.toEqual({ status: 'succeeded' })
    expect(articleRepository.reconcileArticleVisibility).toHaveBeenCalledWith(expect.objectContaining({ job, fence }))
    expect(providerRouter.execute).not.toHaveBeenCalled()

    articleRepository.reconcileArticleVisibility.mockResolvedValue(false)
    await expect(processor.execute({ job, fence })).rejects.toMatchObject({ code: 'artifact_commit_stale' })
  })

  it('rejects an unknown indexing task before provider work', async () => {
    const { processor, providerRouter } = setup()
    await expect(processor.execute({
      job: { id: '507f1f77bcf86cd799439054', articleId: ARTICLE_ID, sourceId: SOURCE_ID, expectedSourcePolicyVersion: 4, task: 'unknown' },
      fence,
    })).rejects.toMatchObject({ code: 'indexing_task_invalid' })
    expect(providerRouter.execute).not.toHaveBeenCalled()
  })

  it('uses the published workload router contract for summary generation', async () => {
    const { processor, articleRepository, providerRouter } = setup()
    await expect(processor.execute({ job: { id: '507f1f77bcf86cd799439051', articleId: ARTICLE_ID, sourceId: SOURCE_ID, expectedSourcePolicyVersion: 4, task: 'summary' }, fence })).resolves.toMatchObject({ status: 'succeeded' })
    expect(providerRouter.execute).toHaveBeenCalledWith(expect.objectContaining({ workloadId: 'summary', attemptId: '507f1f77bcf86cd799439051' }))
    expect(articleRepository.commitSummaryArtifact).toHaveBeenCalledWith(expect.objectContaining({ summary: expect.objectContaining({ summaryModel: 'summary-model-v1' }) }))
  })

  it('commits configured embedding metadata and exact artifact compatibility identity', async () => {
    const { processor, articleRepository } = setup()
    await expect(processor.execute({ job: { id: '507f1f77bcf86cd799439042', articleId: ARTICLE_ID, sourceId: SOURCE_ID, expectedSourcePolicyVersion: 4, task: 'embedding', targetEmbeddingVersion: embeddingTarget.version, targetEmbeddingArtifactCompatibilityId: embeddingTarget.artifactCompatibilityId }, fence })).resolves.toMatchObject({ status: 'succeeded' })
    expect(articleRepository.commitEmbeddingArtifact).toHaveBeenCalledWith(expect.objectContaining({ embedding: expect.objectContaining({ embeddingModel: embeddingTarget.model, embeddingDimensions: embeddingTarget.dimensions, embeddingVersion: embeddingTarget.version, embeddingArtifactCompatibilityId: embeddingTarget.artifactCompatibilityId, embeddingStatus: 'ready' }) }))
    expect(articleRepository.commitSummaryArtifact).not.toHaveBeenCalled()
  })

  it('discards provider output when policy/version or commit fence changed', async () => {
    const { processor, articleRepository, sourceRepository } = setup()
    sourceRepository.findSourceById.mockResolvedValue({ ...source, policyVersion: 5 })
    await expect(processor.execute({ job: { id: '507f1f77bcf86cd799439043', articleId: ARTICLE_ID, sourceId: SOURCE_ID, expectedSourcePolicyVersion: 4, task: 'summary' }, fence })).rejects.toMatchObject({ code: 'policy_version_mismatch' })
    sourceRepository.findSourceById.mockResolvedValue(source)
    articleRepository.commitSummaryArtifact.mockResolvedValue(false)
    await expect(processor.execute({ job: { id: '507f1f77bcf86cd799439044', articleId: ARTICLE_ID, sourceId: SOURCE_ID, expectedSourcePolicyVersion: 4, task: 'summary' }, fence })).rejects.toMatchObject({ code: 'artifact_commit_stale' })
  })

  it('preserves the same admitted input on a model fallback', async () => {
    const calls = []
    const providerRouter = {
      execute: vi.fn(async ({ invoke, validateOutput, admittedInput }) => {
        const primary = { ...routes.summary, routeId: 'summary-primary' }
        const fallback = { ...routes.summary, routeId: 'summary-fallback', model: 'summary-model-v2' }
        let output
        try { output = await invoke({ route: primary, admittedInput }) } catch (error) {
          if (error instanceof ProviderAdapterError && error.failureClass === 'policy') throw error
          output = await invoke({ route: fallback, admittedInput })
        }
        return { output: validateOutput({ route: fallback, output, admittedInput }), metadata: { routeId: fallback.routeId, model: fallback.model, fallback: 'model' } }
      }),
    }
    const llm = { summarize: vi.fn(async ({ route, input }) => { calls.push({ route: route.routeId, input }); if (route.routeId === 'summary-primary') throw new ProviderAdapterError('model-retryable'); return { titleVi: 'Bộ tăng tốc AI an toàn hơn', summaryVi: 'Thiết kế mới giúp tăng tốc AI trong khi duy trì các ràng buộc an toàn.' } }) }
    const processor = setup({ providerRouter, llmProvider: llm }).processor
    await expect(processor.execute({ job: { id: '507f1f77bcf86cd799439045', articleId: ARTICLE_ID, sourceId: SOURCE_ID, expectedSourcePolicyVersion: 4, task: 'summary' }, fence })).resolves.toMatchObject({ status: 'succeeded' })
    expect(calls).toHaveLength(2)
    expect(calls[0].input).toBe(calls[1].input)
  })

  it('blocks the second provider call when source policy changes after the first failure', async () => {
    const sourceLookup = vi.fn().mockReturnValueOnce(source).mockReturnValueOnce(source).mockReturnValue({ ...source, policyVersion: 5 })
    const calls = []
    const llm = { summarize: vi.fn(async ({ route }) => { calls.push(route.routeId); throw new ProviderAdapterError('model-retryable') }) }
    const providerRouter = {
      execute: vi.fn(async ({ invoke, validateOutput, admittedInput }) => {
        const primary = routes.summary
        try { await invoke({ route: primary, admittedInput }) } catch (error) {
          if (error instanceof ProviderAdapterError && error.failureClass === 'policy') throw error
          await invoke({ route: { ...primary, routeId: 'summary-fallback', model: 'summary-model-v2' }, admittedInput })
        }
        return { output: validateOutput({ route: primary, output: { titleVi: '', summaryVi: '' }, admittedInput }), metadata: { model: primary.model } }
      }),
    }
    const { processor } = setup({ sourceLookup, providerRouter, llmProvider: llm })
    await expect(processor.execute({ job: { id: '507f1f77bcf86cd799439052', articleId: ARTICLE_ID, sourceId: SOURCE_ID, expectedSourcePolicyVersion: 4, task: 'summary' }, fence })).rejects.toMatchObject({ failureClass: 'policy' })
    expect(calls).toEqual(['summary-primary'])
  })

  it('reuses unchanged ready embedding hashes only when compatibility identity matches', async () => {
    const safe = buildPolicyDerivedInput({ article, source, purpose: 'embedding' })
    const { processor, providerRouter } = setup({ articleLookup: () => ({ ...article, embeddingStatus: 'ready', embedding: [0.01, 0.02, 0.03], embeddingModel: embeddingTarget.model, embeddingDimensions: embeddingTarget.dimensions, embeddingArtifactCompatibilityId: embeddingTarget.artifactCompatibilityId, embeddingVersion: embeddingTarget.version, embeddingInputHash: safe.inputHash, embeddingSourcePolicyVersion: 4 }) })
    await expect(processor.execute({ job: { id: '507f1f77bcf86cd799439046', articleId: ARTICLE_ID, sourceId: SOURCE_ID, expectedSourcePolicyVersion: 4, task: 'embedding', targetEmbeddingVersion: embeddingTarget.version, targetEmbeddingArtifactCompatibilityId: embeddingTarget.artifactCompatibilityId }, fence })).resolves.toEqual({ status: 'succeeded', inputHash: safe.inputHash, cached: true })
    expect(providerRouter.execute).not.toHaveBeenCalled()
  })

  it.each(['legacy-invalidated', 'embedding-compat-v0'])(
    'rejects queued embedding compatibility %s before any provider call',
    async (targetEmbeddingArtifactCompatibilityId) => {
      const { processor, providerRouter, embeddingProvider } = setup()

      await expect(processor.execute({
        job: {
          id: '507f1f77bcf86cd799439049', articleId: ARTICLE_ID, sourceId: SOURCE_ID,
          expectedSourcePolicyVersion: 4, task: 'embedding', targetEmbeddingVersion: embeddingTarget.version,
          targetEmbeddingArtifactCompatibilityId,
        },
        fence,
      })).rejects.toMatchObject({ code: 'embedding_compatibility_mismatch', retryable: false })
      expect(providerRouter.execute).not.toHaveBeenCalled()
      expect(embeddingProvider.embed).not.toHaveBeenCalled()
    },
  )

  it('records processing then a safe failed artifact state when routing fails', async () => {
    const { processor, articleRepository, providerRouter } = setup()
    providerRouter.execute.mockRejectedValue(Object.assign(new Error('upstream'), { code: 'provider_unavailable', retryable: true }))
    await expect(processor.execute({ job: { id: '507f1f77bcf86cd799439047', articleId: ARTICLE_ID, sourceId: SOURCE_ID, expectedSourcePolicyVersion: 4, task: 'summary' }, fence })).rejects.toMatchObject({ code: 'provider_unavailable', retryable: true })
    expect(articleRepository.markArtifactProcessing).toHaveBeenCalledWith(expect.objectContaining({ purpose: 'summary', fence }))
    expect(articleRepository.markArtifactFailed).toHaveBeenCalledWith(expect.objectContaining({ purpose: 'summary', error: expect.objectContaining({ code: 'provider_unavailable', retryable: true }) }))
  })

  it('resets a provider-admission denial to pending when no external call started', async () => {
    const { processor, articleRepository, providerRouter } = setup()
    const failure = Object.assign(new ProviderRoutingError(providerFailure('provider-retryable'), { retryAfterSeconds: 30 }), { externalAttempts: 0 })
    providerRouter.execute.mockRejectedValue(failure)

    await expect(processor.execute({
      job: { id: '507f1f77bcf86cd799439057', articleId: ARTICLE_ID, sourceId: SOURCE_ID, expectedSourcePolicyVersion: 4, task: 'summary' }, fence,
    })).rejects.toBe(failure)
    expect(articleRepository.resetArtifactPending).toHaveBeenCalledWith(expect.objectContaining({ purpose: 'summary', fence, inputHash: expect.any(String) }))
    expect(articleRepository.markArtifactFailed).not.toHaveBeenCalled()
  })

  it('keeps a failed artifact state when the provider call already started', async () => {
    const { processor, articleRepository, providerRouter } = setup()
    const failure = Object.assign(new ProviderRoutingError(providerFailure('provider-retryable'), { retryAfterSeconds: 30 }), { externalAttempts: 1 })
    providerRouter.execute.mockRejectedValue(failure)

    await expect(processor.execute({
      job: { id: '507f1f77bcf86cd799439058', articleId: ARTICLE_ID, sourceId: SOURCE_ID, expectedSourcePolicyVersion: 4, task: 'summary' }, fence,
    })).rejects.toBe(failure)
    expect(articleRepository.markArtifactFailed).toHaveBeenCalledWith(expect.objectContaining({
      purpose: 'summary', fence, error: expect.objectContaining({ code: failure.code, retryable: true }),
    }))
    expect(articleRepository.resetArtifactPending).not.toHaveBeenCalled()
  })

  it('fenced-commits failed when post-processing configuration is unavailable', async () => {
    const { articleRepository, sourceRepository, providerRouter } = setup({ llmProvider: {} })
    await expect(createArtifactProcessor({ articleRepository, sourceRepository, providerAdmission: { getRoute: vi.fn() }, providerRouter, llmProvider: {}, embeddingTarget }).execute({ job: { id: '507f1f77bcf86cd799439049', articleId: ARTICLE_ID, sourceId: SOURCE_ID, expectedSourcePolicyVersion: 4, task: 'summary' }, fence })).rejects.toMatchObject({ code: 'provider_unavailable', retryable: true })
    expect(articleRepository.markArtifactProcessing).toHaveBeenCalledTimes(1)
    expect(articleRepository.markArtifactFailed).toHaveBeenCalledWith(expect.objectContaining({ purpose: 'summary', error: expect.objectContaining({ code: 'provider_unavailable', retryable: true }) }))
  })

  it('surfaces a stale fence when the failed-artifact commit cannot be fenced', async () => {
    const { processor, articleRepository, providerRouter } = setup()
    providerRouter.execute.mockRejectedValue(Object.assign(new Error('upstream'), { code: 'provider_unavailable', retryable: true }))
    articleRepository.markArtifactFailed.mockResolvedValue(false)
    await expect(processor.execute({ job: { id: '507f1f77bcf86cd799439050', articleId: ARTICLE_ID, sourceId: SOURCE_ID, expectedSourcePolicyVersion: 4, task: 'summary' }, fence })).rejects.toMatchObject({ code: 'artifact_commit_stale' })
  })

  it('fenced-resets a post-transition cancellation to pending before any provider call', async () => {
    const indexingJobRepository = { cancellationRequestedWithFence: vi.fn().mockResolvedValueOnce(false).mockResolvedValueOnce(true) }
    const { processor, articleRepository, providerRouter } = setup({ indexingJobRepository })
    await expect(processor.execute({ job: { id: '507f1f77bcf86cd799439048', articleId: ARTICLE_ID, sourceId: SOURCE_ID, expectedSourcePolicyVersion: 4, task: 'summary' }, fence })).resolves.toEqual({ status: 'cancelled' })
    expect(articleRepository.markArtifactProcessing).toHaveBeenCalledTimes(1)
    expect(articleRepository.resetArtifactPending).toHaveBeenCalledWith(expect.objectContaining({ purpose: 'summary', fence }))
    expect(providerRouter.execute).not.toHaveBeenCalled()
  })
})
