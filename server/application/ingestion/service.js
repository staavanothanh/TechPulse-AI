import { evaluateContentPolicy } from '../../domain/policy/content-policy.js'
import { ArticleError, policyVersionMismatch, sourcePolicyBlocked } from '../../domain/article/errors.js'
import { normalizeCandidateToArticle } from '../../domain/article/normalization.js'

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`
  return JSON.stringify(value)
}

function sourceIdentifier(source) {
  return source?.id ?? source?.sourceId ?? source?._id
}

function executionError(code, message, retryable = false) {
  const error = new Error(message)
  error.code = code
  error.retryable = retryable
  return error
}

function assertExecutionAvailable({ signal, deadline, now }) {
  if (signal?.aborted) throw signal.reason ?? executionError('ingestion_aborted', 'Ingestion execution was aborted')
  if (deadline !== undefined) {
    const deadlineAt = deadline instanceof Date ? deadline : new Date(deadline)
    if (Number.isNaN(deadlineAt.getTime())) throw executionError('ingestion_deadline_invalid', 'Ingestion deadline is invalid')
    const current = now()
    if (!(current instanceof Date) || Number.isNaN(current.getTime())) throw executionError('ingestion_clock_invalid', 'Ingestion clock is invalid')
    if (current.getTime() >= deadlineAt.getTime()) throw executionError('ingestion_deadline_exceeded', 'Ingestion execution deadline was exceeded')
  }
}

function emitStage(onStage, event) {
  if (typeof onStage === 'function') onStage(Object.freeze({ ...event }))
}

async function tracedStage(stage, work, { onStage, signal, deadline, now = () => new Date(), details = {}, checkAfter = true } = {}) {
  assertExecutionAvailable({ signal, deadline, now })
  emitStage(onStage, { stage, status: 'started', ...details })
  try {
    const result = await work()
    if (checkAfter) assertExecutionAvailable({ signal, deadline, now })
    emitStage(onStage, { stage, status: 'succeeded', ...details })
    return result
  } catch (error) {
    emitStage(onStage, { stage, status: error?.code === 'ingestion_deadline_exceeded' ? 'timeout' : 'failed', error })
    throw error
  }
}

function assertSourceForIngestion(source, job) {
  if (!source || source.operationalStatus !== 'active' || !['permitted', 'metadata-only'].includes(source.licenseStatus)) throw sourcePolicyBlocked()
  if (source.technicalCheck?.status !== 'passed') throw sourcePolicyBlocked()
  if (job?.connectorType && source.connectorType !== job.connectorType) throw policyVersionMismatch()
  if (Number.isInteger(job?.expectedSourcePolicyVersion) && source.policyVersion !== job.expectedSourcePolicyVersion) throw policyVersionMismatch()
  if (job?.expectedConnectorConfig && stableJson(source.connectorConfig) !== stableJson(job.expectedConnectorConfig)) throw policyVersionMismatch()
  const gate = evaluateContentPolicy(source, 'metadata')
  if (!gate.allowed) throw sourcePolicyBlocked()
  return source
}

async function loadSource(sourceRepository, sourceId, options = {}) {
  if (typeof sourceRepository?.findSourceById !== 'function') throw new ArticleError('source_policy_unavailable', 'Current source policy is unavailable', { status: 503, retryable: true })
  const source = await sourceRepository.findSourceById(String(sourceId), options)
  if (!source) throw sourcePolicyBlocked()
  return source
}

export function createIngestionService({ connectorRegistry, sourceRepository, articleRepository, currentSourcePolicy, now = () => new Date() } = {}) {
  if (!connectorRegistry || typeof connectorRegistry.resolve !== 'function') throw new Error('Connector registry is required')
  if (!sourceRepository || typeof sourceRepository.findSourceById !== 'function') throw new Error('Source repository is required')
  if (!articleRepository || typeof articleRepository.commitIngestionBatch !== 'function') throw new Error('Article repository is required')

  async function captureSource(job, options = {}) {
    return tracedStage('source_capture', async () => {
      const source = assertSourceForIngestion(await loadSource(sourceRepository, job?.sourceId, options), job)
      if (typeof currentSourcePolicy?.content === 'function') {
        const gate = await currentSourcePolicy.content({ sourceId: sourceIdentifier(source), purpose: 'metadata' })
        if (!gate?.allowed || gate.policyVersion !== source.policyVersion) throw policyVersionMismatch()
      }
      return { source, expectedSourcePolicyVersion: source.policyVersion, expectedConnectorConfig: JSON.parse(JSON.stringify(source.connectorConfig)) }
    }, options)
  }

  async function execute({ job, fence, payload, response, body, contentType, contentEncoding, url, retrievedAt, signal, deadline, onStage, ...runOptions } = {}) {
    const stageOptions = { signal, deadline, onStage, now }
    const captured = await captureSource(job, stageOptions)
    const connector = connectorRegistry.resolve(captured.source)
    const observedAt = retrievedAt ?? now()
    const connectorResult = await tracedStage('connector', () => connector.run({ source: captured.source, payload, response, body, contentType, contentEncoding, url, retrievedAt: observedAt, signal, deadline, onStage, ...runOptions }), stageOptions)
    assertExecutionAvailable(stageOptions)
    const current = assertSourceForIngestion(await loadSource(sourceRepository, job.sourceId, stageOptions), { ...job, expectedSourcePolicyVersion: captured.expectedSourcePolicyVersion, expectedConnectorConfig: captured.expectedConnectorConfig })
    const candidates = connectorResult?.candidates ?? []
    const normalized = await tracedStage('normalize_articles', async () => candidates.map((candidate) => {
      assertExecutionAvailable(stageOptions)
      return normalizeCandidateToArticle(candidate, { source: current, now: observedAt })
    }), { ...stageOptions, details: { counters: { fetched: candidates.length } } })
    const last = normalized.at(-1)
    const checkpoint = {
      processedCount: (job.checkpoint?.processedCount ?? 0) + normalized.length,
      ...(connectorResult?.cursor !== undefined ? { cursor: String(connectorResult.cursor) } : {}),
      ...(last?.externalId ? { lastExternalId: last.externalId } : {}),
    }
    return tracedStage('commit', () => articleRepository.commitIngestionBatch({
      job,
      fence,
      source: current,
      expectedSourcePolicyVersion: captured.expectedSourcePolicyVersion,
      expectedConnectorConfig: captured.expectedConnectorConfig,
      candidates,
      articles: normalized,
      checkpoint,
      counters: { fetched: candidates.length },
      retrievedAt: observedAt,
      signal,
      deadline,
    }), { ...stageOptions, details: { counters: { fetched: candidates.length } }, checkAfter: false })
  }

  return Object.freeze({ captureSource, execute, ingest: execute, run: execute })
}

export { assertSourceForIngestion, stableJson }
