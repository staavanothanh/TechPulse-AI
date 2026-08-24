export function safeExternalUrl(value) {
  if (typeof value !== 'string' || value.length > 2048) return null
  try {
    const url = new URL(value)
    return url.protocol === 'https:' && !url.username && !url.password ? url.toString() : null
  } catch {
    return null
  }
}

function exactReviewedHostname(value) {
  if (typeof value !== 'string') return null
  const host = value.trim().toLowerCase().replace(/\.$/, '')
  if (!host || /[:/@*\s]/.test(host) || !host.includes('.')) return null
  if (/^\d{1,3}(?:\.\d{1,3}){3}$/.test(host) || /\.(?:internal|local|localhost|localdomain|home|lan)$/.test(host)) return null
  if (host.length > 253 || host.split('.').some((label) => !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label))) return null
  return host
}

export function safeMediaUrl(value, allowedHosts) {
  const safeUrl = safeExternalUrl(value)
  if (!safeUrl) return null
  // Public LeadMedia is already rechecked by the server and guarded by CSP.
  // Apply an exact host check when a caller has a reviewed snapshot, but do
  // not add that internal policy field to the public DTO.
  if (allowedHosts === undefined) return safeUrl
  if (!Array.isArray(allowedHosts) || allowedHosts.length === 0) return null
  const host = exactReviewedHostname(new URL(safeUrl).hostname)
  const reviewedHosts = new Set(allowedHosts.map(exactReviewedHostname).filter(Boolean))
  return host && reviewedHosts.has(host) ? safeUrl : null
}

export const safeHttpsUrl = safeExternalUrl
