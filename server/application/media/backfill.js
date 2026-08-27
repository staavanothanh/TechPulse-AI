import { validateConnectorUnit, validatePolicyCompatibility } from '../../domain/source/validation.js'

function boundedLimit(value) {
  const limit = value === undefined ? 100 : Number(value)
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error('Media backfill limit is invalid')
  return limit
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`
  return JSON.stringify(value)
}

function sourceIdentifier(source) {
  const value = source?.id ?? source?._id ?? source?.sourceId
  if (value === undefined || value === null || String(value).trim() === '') return null
  return String(value)
}

function mediaPolicyEnabled(source) {
  const policy = source?.mediaPolicy
  return Boolean(policy && Array.isArray(policy.allowedHosts) && policy.allowedHosts.length > 0 && (policy.imageMode === 'remote-preview' || policy.videoMode === 'link-only'))
}

function sourceEligibleForMediaBackfill(source) {
  if (source?.operationalStatus !== 'active' || !['permitted', 'metadata-only'].includes(source?.licenseStatus) || source?.technicalCheck?.status !== 'passed' || source?.connectorType !== 'rss') return false
  try {
    validateConnectorUnit(source)
    validatePolicyCompatibility(source)
    return true
  } catch {
    return false
  }
}

function currentSourceMatches(captured, current) {
  return sourceIdentifier(captured) === sourceIdentifier(current)
    && captured?.sourceKey === current?.sourceKey
    && captured?.connectorType === 'rss'
    && current?.connectorType === 'rss'
    && captured?.policyVersion === current?.policyVersion
    && stableJson(captured?.connectorConfig) === stableJson(current?.connectorConfig)
}

function skippedReport(reason, { fetched = 0 } = {}) {
  return Object.freeze({
    outcome: 'skipped',
    fetched,
    inspected: 0,
    updated: 0,
    wouldUpdate: 0,
    skipped: 1,
    failed: 0,
    skippedReasons: { [reason]: 1 },
    failedReasons: {},
  })
}

function failedReport(reason) {
  return Object.freeze({
    outcome: 'failed',
    fetched: 0,
    inspected: 0,
    updated: 0,
    wouldUpdate: 0,
    skipped: 0,
    failed: 1,
    skippedReasons: {},
    failedReasons: { [reason]: 1 },
  })
}

function safeFailureReason(error) {
  return typeof error?.code === 'string' && /^[a-z0-9_:-]{1,128}$/i.test(error.code)
    ? error.code.toLowerCase()
    : 'media_backfill_failed'
}

export function createMediaBackfillWorker({ connectorRegistry, sourceRepository, articleRepository, now = () => new Date() } = {}) {
  if (!connectorRegistry || typeof connectorRegistry.resolve !== 'function') throw new Error('Connector registry is required')
  if (!sourceRepository || typeof sourceRepository.findSourceByKey !== 'function' || typeof sourceRepository.findSourceById !== 'function') throw new Error('Source repository is required')
  if (!articleRepository || typeof articleRepository.backfillLeadMediaCandidates !== 'function') throw new Error('Article repository is required')

  return Object.freeze({
    async run({ sourceKey, dryRun = true, limit } = {}) {
      if (typeof sourceKey !== 'string' || !/^[a-z0-9][a-z0-9:-]{2,119}$/.test(sourceKey)) throw new Error('Media backfill source key is invalid')
      if (typeof dryRun !== 'boolean') throw new Error('Media backfill dry-run flag is invalid')
      const bounded = boundedLimit(limit)
      const captured = await sourceRepository.findSourceByKey(sourceKey)
      if (!captured || sourceIdentifier(captured) === null || captured.connectorType !== 'rss') return skippedReport('source_not_eligible')
      if (!mediaPolicyEnabled(captured)) return skippedReport('media_policy_disabled')
      if (!sourceEligibleForMediaBackfill(captured)) return skippedReport('source_not_eligible')
      const connector = connectorRegistry.resolve(captured)
      const retrievedAt = now()
      if (!(retrievedAt instanceof Date) || Number.isNaN(retrievedAt.getTime())) throw new Error('Media backfill clock is invalid')
      let result
      try {
        result = await connector.run({ source: captured, retrievedAt })
      } catch (error) {
        return failedReport(safeFailureReason(error))
      }
      const candidates = Array.isArray(result?.candidates) ? result.candidates : []
      const current = await sourceRepository.findSourceById(sourceIdentifier(captured))
      if (!currentSourceMatches(captured, current) || !mediaPolicyEnabled(current) || !sourceEligibleForMediaBackfill(current)) return skippedReport('source_policy_changed', { fetched: candidates.length })
      const report = await articleRepository.backfillLeadMediaCandidates({
        source: current,
        expectedSourcePolicyVersion: captured.policyVersion,
        expectedConnectorConfig: captured.connectorConfig,
        candidates: candidates.slice(0, bounded),
        dryRun,
        limit: bounded,
      })
      return Object.freeze({
        outcome: 'completed',
        fetched: candidates.length,
        inspected: report?.inspected ?? 0,
        updated: report?.updated ?? 0,
        wouldUpdate: report?.wouldUpdate ?? 0,
        skipped: report?.skipped ?? 0,
        failed: report?.failed ?? 0,
        skippedReasons: report?.skippedReasons ?? {},
        failedReasons: report?.failedReasons ?? {},
      })
    },
  })
}
