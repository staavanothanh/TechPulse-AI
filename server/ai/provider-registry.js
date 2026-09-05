import { INSTALLED_PROVIDER_ADAPTERS } from './provider-adapters.js'
import { TRUSTED_PROVIDER_ENDPOINT_PROFILES } from './provider-endpoint-profiles.js'

const ID = /^[a-z0-9][a-z0-9._-]{0,63}$/
const ENV_NAME = /^[A-Z][A-Z0-9_]{1,127}$/
const OPERATIONS = new Set(['summary', 'answer', 'support', 'embedding'])
const CAPABILITIES = new Set(['zdr-verified', 'nonconfidential'])
const BUDGET_WINDOWS = new Set(['hour', 'day', 'month'])
const QA_INTENT_WORKLOAD_ID = 'qa-intent'

function fail(message) {
  throw new Error(`Provider configuration ${message}`)
}

function exactObject(value, keys, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(`${label} must be an object`)
  const unexpected = Object.keys(value).find((key) => !keys.includes(key))
  if (unexpected) fail(`${label} contains unsupported field ${unexpected}`)
}

function safeId(value, label) {
  if (typeof value !== 'string' || !ID.test(value)) fail(`${label} is invalid`)
  return value
}

function uniqueMap(items, idKey, label) {
  if (!Array.isArray(items)) fail(`${label} must be an array`)
  const result = new Map()
  for (const item of items) {
    const id = safeId(item?.[idKey], `${label} identity`)
    if (result.has(id)) fail(`has duplicate ${label} ${id}`)
    result.set(id, item)
  }
  return result
}

function dateValue(value, label) {
  const result = new Date(value)
  if (Number.isNaN(result.getTime())) fail(`${label} is invalid`)
  return result
}

function exactHttpsUrl(value, label) {
  try {
    const parsed = new URL(value)
    if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.search || parsed.hash || parsed.toString() !== value) throw new Error()
    return value
  } catch {
    fail(`${label} must be an exact HTTPS origin and path without credentials`)
  }
}

function freeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value
  for (const item of Object.values(value)) freeze(item)
  return Object.freeze(value)
}

function validateAdapterCatalog(installedAdapters) {
  const adapters = uniqueMap(installedAdapters, 'adapterId', 'adapter')
  const normalized = []
  for (const adapter of adapters.values()) {
    exactObject(adapter, ['adapterId', 'protocol', 'supportedOperations'], 'adapter')
    if (typeof adapter.protocol !== 'string' || adapter.protocol.trim() === '') fail('adapter protocol is required')
    if (!Array.isArray(adapter.supportedOperations) || adapter.supportedOperations.length === 0 || new Set(adapter.supportedOperations).size !== adapter.supportedOperations.length || adapter.supportedOperations.some((operation) => !OPERATIONS.has(operation))) fail('adapter supported operations are invalid')
    normalized.push({ adapterId: adapter.adapterId, protocol: adapter.protocol, supportedOperations: [...adapter.supportedOperations] })
  }
  return { adapters, normalized }
}

function validateEndpointProfiles(trustedEndpointProfiles, adapters) {
  const profiles = uniqueMap(trustedEndpointProfiles, 'trustedEndpointProfileId', 'trusted endpoint profile')
  const normalized = []
  for (const profile of profiles.values()) {
    exactObject(profile, ['trustedEndpointProfileId', 'adapterId', 'operationEndpoints', 'allowRedirects', 'classifyHttpFailure'], 'trusted endpoint profile')
    const adapter = adapters.get(safeId(profile.adapterId, 'trusted endpoint profile adapter'))
    if (!adapter) fail('trusted endpoint profile has a dangling adapter reference')
    if (profile.allowRedirects !== false) fail('trusted endpoint profile must reject redirects')
    if (profile.classifyHttpFailure !== undefined && typeof profile.classifyHttpFailure !== 'function') fail('trusted endpoint profile HTTP classifier is invalid')
    exactObject(profile.operationEndpoints, [...OPERATIONS], 'trusted endpoint profile operations')
    const entries = Object.entries(profile.operationEndpoints)
    if (entries.length === 0) fail('trusted endpoint profile needs an operation endpoint')
    const supported = new Set(adapter.supportedOperations)
    const endpoints = {}
    for (const [operation, endpoint] of entries) {
      if (!OPERATIONS.has(operation) || !supported.has(operation)) fail('trusted endpoint profile uses an unsupported operation')
      endpoints[operation] = exactHttpsUrl(endpoint, 'trusted endpoint profile URL')
    }
    normalized.push({ trustedEndpointProfileId: profile.trustedEndpointProfileId, adapterId: profile.adapterId, operationEndpoints: endpoints, allowRedirects: false, ...(profile.classifyHttpFailure ? { classifyHttpFailure: profile.classifyHttpFailure } : {}) })
  }
  return { profiles, normalized }
}

