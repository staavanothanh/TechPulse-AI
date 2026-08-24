import { DEFAULT_EMBEDDING_DIMENSIONS, DEFAULT_EMBEDDING_VERSION, validateEmbeddingVector } from '../../ai/embedding.js'
import { ProviderAdapterError } from '../../ai/provider-error-taxonomy.js'
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

function embeddingTargetValue(value = {}) {
  const dimensions = value.dimensions ?? DEFAULT_EMBEDDING_DIMENSIONS
  const version = value.version ?? DEFAULT_EMBEDDING_VERSION
  if (!Number.isInteger(dimensions) || dimensions < 1 || !Number.isInteger(version) || version < 1) throw new Error('Embedding target is invalid')
  return Object.freeze({
    ...(typeof value.model === 'string' && value.model ? { model: value.model } : {}),
    dimensions,
    version,
    ...(typeof value.artifactCompatibilityId === 'string' && value.artifactCompatibilityId ? { artifactCompatibilityId: value.artifactCompatibilityId } : {}),
  })
}

function policyChanged() { return new ProviderAdapterError('policy') }

function externalAttemptCount(error) {
  const metadataAttempts = error?.metadata?.externalAttempts
  const directAttempts = error?.externalAttempts
  if (Number.isInteger(metadataAttempts) && metadataAttempts >= 0) {
    // Older callers attached the count directly after constructing the error.
    // Allow that compatibility shape to override the constructor's default zero
    // without ever overriding an explicit non-zero metadata count.
    if (metadataAttempts === 0 && Number.isInteger(directAttempts) && directAttempts > 0) return directAttempts
    return metadataAttempts
  }
  if (Number.isInteger(directAttempts) && directAttempts >= 0) return directAttempts
  return undefined
}

function throwIfAborted(signal) {
  if (!signal?.aborted) return
  throw signal.reason instanceof Error ? signal.reason : new ArtifactProcessingError('indexing_cancelled', 'Indexing execution was cancelled', { retryable: true })
}

