const ID = /^[a-z0-9][a-z0-9._-]{0,63}$/
const ENV_NAME = /^[A-Z][A-Z0-9_]{1,127}$/
const CAPABILITIES = new Set(['zdr-verified', 'nonconfidential'])
const ADAPTER_PROVIDERS = new Set(['openrouter', 'opencode-zen'])

function httpsUrl(value, label) {
  try {
    const parsed = new URL(value)
    if (parsed.protocol !== 'https:' || parsed.username || parsed.password) throw new Error()
    return parsed.toString()
  } catch { throw new Error(`${label} must be an exact HTTPS URL`) }
}

function dateValue(value, label) {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) throw new Error(`${label} is invalid`)
  return date
}

function freezeRecord(value) {
  for (const item of Object.values(value)) if (item && typeof item === 'object') Object.freeze(item)
  return Object.freeze(value)
}

export function validateProviderConfiguration(input, { now = new Date() } = {}) {
  if (!Array.isArray(input)) throw new Error('provider admission domains must be an array')
  if (!(now instanceof Date) || Number.isNaN(now.getTime())) throw new Error('provider configuration clock is invalid')
  const domainIds = new Set()
  const credentialDomains = new Map()
  const routeIds = new Set()
  const routeModels = new Set()
  const domains = []
  const routes = []

  for (const rawDomain of input) {
    if (!rawDomain || typeof rawDomain !== 'object' || !ID.test(rawDomain.admissionDomainId) || !ID.test(rawDomain.provider)) throw new Error('provider admission domain identity is invalid')
    if (!ADAPTER_PROVIDERS.has(rawDomain.provider)) throw new Error('provider adapter binding is unavailable')
    if (domainIds.has(rawDomain.admissionDomainId)) throw new Error('duplicate provider admission domain')
    domainIds.add(rawDomain.admissionDomainId)
    if (!ENV_NAME.test(rawDomain.credentialEnvName)) throw new Error('provider credential environment name is invalid')
    const previousDomain = credentialDomains.get(rawDomain.credentialEnvName)
    if (previousDomain && previousDomain !== rawDomain.admissionDomainId) throw new Error('provider credential split across admission domains')
    credentialDomains.set(rawDomain.credentialEnvName, rawDomain.admissionDomainId)
    if (!Number.isInteger(rawDomain.maxConcurrency) || rawDomain.maxConcurrency < 1 || rawDomain.maxConcurrency > 8) throw new Error('provider concurrency must be between one and eight')
    if (!Number.isFinite(rawDomain.budgetLimit) || rawDomain.budgetLimit <= 0) throw new Error('provider budget limit is invalid')
    if (!['hour', 'day', 'month'].includes(rawDomain.budgetWindow)) throw new Error('provider budget window is invalid')
    if (!Array.isArray(rawDomain.routes) || rawDomain.routes.length === 0) throw new Error('provider admission domain needs routes')
    domains.push(freezeRecord({
      admissionDomainId: rawDomain.admissionDomainId,
      provider: rawDomain.provider,
      credentialEnvName: rawDomain.credentialEnvName,
      maxConcurrency: rawDomain.maxConcurrency,
      budgetLimit: rawDomain.budgetLimit,
      budgetWindow: rawDomain.budgetWindow,
    }))

    for (const rawRoute of rawDomain.routes) {
      if (!rawRoute || !ID.test(rawRoute.routeId) || rawRoute.admissionDomainId !== rawDomain.admissionDomainId) throw new Error('provider route identity is invalid')
      if (routeIds.has(rawRoute.routeId)) throw new Error('duplicate provider route')
      routeIds.add(rawRoute.routeId)
      if (typeof rawRoute.model !== 'string' || rawRoute.model.trim() === '') throw new Error('provider route model is required')
      const routeModel = `${rawDomain.provider}:${rawRoute.model.trim()}`
      if (routeModels.has(routeModel)) throw new Error('provider route model is duplicated')
      routeModels.add(routeModel)
      if (!CAPABILITIES.has(rawRoute.capability)) throw new Error('provider route capability is invalid')
      if (typeof rawRoute.enabled !== 'boolean') throw new Error('provider route enabled flag is required')
      const reviewedAt = dateValue(rawRoute.reviewedAt, 'provider evidence review')
      const evidenceExpiresAt = dateValue(rawRoute.evidenceExpiresAt, 'provider evidence expiry')
      if (reviewedAt > now || evidenceExpiresAt <= now || evidenceExpiresAt <= reviewedAt) throw new Error('provider evidence is expired or invalid')
      if (rawRoute.retryableFailureThreshold !== 3) throw new Error('provider circuit threshold must be three')
      if (rawRoute.cooldownSeconds !== 60) throw new Error('provider circuit cooldown must be sixty seconds')
      routes.push(freezeRecord({
        routeId: rawRoute.routeId,
        admissionDomainId: rawRoute.admissionDomainId,
        provider: rawDomain.provider,
        model: rawRoute.model.trim(),
        capability: rawRoute.capability,
        evidenceUrl: httpsUrl(rawRoute.evidenceUrl, 'provider evidence URL'),
        reviewedAt: reviewedAt.toISOString(),
        evidenceExpiresAt: evidenceExpiresAt.toISOString(),
        enabled: rawRoute.enabled,
        retryableFailureThreshold: 3,
        cooldownSeconds: 60,
      }))
    }
  }
  return Object.freeze({ domains: Object.freeze(domains), routes: Object.freeze(routes) })
}
