export function policyDraftForSource(source = {}) {
  const reviewed = ['permitted', 'metadata-only', 'blocked'].includes(source.licenseStatus)
  const mediaPolicy = source.mediaPolicy ?? {}
  return {
    licenseStatus: reviewed ? source.licenseStatus : 'metadata-only',
    llmInputScope: reviewed ? source.llmInputScope : 'metadata',
    attributionRequired: source.attributionRequired ?? true,
    attributionText: source.attributionText ?? '',
    termsUrl: source.termsUrl ?? '',
    licenseUrl: source.licenseUrl ?? '',
    evidenceNote: source.evidenceNote ?? '',
    storeMetadata: reviewed ? Boolean(source.storageScope?.metadata) : true,
    storeExcerpt: reviewed ? Boolean(source.storageScope?.excerpt) : false,
    storeSummary: reviewed ? Boolean(source.storageScope?.summary) : true,
    storeEmbedding: reviewed ? Boolean(source.storageScope?.embedding) : true,
    imageMode: mediaPolicy.imageMode ?? 'none',
    videoMode: mediaPolicy.videoMode ?? 'none',
    allowedHosts: Array.isArray(mediaPolicy.allowedHosts) ? mediaPolicy.allowedHosts.join(', ') : '',
    mediaAttributionRequired: Boolean(mediaPolicy.attributionRequired),
    mediaEvidenceNote: mediaPolicy.evidenceNote ?? '',
  }
}

function normalizeMediaHosts(value) {
  const values = Array.isArray(value) ? value : String(value ?? '').split(',')
  const hosts = values
    .map((host) => String(host).trim().toLowerCase().replace(/\.$/, ''))
    .filter((host) => {
      if (!host || host.length > 253 || /[:/@*\s]/.test(host) || !host.includes('.')) return false
      if (/^\d{1,3}(?:\.\d{1,3}){3}$/.test(host) || /\.(?:internal|local|localhost|localdomain|home|lan)$/.test(host)) return false
      return host.split('.').every((label) => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label))
    })
  return [...new Set(hosts)].slice(0, 20)
}

export function buildSourceCreateInput(form) {
  const batchSize = Number(form.batchSize)
  const base = { name: form.name.trim(), sourceKey: form.sourceKey.trim(), publisherName: form.publisherName.trim(), domain: form.domain.trim().toLowerCase(), connectorType: form.connectorType }
  if (form.connectorType === 'arxiv') return { ...base, accessMethod: 'api', authorityTier: 'primary', connectorConfig: { kind: 'arxiv', arxivQuery: form.endpoint.trim(), batchSize } }
  if (form.connectorType === 'hacker-news') return { ...base, accessMethod: 'api', authorityTier: 'community-signal', connectorConfig: { kind: 'hacker-news', hackerNewsStream: form.endpoint || 'topstories', batchSize } }
  return { ...base, accessMethod: form.accessMethod === 'atom' ? 'atom' : 'rss', authorityTier: 'editorial', connectorConfig: { kind: 'rss', feedUrl: form.endpoint.trim(), batchSize } }
}

export function buildPolicyReview(form) {
  const blocked = form.licenseStatus === 'blocked'
  const metadataOnly = form.licenseStatus === 'metadata-only'
  const llmInputScope = blocked ? 'none' : metadataOnly && !['none', 'metadata'].includes(form.llmInputScope) ? 'metadata' : form.llmInputScope
  const noInput = llmInputScope === 'none'
  return {
    licenseStatus: form.licenseStatus,
    llmInputScope,
    storageScope: {
      metadata: blocked ? false : metadataOnly ? true : Boolean(form.storeMetadata),
      excerpt: blocked || metadataOnly ? false : Boolean(form.storeExcerpt),
      summary: !noInput && Boolean(form.storeSummary),
      embedding: !noInput && Boolean(form.storeEmbedding),
    },
    mediaPolicy: {
      imageMode: blocked ? 'none' : form.imageMode,
      videoMode: blocked ? 'none' : form.videoMode,
      allowedHosts: blocked ? [] : normalizeMediaHosts(form.allowedHosts),
      attributionRequired: blocked ? false : Boolean(form.mediaAttributionRequired),
      evidenceNote: blocked ? null : String(form.mediaEvidenceNote ?? '').trim() || null,
    },
    attributionRequired: Boolean(form.attributionRequired),
    attributionText: form.attributionText.trim() || null,
    termsUrl: form.termsUrl.trim() || null,
    licenseUrl: form.licenseUrl.trim() || null,
    evidenceNote: form.evidenceNote.trim(),
    reasonCode: 'source_policy_reviewed',
  }
}

export function buildSourceConfigurationPatch(source, form) {
  const batchSize = Number(form.batchSize)
  let connectorConfig
  if (source.connectorType === 'arxiv') connectorConfig = { kind: 'arxiv', arxivQuery: form.endpoint.trim(), batchSize }
  else if (source.connectorType === 'hacker-news') connectorConfig = { kind: 'hacker-news', hackerNewsStream: form.endpoint, batchSize }
  else connectorConfig = { kind: 'rss', feedUrl: form.endpoint.trim(), batchSize }
  return { name: form.name.trim(), publisherName: form.publisherName.trim(), domain: form.domain.trim().toLowerCase(), connectorConfig, reasonCode: 'source_configuration_changed' }
}
