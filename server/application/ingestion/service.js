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

async function loadSource(sourceRepository, sourceId) {
  if (typeof sourceRepository?.findSourceById !== 'function') throw new ArticleError('source_policy_unavailable', 'Current source policy is unavailable', { status: 503, retryable: true })
  const source = await sourceRepository.findSourceById(String(sourceId))
  if (!source) throw sourcePolicyBlocked()
  return source
}

export function createIngestionService({ connectorRegistry, sourceRepository, articleRepository, currentSourcePolicy, now = () => new Date() } = {}) {
  if (!connectorRegistry || typeof connectorRegistry.resolve !== 'function') throw new Error('Connector registry is required')
  if (!sourceRepository || typeof sourceRepository.findSourceById !== 'function') throw new Error('Source repository is required')
  if (!articleRepository || typeof articleRepository.commitIngestionBatch !== 'function') throw new Error('Article repository is required')

  async function captureSource(job) {
    const source = assertSourceForIngestion(await loadSource(sourceRepository, job?.sourceId), job)
    if (typeof currentSourcePolicy?.content === 'function') {
      const gate = await currentSourcePolicy.content({ sourceId: sourceIdentifier(source), purpose: 'metadata' })
      if (!gate?.allowed || gate.policyVersion !== source.policyVersion) throw policyVersionMismatch()
    }
    return { source, expectedSourcePolicyVersion: source.policyVersion, expectedConnectorConfig: JSON.parse(JSON.stringify(source.connectorConfig)) }
  }

  async function execute({ job, fence, payload, response, body, contentType, contentEncoding, url, retrievedAt, ...runOptions } = {}) {
    const captured = await captureSource(job)
    const connector = connectorRegistry.resolve(captured.source)
    const observedAt = retrievedAt ?? now()
    const connectorResult = await connector.run({ source: captured.source, payload, response, body, contentType, contentEncoding, url, retrievedAt: observedAt, ...runOptions })
    const current = assertSourceForIngestion(await loadSource(sourceRepository, job.sourceId), { ...job, expectedSourcePolicyVersion: captured.expectedSourcePolicyVersion, expectedConnectorConfig: captured.expectedConnectorConfig })
    const normalized = (connectorResult?.candidates ?? []).map((candidate) => normalizeCandidateToArticle(candidate, { source: current, now: observedAt }))
    const last = normalized.at(-1)
    const checkpoint = {
      processedCount: (job.checkpoint?.processedCount ?? 0) + normalized.length,
      ...(connectorResult?.cursor !== undefined ? { cursor: String(connectorResult.cursor) } : {}),
      ...(last?.externalId ? { lastExternalId: last.externalId } : {}),
    }
    return articleRepository.commitIngestionBatch({
      job,
      fence,
      source: current,
      expectedSourcePolicyVersion: captured.expectedSourcePolicyVersion,
      expectedConnectorConfig: captured.expectedConnectorConfig,
      candidates: connectorResult?.candidates ?? [],
      articles: normalized,
      checkpoint,
      counters: { fetched: connectorResult?.candidates?.length ?? 0 },
      retrievedAt: observedAt,
    })
  }

  return Object.freeze({ captureSource, execute, ingest: execute, run: execute })
}

export { assertSourceForIngestion, stableJson }