export function createArtifactProcessor({ articleRepository, sourceRepository, indexingJobRepository, providerRouter, llmProvider, embeddingProvider, embeddingTarget, now = () => new Date() } = {}) {
  if (!articleRepository || !sourceRepository || !providerRouter) throw new Error('Artifact processor dependencies are required')
  const target = embeddingTargetValue(embeddingTarget)

  return Object.freeze({
    async execute({ job, fence, signal } = {}) {
      throwIfAborted(signal)
      const article = await articleRepository.findArticleForIndexing(job?.articleId)
      if (!article || String(article.sourceId) !== String(job?.sourceId)) throw new ArtifactProcessingError('article_unavailable', 'Article is unavailable for indexing')
      const source = await sourceRepository.findSourceById(job.sourceId)
      if (!source || String(sourceId(source)) !== String(job.sourceId) || source.policyVersion !== job.expectedSourcePolicyVersion) throw new ArtifactProcessingError('policy_version_mismatch', 'Current source policy changed before artifact processing')
      const generatedAt = now()
      if (job.task === 'visibility-reconcile') {
        throwIfAborted(signal)
        const committed = await articleRepository.reconcileArticleVisibility({ job, fence, article, source, expectedSourcePolicyVersion: job.expectedSourcePolicyVersion, now: generatedAt })
        if (!committed) throw new ArtifactProcessingError('artifact_commit_stale', 'Artifact reconciliation fence is stale')
        return { status: 'succeeded' }
      }
      if (!['summary', 'embedding'].includes(job.task)) throw new ArtifactProcessingError('indexing_task_invalid', 'Indexing task is invalid')
      const assertEmbeddingJobTarget = () => {
        if (job.task !== 'embedding') return
        if (job.targetEmbeddingVersion !== target.version) throw new ArtifactProcessingError('embedding_version_mismatch', 'Embedding version is not supported')
        if (typeof target.artifactCompatibilityId !== 'string' || !target.artifactCompatibilityId
          || job.targetEmbeddingArtifactCompatibilityId !== target.artifactCompatibilityId) {
          throw new ArtifactProcessingError('embedding_compatibility_mismatch', 'Embedding compatibility target is not supported')
        }
      }
      assertEmbeddingJobTarget()
      let input
      try { input = buildPolicyDerivedInput({ article, source, purpose: job.task }) } catch (error) {
        if (error instanceof PolicyInputError) throw new ArtifactProcessingError(error.code, error.message)
        throw error
      }
      if (job.task === 'summary' && article.summaryStatus === 'ready' && article.summaryDetailStatus === 'ready' && Array.isArray(article.summaryParagraphsVi) && article.summaryInputHash === input.inputHash && article.summarySourcePolicyVersion === input.policyVersion) return { status: 'succeeded', inputHash: input.inputHash, cached: true }
      const embeddingCompatible = article.embeddingStatus === 'ready'
        && article.embeddingInputHash === input.inputHash
        && article.embeddingSourcePolicyVersion === input.policyVersion
        && article.embeddingDimensions === target.dimensions
        && article.embeddingVersion === target.version
        && (!target.artifactCompatibilityId || article.embeddingArtifactCompatibilityId === target.artifactCompatibilityId)
      if (job.task === 'embedding' && embeddingCompatible) return { status: 'succeeded', inputHash: input.inputHash, cached: true }

      const cancellationRequested = async () => Boolean(await indexingJobRepository?.cancellationRequestedWithFence?.({ jobId: job.id, fence }))
      const transition = async (method, error) => {
        if (typeof articleRepository[method] !== 'function') return true
        return articleRepository[method]({
          job, fence, expectedSourcePolicyVersion: job.expectedSourcePolicyVersion, purpose: job.task, inputHash: input.inputHash,
          ...(error ? { error: { code: typeof error.code === 'string' ? error.code : 'artifact_failed', retryable: Boolean(error.retryable) } } : {}),
        })
      }
      if (await cancellationRequested()) return { status: 'cancelled' }
      throwIfAborted(signal)
      if (!await transition('markArtifactProcessing')) throw new ArtifactProcessingError('artifact_commit_stale', 'Artifact processing fence is stale')
      const resetCancelledArtifact = async () => {
        const reset = await articleRepository.resetArtifactPending({
          job, fence, expectedSourcePolicyVersion: job.expectedSourcePolicyVersion, purpose: job.task,
          inputHash: input.inputHash, cancellationRequested: true,
        })
        if (!reset) throw new ArtifactProcessingError('artifact_commit_stale', 'Artifact cancellation fence is stale')
        return { status: 'cancelled' }
      }
      const assertInputStillAdmitted = async () => {
        const currentSource = await sourceRepository.findSourceById(job.sourceId)
        if (!currentSource || String(sourceId(currentSource)) !== String(job.sourceId) || currentSource.policyVersion !== job.expectedSourcePolicyVersion) throw policyChanged()
        let currentInput
        try { currentInput = buildPolicyDerivedInput({ article, source: currentSource, purpose: job.task }) } catch { throw policyChanged() }
        if (currentInput.inputHash !== input.inputHash || currentInput.policyVersion !== input.policyVersion) throw policyChanged()
      }

      try {
        if (job.task === 'summary') {
          if (!llmProvider || typeof llmProvider.summarize !== 'function') throw new ArtifactProcessingError('provider_unavailable', 'Summary provider is unavailable', { retryable: true })
          if (await cancellationRequested()) return resetCancelledArtifact()
          const result = await providerRouter.execute({
            workloadId: 'summary', admittedInput: input, attemptId: String(job.id),
            invoke: async ({ route, admittedInput }) => {
              throwIfAborted(signal)
              await assertInputStillAdmitted()
              return llmProvider.summarize({ route, input: admittedInput.text, locale: 'vi', tools: [], outputSchema: { titleVi: 'string', summaryVi: 'string', summaryParagraphsVi: 'string[]' }, signal })
            },
            validateOutput: ({ output }) => validateVietnameseSummary({ titleVi: output?.titleVi, summaryVi: output?.summaryVi, summaryParagraphsVi: output?.summaryParagraphsVi }),
          })
          throwIfAborted(signal)
          if (await cancellationRequested()) return resetCancelledArtifact()
          const committed = await articleRepository.commitSummaryArtifact({
            job, fence, expectedSourcePolicyVersion: job.expectedSourcePolicyVersion, inputHash: input.inputHash,
            summary: { ...result.output, summaryStatus: 'ready', summaryDetailStatus: 'ready', summaryBasis: input.basis, summaryModel: result.metadata?.model, summaryInputHash: input.inputHash, summarySourcePolicyVersion: input.policyVersion, summaryGeneratedAt: generatedAt, summaryError: null },
          })
          if (!committed) throw new ArtifactProcessingError('artifact_commit_stale', 'Summary commit fence is stale')
          return { status: 'succeeded', inputHash: input.inputHash, metadata: result.metadata }
        }
        if (job.task === 'embedding') {
          if (!embeddingProvider || typeof embeddingProvider.embed !== 'function') throw new ArtifactProcessingError('embedding_unavailable', 'Embedding provider is unavailable', { retryable: true })
          if (await cancellationRequested()) return resetCancelledArtifact()
          const result = await providerRouter.execute({
            workloadId: 'embedding', admittedInput: input, attemptId: String(job.id),
            invoke: async ({ route, admittedInput }) => {
              throwIfAborted(signal)
              await assertInputStillAdmitted()
              return embeddingProvider.embed({ route, input: admittedInput.text, model: route.model, dimensions: target.dimensions, signal })
            },
            validateOutput: ({ route, output }) => {
              if (typeof route?.model !== 'string' || !route.model || typeof route.artifactCompatibilityId !== 'string' || !route.artifactCompatibilityId || target.artifactCompatibilityId && route.artifactCompatibilityId !== target.artifactCompatibilityId) throw new ProviderAdapterError('config')
              const vector = validateEmbeddingVector(output?.embedding, { dimensions: target.dimensions })
              if (output?.model !== undefined && output.model !== route.model) throw new ProviderAdapterError('schema')
              return { model: route.model, dimensions: target.dimensions, version: target.version, artifactCompatibilityId: route.artifactCompatibilityId, embedding: vector }
            },
          })
          throwIfAborted(signal)
          if (await cancellationRequested()) return resetCancelledArtifact()
          const artifact = result.output
          assertEmbeddingJobTarget()
          const committed = await articleRepository.commitEmbeddingArtifact({
            job, fence, expectedSourcePolicyVersion: job.expectedSourcePolicyVersion, inputHash: input.inputHash,
            embedding: { embeddingStatus: 'ready', embedding: artifact.embedding, embeddingModel: artifact.model, embeddingDimensions: artifact.dimensions, embeddingArtifactCompatibilityId: artifact.artifactCompatibilityId, embeddingInputHash: input.inputHash, embeddingVersion: artifact.version, embeddingSourcePolicyVersion: input.policyVersion, embeddedAt: generatedAt, embeddingError: null },
          })
          if (!committed) throw new ArtifactProcessingError('artifact_commit_stale', 'Embedding commit fence is stale')
          return { status: 'succeeded', inputHash: input.inputHash, metadata: result.metadata }
        }
        throw new ArtifactProcessingError('indexing_task_invalid', 'Indexing task is invalid')
      } catch (error) {
        if (signal?.aborted) throw signal.reason instanceof Error ? signal.reason : error
        if (await cancellationRequested()) return resetCancelledArtifact()
        if (error?.code === 'indexing_cancelled') return resetCancelledArtifact()
        if (error?.retryable === true && externalAttemptCount(error) === 0) {
          if (!await transition('resetArtifactPending')) throw new ArtifactProcessingError('artifact_commit_stale', 'Artifact retry fence is stale')
          throw error
        }
        let failed
        try { failed = await transition('markArtifactFailed', error) } catch { throw new ArtifactProcessingError('artifact_commit_stale', 'Artifact failure fence is stale') }
        if (!failed) throw new ArtifactProcessingError('artifact_commit_stale', 'Artifact failure fence is stale')
        throw error
      }
    },
  })
}
