import { normalizeReviewedHostname, validateHttpsUrl, validatePolicyCompatibility } from '../source/validation.js'

function reject(source, code) {
  return { allowed: false, code, policyVersion: source?.policyVersion ?? null }
}

export function evaluateMediaPolicy(source, candidate) {
  if (!source) return reject(source, 'source_policy_blocked')
  try {
    if (!Number.isInteger(source.policyVersion) || source.policyVersion < 1) throw new Error('invalid policy version')
    validatePolicyCompatibility(source)
  } catch { return reject(source, 'source_policy_invalid') }
  if (source.operationalStatus !== 'active' || !['permitted', 'metadata-only'].includes(source.licenseStatus)) return reject(source, 'source_policy_blocked')
  if (!candidate || !['image', 'video'].includes(candidate.type)) return reject(source, 'media_type_invalid')
  if (candidate.altText !== undefined && (typeof candidate.altText !== 'string' || candidate.altText.length > 500) || candidate.credit !== undefined && (typeof candidate.credit !== 'string' || candidate.credit.length > 500)) return reject(source, 'media_metadata_invalid')
  let parsedUrl
  let sourcePageUrl
  try {
    if (typeof candidate.url !== 'string' || candidate.url.length > 2048) throw new Error('invalid media URL')
    if (typeof candidate.sourcePageUrl !== 'string' || !candidate.sourcePageUrl.trim()) throw new Error('invalid source page URL')
    parsedUrl = new URL(candidate.url)
    if (parsedUrl.protocol !== 'https:' || parsedUrl.username || parsedUrl.password) throw new Error('invalid media URL')
    sourcePageUrl = validateHttpsUrl(candidate.sourcePageUrl, 'source page URL')
  } catch {
    return reject(source, 'media_url_invalid')
  }
  let host
  try {
    host = normalizeReviewedHostname(parsedUrl.hostname)
  } catch {
    return reject(source, 'media_host_denied')
  }
  if (!source.mediaPolicy?.allowedHosts?.includes(host)) return reject(source, 'media_host_denied')
  const displayMode = candidate.type === 'image' ? source.mediaPolicy.imageMode : source.mediaPolicy.videoMode
  if (displayMode === 'none' || candidate.type === 'image' && displayMode !== 'remote-preview' || candidate.type === 'video' && displayMode !== 'link-only') return reject(source, 'media_mode_denied')
  const attribution = [candidate.credit, source.attributionText, source.name].find((value) => typeof value === 'string' && value.trim())?.trim()
  if (!attribution) return reject(source, 'media_attribution_missing')
  return {
    allowed: true,
    type: candidate.type,
    displayMode,
    url: parsedUrl.toString(),
    sourcePageUrl,
    host,
    altText: candidate.altText?.trim() || undefined,
    credit: candidate.credit?.trim() || undefined,
    attribution,
    mediaEvidenceStatus: 'not-analyzed',
    policyVersion: source.policyVersion,
  }
}
