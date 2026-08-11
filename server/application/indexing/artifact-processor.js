import { BGE_M3, validateBgeM3Embedding } from '../../ai/embedding.js'
import { buildPolicyDerivedInput, PolicyInputError } from '../../ai/policy-input.js'
import { validateVietnameseSummary } from '../../ai/summary.js'

export class ArtifactProcessingError extends Error {
  constructor(code, message, { retryable = false } = {}) {
    super(message)
    this.name = 'ArtifactProcessingError'
    this.code = code
    this.retryable = retryable
  }
}

function sourceId(value) { return value?.id ?? value?._id ?? value?.sourceId }

export function createArtifactProcessor({ articleRepository, sourceRepository, indexingJobRepository, providerAdmission, llmProvider, embeddingProvider, routes = {}, now = () => new Date() } = {}) {
  if (!articleRepository || !sourceRepository || !providerAdmission) throw new Error('Artifact processor dependencies are required')
  return Object.freeze({
    async execute({ job, fence } = {}) {
      const article = await articleRepository.findArticleForIndexing(job?.articleId)
      if (!article || String(article.sourceId) !== String(job?.sourceId)) throw new ArtifactProcessingError('article_unavailable', 'Article is unavailable for indexing')
      const source = await sourceRepository.findSourceById(job.sourceId)
      if (!source || String(sourceId(source)) !== String(job.sourceId) || source.policyVersion !== job.expectedSourcePolicyVersion) throw new ArtifactProcessingError('policy_version_mismatch', 'Current source policy changed before artifact processing')
      const generatedAt = now()
      if (job.task === 'visibility-reconcile') {
        const committed = await articleRepository.reconcileArticleVisibility({ job, fence, article, source, expectedSourcePolicyVersion: job.expectedSourcePolicyVersion, now: generatedAt })
        if (!committed) throw new ArtifactProcessingError('artifact_commit_stale', 'Artifact reconciliation fence is stale')
        return { status: 'succeeded' }
      }
      if (!['summary', 'embedding'].includes(job.task)) throw new ArtifactProcessingError('indexing_task_invalid', 'Indexing task is invalid')
      let input
      try { input = buildPolicyDerivedInput({ article, source, purpose: job.task }) } catch (error) {
        if (error instanceof PolicyInputError) throw new ArtifactProcessingError(error.code, error.message)
        throw error
      }
      if (job.task === 'summary' && article.summaryStatus === 'ready' && article.summaryInputHash === input.inputHash && article.summarySourcePolicyVersion === input.policyVersion) return { status: 'succeeded', inputHash: input.inputHash, cached: true }
      if (job.task === 'embedding' && article.embeddingStatus === 'ready' && article.embeddingInputHash === input.inputHash && article.embeddingSourcePolicyVersion === input.policyVersion && article.embeddingModel === BGE_M3.model && article.embeddingDimensions === BGE_M3.dimensions && article.embeddingVersion === BGE_M3.version) return { status: 'succeeded', inputHash: input.inputHash, cached: true }
      const cancellationRequested = async () => Boolean(await indexingJobRepository?.cancellationRequestedWithFence?.({ jobId: job.id, fence }))
      const transition = async (method, error) => {
        if (typeof articleRepository[method] !== 'function') return true
        return articleRepository[method]({
          job, fence, expectedSourcePolicyVersion: job.expectedSourcePolicyVersion, purpose: job.task, inputHash: input.inputHash,
          ...(error ? { error: { code: typeof error.code === 'string' ? error.code : 'artifact_failed', retryable: Boolean(error.retryable) } } : {}),
        })
      }
      if (await cancellationRequested()) return { status: 'cancelled' }
      if (!await transition('markArtifactProcessing')) throw new ArtifactProcessingError('artifact_commit_stale', 'Artifact processing fence is stale')
      const resetCancelledArtifact = async () => {
        if (!await transition('resetArtifactPending')) throw new ArtifactProcessingError('artifact_commit_stale', 'Artifact cancellation fence is stale')
        return { status: 'cancelled' }
      }
      try {
        if (job.task === 'summary') {
          const summaryRoutes = (Array.isArray(routes.summary) ? routes.summary : [routes.summary]).filter(Boolean).slice(0, 2)
          if (!llmProvider || summaryRoutes.length === 0) throw new ArtifactProcessingError('provider_unavailable', 'Summary provider is unavailable', { retryable: true })
          let result
          let lastError
          for (const routeId of summaryRoutes) {
            if (await cancellationRequested()) return resetCancelledArtifact()
            try {
              result = await providerAdmission.run({
                routeId, capability: 'nonconfidential', attemptId: job.id, kind: 'summary',
                invoke: (route) => llmProvider.summarize({ route, input: input.text, locale: 'vi', tools: [], outputSchema: { titleVi: 'string', summaryVi: 'string' } }),
              })
              break
            } catch (error) {
              lastError = error
              if (error?.retryable !== true) throw error
            }
          }
          if (!result) throw lastError ?? new ArtifactProcessingError('provider_unavailable', 'Summary provider is unavailable', { retryable: true })
          const output = validateVietnameseSummary({ titleVi: result.titleVi, summaryVi: result.summaryVi })
          const committed = await articleRepository.commitSummaryArtifact({
            job, fence, expectedSourcePolicyVersion: job.expectedSourcePolicyVersion, inputHash: input.inputHash,
            summary: { ...output, summaryStatus: 'ready', summaryBasis: input.basis, summaryModel: result.model ?? 'configured-summary-route', summaryInputHash: input.inputHash, summarySourcePolicyVersion: input.policyVersion, summaryGeneratedAt: generatedAt, summaryError: null },
          })
          if (!committed) throw new ArtifactProcessingError('artifact_commit_stale', 'Summary commit fence is stale')
          return { status: 'succeeded', inputHash: input.inputHash }
        }
        if (job.task === 'embedding') {
          if (!embeddingProvider || !routes.embedding || job.targetEmbeddingVersion !== BGE_M3.version) throw new ArtifactProcessingError('embedding_version_mismatch', 'Embedding version is not supported')
          if (await cancellationRequested()) return resetCancelledArtifact()
          const result = await providerAdmission.run({
            routeId: routes.embedding, capability: 'nonconfidential', attemptId: job.id, kind: 'embedding',
            invoke: (route) => embeddingProvider.embed({ route, input: input.text, model: BGE_M3.model, dimensions: BGE_M3.dimensions }),
          })
          const vector = validateBgeM3Embedding(result)
          const committed = await articleRepository.commitEmbeddingArtifact({
            job, fence, expectedSourcePolicyVersion: job.expectedSourcePolicyVersion, inputHash: input.inputHash,
            embedding: { embeddingStatus: 'ready', embedding: vector, embeddingModel: BGE_M3.model, embeddingDimensions: BGE_M3.dimensions, embeddingInputHash: input.inputHash, embeddingVersion: BGE_M3.version, embeddingSourcePolicyVersion: input.policyVersion, embeddedAt: generatedAt, embeddingError: null },
          })
          if (!committed) throw new ArtifactProcessingError('artifact_commit_stale', 'Embedding commit fence is stale')
          return { status: 'succeeded', inputHash: input.inputHash }
        }
        throw new ArtifactProcessingError('indexing_task_invalid', 'Indexing task is invalid')
      } catch (error) {
        let failed
        try { failed = await transition('markArtifactFailed', error) } catch { throw new ArtifactProcessingError('artifact_commit_stale', 'Artifact failure fence is stale') }
        if (!failed) throw new ArtifactProcessingError('artifact_commit_stale', 'Artifact failure fence is stale')
        throw error
      }
    },
  })
}
