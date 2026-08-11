import { describe, expect, it, vi } from 'vitest'
import { createArtifactProcessor } from '../../../server/application/indexing/artifact-processor.js'
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

function setup() {
  const articleRepository = {
    findArticleForIndexing: vi.fn(async () => article),
    commitSummaryArtifact: vi.fn(async () => true),
    commitEmbeddingArtifact: vi.fn(async () => true),
    markArtifactProcessing: vi.fn(async () => true),
    markArtifactFailed: vi.fn(async () => true),
    resetArtifactPending: vi.fn(async () => true),
    reconcileArticleVisibility: vi.fn(async () => true),
  }
  const sourceRepository = { findSourceById: vi.fn(async () => source) }
  const providerAdmission = { run: vi.fn(async ({ invoke, routeId }) => invoke({ routeId, model: routeId === 'embedding-bge-m3' ? 'baai/bge-m3' : 'summary-model' })) }
  const llmProvider = { summarize: vi.fn(async () => ({ titleVi: 'Bộ tăng tốc AI an toàn hơn', summaryVi: 'Thiết kế mới giúp tăng tốc khối lượng công việc AI trong khi duy trì các ràng buộc an toàn đã công bố.' })) }
  const embeddingProvider = { embed: vi.fn(async () => ({ model: 'baai/bge-m3', embedding: Array(1024).fill(0.01) })) }
  const processor = createArtifactProcessor({ articleRepository, sourceRepository, providerAdmission, llmProvider, embeddingProvider, routes: { summary: 'summary-primary', embedding: 'embedding-bge-m3' }, now: () => new Date('2026-08-10T01:00:00.000Z') })
  return { processor, articleRepository, sourceRepository, providerAdmission, llmProvider, embeddingProvider }
}