function emptyGraph() {
  const admissionDomains = []
  return freeze({ installedAdapters: [], endpointProfiles: [], providerFailureDomains: [], providers: [], admissionDomains, domains: admissionDomains, routes: [], workloadPolicies: [] })
}

function capabilityAllows(actual, required) {
  return actual === 'zdr-verified' || actual === required
}

function normalizeCredentialReferences(value) {
  if (value === undefined) return null
  if (value instanceof Set) return value
  if (Array.isArray(value) && value.every((item) => typeof item === 'string')) return new Set(value)
  fail('credential environment references are invalid')
}

export function validateProviderConfiguration(input, {
  now = new Date(),
  installedAdapters = INSTALLED_PROVIDER_ADAPTERS,
  trustedEndpointProfiles = TRUSTED_PROVIDER_ENDPOINT_PROFILES,
  credentialEnvNames,
} = {}) {
  if (!(now instanceof Date) || Number.isNaN(now.getTime())) fail('clock is invalid')
  if (Array.isArray(input)) {
    if (input.length === 0) return emptyGraph()
    fail('legacy admission-domain arrays are unsupported; use the ADR-0013 graph')
  }
  exactObject(input, ['providerFailureDomains', 'providers', 'admissionDomains', 'routes', 'workloadPolicies'], 'graph')
  const availableCredentials = normalizeCredentialReferences(credentialEnvNames)
  const adapterCatalog = validateAdapterCatalog(installedAdapters)
  const endpointCatalog = validateEndpointProfiles(trustedEndpointProfiles, adapterCatalog.adapters)

  const rawFailureDomains = uniqueMap(input.providerFailureDomains, 'providerFailureDomainId', 'provider failure domain')
  const failureDomains = []
  for (const domain of rawFailureDomains.values()) {
    exactObject(domain, ['providerFailureDomainId', 'configVersion', 'failureThreshold', 'cooldownSeconds'], 'provider failure domain')
    if (!Number.isSafeInteger(domain.configVersion) || domain.configVersion < 1) fail('provider failure domain configVersion is invalid')
    if (domain.failureThreshold !== 3) fail('provider failure domain threshold must be three')
    if (domain.cooldownSeconds !== 60) fail('provider failure domain cooldown must be sixty seconds')
    failureDomains.push({ ...domain })
  }

  const rawProviders = uniqueMap(input.providers, 'providerId', 'provider')
  const providers = []
  for (const provider of rawProviders.values()) {
    exactObject(provider, ['providerId', 'providerFailureDomainId', 'adapterId', 'trustedEndpointProfileId'], 'provider')
    if (!rawFailureDomains.has(safeId(provider.providerFailureDomainId, 'provider failure domain reference'))) fail('provider has a dangling failure domain reference')
    const adapter = adapterCatalog.adapters.get(safeId(provider.adapterId, 'provider adapter reference'))
    if (!adapter) fail('provider has a dangling installed adapter reference')
    const profile = endpointCatalog.profiles.get(safeId(provider.trustedEndpointProfileId, 'provider endpoint profile reference'))
    if (!profile) fail('provider has a dangling trusted endpoint profile reference')
    if (profile.adapterId !== provider.adapterId) fail('provider adapter and endpoint profile mismatch')
    providers.push({ ...provider })
  }

  const rawAdmissionDomains = uniqueMap(input.admissionDomains, 'admissionDomainId', 'admission domain')
  const credentials = new Map()
  const admissionDomains = []
  for (const domain of rawAdmissionDomains.values()) {
    exactObject(domain, ['admissionDomainId', 'providerId', 'credentialEnvName', 'maxConcurrency', 'budgetLimit', 'budgetWindow'], 'admission domain')
    const providerId = safeId(domain.providerId, 'admission domain provider reference')
    if (!rawProviders.has(providerId)) fail('admission domain has a dangling provider reference')
    if (typeof domain.credentialEnvName !== 'string' || !ENV_NAME.test(domain.credentialEnvName)) fail('admission domain credential must be an environment variable name')
    if (availableCredentials && !availableCredentials.has(domain.credentialEnvName)) fail('admission domain credential environment reference is missing')
    const previous = credentials.get(domain.credentialEnvName)
    if (previous && previous !== domain.admissionDomainId) fail('credential is split across admission domains')
    credentials.set(domain.credentialEnvName, domain.admissionDomainId)
    if (!Number.isInteger(domain.maxConcurrency) || domain.maxConcurrency < 1 || domain.maxConcurrency > 8) fail('admission domain concurrency must be between one and eight')
    if (!Number.isFinite(domain.budgetLimit) || domain.budgetLimit <= 0) fail('admission domain budget limit is invalid')
    if (!BUDGET_WINDOWS.has(domain.budgetWindow)) fail('admission domain budget window is invalid')
    admissionDomains.push({ ...domain, provider: providerId })
  }

  const rawRoutes = uniqueMap(input.routes, 'routeId', 'route')
  const routes = []
  for (const route of rawRoutes.values()) {
    exactObject(route, ['routeId', 'providerId', 'admissionDomainId', 'model', 'operations', 'capability', 'evidenceUrl', 'reviewedAt', 'evidenceExpiresAt', 'artifactCompatibilityId', 'embeddingDimensions', 'embeddingVersion', 'enabled', 'routeFailureThreshold', 'routeCooldownSeconds'], 'route')
    const provider = rawProviders.get(safeId(route.providerId, 'route provider reference'))
    const admission = rawAdmissionDomains.get(safeId(route.admissionDomainId, 'route admission domain reference'))
    if (!provider || !admission) fail('route has a dangling provider or admission domain reference')
    if (admission.providerId !== route.providerId) fail('route provider and admission domain provider mismatch')
    if (typeof route.model !== 'string' || route.model.trim() === '' || route.model.length > 200) fail('route model is invalid')
    if (!Array.isArray(route.operations) || route.operations.length === 0 || new Set(route.operations).size !== route.operations.length || route.operations.some((operation) => !OPERATIONS.has(operation))) fail('route operations are invalid')
    const adapter = adapterCatalog.adapters.get(provider.adapterId)
    const profile = endpointCatalog.profiles.get(provider.trustedEndpointProfileId)
    const adapterOperations = new Set(adapter.supportedOperations)
    if (route.operations.some((operation) => !adapterOperations.has(operation) || !Object.hasOwn(profile.operationEndpoints, operation))) fail('route uses an unsupported operation')
    if (!CAPABILITIES.has(route.capability)) fail('route capability is invalid')
    const reviewedAt = dateValue(route.reviewedAt, 'route evidence review')
    const evidenceExpiresAt = dateValue(route.evidenceExpiresAt, 'route evidence expiry')
    if (reviewedAt > now || evidenceExpiresAt <= now || evidenceExpiresAt <= reviewedAt) fail('route evidence is expired or invalid')
    if (typeof route.enabled !== 'boolean') fail('route enabled flag is required')
    if (route.routeFailureThreshold !== 3) fail('route failure threshold must be three')
    if (route.routeCooldownSeconds !== 60) fail('route cooldown must be sixty seconds')
    if (route.artifactCompatibilityId !== null && route.artifactCompatibilityId !== undefined && !ID.test(route.artifactCompatibilityId)) fail('route artifactCompatibilityId is invalid')
    if (route.operations.includes('embedding')) {
      if (!route.artifactCompatibilityId) fail('embedding route artifactCompatibilityId is required')
      if (!Number.isInteger(route.embeddingDimensions) || route.embeddingDimensions < 1 || route.embeddingDimensions > 4096) fail('embedding route dimensions are invalid')
      if (!Number.isInteger(route.embeddingVersion) || route.embeddingVersion < 1) fail('embedding route version is invalid')
    } else if (route.embeddingDimensions !== undefined || route.embeddingVersion !== undefined) fail('non-embedding route cannot declare embedding metadata')
    routes.push({
      ...route,
      model: route.model.trim(),
      providerFailureDomainId: provider.providerFailureDomainId,
      adapterId: provider.adapterId,
      trustedEndpointProfileId: provider.trustedEndpointProfileId,
      provider: route.providerId,
      evidenceUrl: exactHttpsUrl(route.evidenceUrl, 'route evidence URL'),
      reviewedAt: reviewedAt.toISOString(),
      evidenceExpiresAt: evidenceExpiresAt.toISOString(),
      retryableFailureThreshold: route.routeFailureThreshold,
      cooldownSeconds: route.routeCooldownSeconds,
    })
  }

  const normalizedRoutes = new Map(routes.map((route) => [route.routeId, route]))
  const rawWorkloads = uniqueMap(input.workloadPolicies, 'workloadId', 'workload policy')
  const workloadPolicies = []
  for (const policy of rawWorkloads.values()) {
    exactObject(policy, ['workloadId', 'operation', 'requiredCapability', 'maxExternalAttempts', 'primaryRouteId', 'modelFallbackRouteIds', 'providerFallbackRouteIds'], 'workload policy')
    const isQaIntent = policy.workloadId === QA_INTENT_WORKLOAD_ID
    if (!OPERATIONS.has(policy.operation)) fail('workload policy operation is invalid')
    if (!CAPABILITIES.has(policy.requiredCapability)) fail('workload policy capability is invalid')
    if (!Number.isInteger(policy.maxExternalAttempts) || policy.maxExternalAttempts < 1 || policy.maxExternalAttempts > 2) fail('workload policy maxExternalAttempts is invalid')
    if (!Array.isArray(policy.modelFallbackRouteIds) || !Array.isArray(policy.providerFallbackRouteIds)) fail('workload policy fallback routes must be arrays')
    if (isQaIntent && (policy.operation !== 'summary' || policy.maxExternalAttempts !== 1 || policy.modelFallbackRouteIds.length !== 0 || policy.providerFallbackRouteIds.length !== 0)) fail('qa-intent workload policy must use one summary attempt without fallbacks')
    if (!isQaIntent && ['summary', 'answer'].includes(policy.operation) && policy.maxExternalAttempts !== 2) fail('summary and Q&A maxExternalAttempts must be two')
    const routeIds = [policy.primaryRouteId, ...policy.modelFallbackRouteIds, ...policy.providerFallbackRouteIds]
    if (routeIds.some((routeId) => typeof routeId !== 'string' || !ID.test(routeId))) fail('workload policy route reference is invalid')
    if (new Set(routeIds).size !== routeIds.length) fail('workload policy fallback graph contains a duplicate or cycle')
    const candidates = routeIds.map((routeId) => normalizedRoutes.get(routeId))
    if (candidates.some((route) => !route)) fail('workload policy has a dangling route reference')
    const primary = candidates[0]
    if (!primary.enabled || !primary.operations.includes(policy.operation)) fail('workload primary route does not support its operation')
    for (const candidate of candidates) {
      if (!candidate.enabled || !candidate.operations.includes(policy.operation)) fail('workload fallback route does not support its operation')
      if (!capabilityAllows(candidate.capability, policy.requiredCapability)) fail('workload fallback causes a capability downgrade')
    }
    for (const routeId of policy.modelFallbackRouteIds) {
      const fallback = normalizedRoutes.get(routeId)
      if (fallback.providerFailureDomainId !== primary.providerFailureDomainId || fallback.model === primary.model) fail('model fallback must use another model in the same provider failure domain')
    }
    for (const routeId of policy.providerFallbackRouteIds) {
      if (normalizedRoutes.get(routeId).providerFailureDomainId === primary.providerFailureDomainId) fail('provider fallback must use another provider failure domain')
    }
    if (policy.operation === 'embedding' && candidates.some((candidate) =>
      candidate.artifactCompatibilityId !== primary.artifactCompatibilityId ||
      candidate.embeddingDimensions !== primary.embeddingDimensions ||
      candidate.embeddingVersion !== primary.embeddingVersion)) fail('embedding fallback compatibility mismatch')
    workloadPolicies.push({ ...policy, modelFallbackRouteIds: [...policy.modelFallbackRouteIds], providerFallbackRouteIds: [...policy.providerFallbackRouteIds] })
  }

  const usedProfileIds = new Set(providers.map((provider) => provider.trustedEndpointProfileId))
  const usedAdapterIds = new Set(providers.map((provider) => provider.adapterId))
  const endpointProfiles = endpointCatalog.normalized.filter((profile) => usedProfileIds.has(profile.trustedEndpointProfileId))
  const normalizedAdapters = adapterCatalog.normalized.filter((adapter) => usedAdapterIds.has(adapter.adapterId))
  return freeze({ installedAdapters: normalizedAdapters, endpointProfiles, providerFailureDomains: failureDomains, providers, admissionDomains, domains: admissionDomains, routes, workloadPolicies })
}