describe('Step 9 artifact processor', () => {
  it('reloads current policy and commits ready Vietnamese summary with the exact fence', async () => {
    const { processor, articleRepository, sourceRepository, llmProvider } = setup()
    const result = await processor.execute({ job: { id: '507f1f77bcf86cd799439041', articleId: ARTICLE_ID, sourceId: SOURCE_ID, expectedSourcePolicyVersion: 4, task: 'summary' }, fence })
    expect(result.status).toBe('succeeded')
    expect(sourceRepository.findSourceById).toHaveBeenCalledWith(SOURCE_ID)
    expect(llmProvider.summarize).toHaveBeenCalledWith(expect.objectContaining({ locale: 'vi', tools: [] }))
    expect(articleRepository.commitSummaryArtifact).toHaveBeenCalledWith(expect.objectContaining({ fence, expectedSourcePolicyVersion: 4, summary: expect.objectContaining({ summaryStatus: 'ready', summaryBasis: 'metadata' }) }))
    expect(articleRepository.commitEmbeddingArtifact).not.toHaveBeenCalled()
  })

  it('commits only exact BGE-M3/1024/version embedding and leaves summary independent', async () => {
    const { processor, articleRepository } = setup()
    const result = await processor.execute({ job: { id: '507f1f77bcf86cd799439042', articleId: ARTICLE_ID, sourceId: SOURCE_ID, expectedSourcePolicyVersion: 4, task: 'embedding', targetEmbeddingVersion: 1 }, fence })
    expect(result.status).toBe('succeeded')
    expect(articleRepository.commitEmbeddingArtifact).toHaveBeenCalledWith(expect.objectContaining({ embedding: expect.objectContaining({ embeddingModel: 'baai/bge-m3', embeddingDimensions: 1024, embeddingVersion: 1, embeddingStatus: 'ready' }) }))
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

  it('uses one retryable summary fallback with the exact same safe input and never downgrades capability', async () => {
    const { articleRepository, sourceRepository } = setup()
    const calls = []
    const providerAdmission = {
      run: vi.fn(async ({ routeId, capability, invoke }) => {
        calls.push({ routeId, capability })
        if (routeId === 'summary-primary') throw Object.assign(new Error('primary unavailable'), { retryable: true })
        return invoke({ routeId, model: 'fallback-model' })
      }),
    }
    const llmProvider = { summarize: vi.fn(async (input) => { calls.push({ input: input.input }); return { titleVi: 'Bộ tăng tốc AI an toàn hơn', summaryVi: 'Thiết kế mới giúp tăng tốc AI trong khi duy trì các ràng buộc an toàn.' } }) }
    const processor = createArtifactProcessor({ articleRepository, sourceRepository, providerAdmission, llmProvider, embeddingProvider: {}, routes: { summary: ['summary-primary', 'summary-fallback'] }, now: () => new Date('2026-08-10T01:00:00.000Z') })
    await expect(processor.execute({ job: { id: '507f1f77bcf86cd799439045', articleId: ARTICLE_ID, sourceId: SOURCE_ID, expectedSourcePolicyVersion: 4, task: 'summary' }, fence })).resolves.toMatchObject({ status: 'succeeded' })
    expect(calls.slice(0, 2)).toEqual([{ routeId: 'summary-primary', capability: 'nonconfidential' }, { routeId: 'summary-fallback', capability: 'nonconfidential' }])
    expect(llmProvider.summarize).toHaveBeenCalledTimes(1)
  })

  it('reuses unchanged ready artifact hashes without another provider call', async () => {
    const safe = buildPolicyDerivedInput({ article, source, purpose: 'summary' })
    const { processor, articleRepository, providerAdmission } = setup()
    articleRepository.findArticleForIndexing.mockResolvedValue({ ...article, summaryStatus: 'ready', summaryVi: 'Tóm tắt tiếng Việt.', summaryInputHash: safe.inputHash, summarySourcePolicyVersion: 4 })
    await expect(processor.execute({ job: { id: '507f1f77bcf86cd799439046', articleId: ARTICLE_ID, sourceId: SOURCE_ID, expectedSourcePolicyVersion: 4, task: 'summary' }, fence })).resolves.toEqual({ status: 'succeeded', inputHash: safe.inputHash, cached: true })
    expect(providerAdmission.run).not.toHaveBeenCalled()
    expect(articleRepository.commitSummaryArtifact).not.toHaveBeenCalled()
  })

  it('records processing then a safe failed artifact state when the provider fails', async () => {
    const { processor, articleRepository, providerAdmission } = setup()
    providerAdmission.run.mockRejectedValue(Object.assign(new Error('upstream'), { code: 'provider_unavailable', retryable: true }))
    await expect(processor.execute({ job: { id: '507f1f77bcf86cd799439047', articleId: ARTICLE_ID, sourceId: SOURCE_ID, expectedSourcePolicyVersion: 4, task: 'summary' }, fence })).rejects.toMatchObject({ code: 'provider_unavailable' })
    expect(articleRepository.markArtifactProcessing).toHaveBeenCalledWith(expect.objectContaining({ purpose: 'summary', fence }))
    expect(articleRepository.markArtifactFailed).toHaveBeenCalledWith(expect.objectContaining({ purpose: 'summary', error: expect.objectContaining({ code: 'provider_unavailable', retryable: true }) }))
  })

  it('fenced-commits failed when post-processing configuration is unavailable', async () => {
    const { articleRepository, sourceRepository, providerAdmission } = setup()
    const processor = createArtifactProcessor({ articleRepository, sourceRepository, providerAdmission, routes: { summary: [] } })
    await expect(processor.execute({ job: { id: '507f1f77bcf86cd799439049', articleId: ARTICLE_ID, sourceId: SOURCE_ID, expectedSourcePolicyVersion: 4, task: 'summary' }, fence }))
      .rejects.toMatchObject({ code: 'provider_unavailable' })
    expect(articleRepository.markArtifactProcessing).toHaveBeenCalledTimes(1)
    expect(articleRepository.markArtifactFailed).toHaveBeenCalledWith(expect.objectContaining({
      purpose: 'summary', error: expect.objectContaining({ code: 'provider_unavailable', retryable: true }),
    }))
  })

  it('surfaces a stale fence when the failed-artifact commit cannot be fenced', async () => {
    const { processor, articleRepository, providerAdmission } = setup()
    providerAdmission.run.mockRejectedValue(Object.assign(new Error('upstream'), { code: 'provider_unavailable', retryable: true }))
    articleRepository.markArtifactFailed.mockResolvedValue(false)
    await expect(processor.execute({ job: { id: '507f1f77bcf86cd799439050', articleId: ARTICLE_ID, sourceId: SOURCE_ID, expectedSourcePolicyVersion: 4, task: 'summary' }, fence }))
      .rejects.toMatchObject({ code: 'artifact_commit_stale' })
  })

  it('fenced-resets a post-transition cancellation to pending before any provider call', async () => {
    const { articleRepository, sourceRepository, llmProvider } = setup()
    const indexingJobRepository = { cancellationRequestedWithFence: vi.fn().mockResolvedValueOnce(false).mockResolvedValueOnce(true) }
    const providerAdmission = { run: vi.fn() }
    const processor = createArtifactProcessor({ articleRepository, sourceRepository, indexingJobRepository, providerAdmission, llmProvider, routes: { summary: 'summary-primary' } })
    await expect(processor.execute({ job: { id: '507f1f77bcf86cd799439048', articleId: ARTICLE_ID, sourceId: SOURCE_ID, expectedSourcePolicyVersion: 4, task: 'summary' }, fence })).resolves.toEqual({ status: 'cancelled' })
    expect(articleRepository.markArtifactProcessing).toHaveBeenCalledTimes(1)
    expect(articleRepository.resetArtifactPending).toHaveBeenCalledWith(expect.objectContaining({ purpose: 'summary', fence }))
    expect(providerAdmission.run).not.toHaveBeenCalled()
  })
})
