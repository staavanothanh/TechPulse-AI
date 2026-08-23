import { classifyProviderError, providerFailure, ProviderAdapterError } from './provider-error-taxonomy.js'

const FALLBACKS = new Set(['none', 'model', 'provider'])
const OPERATIONS = new Set(['summary', 'answer', 'support', 'embedding'])
const CAPABILITIES = new Set(['zdr-verified', 'nonconfidential'])

function immutableCopy(value) {
  let copy
  try { copy = structuredClone(value) } catch { throw new ProviderAdapterError('config') }
  const freeze = (item) => {
    if (!item || typeof item !== 'object' || Object.isFrozen(item)) return item
    for (const nested of Object.values(item)) freeze(nested)
    return Object.freeze(item)
  }
  return freeze(copy)
}

function capabilityAllows(actual, required) {
  return actual === required || actual === 'zdr-verified' && required === 'nonconfidential'
}

function operationKind(operation, fallback) {
  if (operation === 'answer') return fallback === 'none' ? 'answer-primary' : 'answer-fallback'
  if (operation === 'support' || operation === 'verify-support' || operation === 'verifySupport') return 'answer-support'
  if (operation === 'embed' || operation === 'embedding') return 'embedding'
  return 'summary'
}

function routeMetadata({ policy, route, externalAttempts, fallback }) {
  if (!FALLBACKS.has(fallback)) throw new Error('Provider fallback metadata is invalid')
  return Object.freeze({
    workloadId: policy.workloadId,
    operation: policy.operation,
    routeId: route.routeId,
    providerId: route.providerId,
    providerFailureDomainId: route.providerFailureDomainId,
    model: route.model,
    externalAttempts,
    fallback,
  })
}

export class ProviderRoutingError extends Error {
  constructor(classification, { metadata, retryAfterSeconds, upstreamStatus } = {}) {
    super('AI provider operation could not complete safely')
    this.name = 'ProviderRoutingError'
    this.code = classification.code
    this.failureClass = classification.failureClass
    this.retryable = classification.retryable === true
    if (metadata) this.metadata = metadata
    if (Number.isInteger(upstreamStatus) && upstreamStatus >= 400 && upstreamStatus <= 599) this.upstreamStatus = upstreamStatus
    if (this.failureClass !== 'ambiguous' && Number.isInteger(retryAfterSeconds) && retryAfterSeconds > 0) this.retryAfterSeconds = retryAfterSeconds
  }
}

function routingError(error, context = {}) {
  const classification = error instanceof ProviderRoutingError
    ? { failureClass: error.failureClass, code: error.code, retryable: error.retryable }
    : classifyProviderError(error)
  return error instanceof ProviderRoutingError ? error : new ProviderRoutingError(classification, {
    metadata: context.metadata,
    retryAfterSeconds: classification.retryAfterSeconds,
    upstreamStatus: classification.upstreamStatus,
  })
}

function configError(context) {
  return new ProviderRoutingError(providerFailure('config'), context)
}

function privacyError(context) {
  return new ProviderRoutingError(providerFailure('privacy'), context)
}

function assertPolicy(policy) {
  if (!policy || typeof policy.workloadId !== 'string' || !OPERATIONS.has(policy.operation) || !CAPABILITIES.has(policy.requiredCapability)
    || !Number.isInteger(policy.maxExternalAttempts) || policy.maxExternalAttempts < 1 || policy.maxExternalAttempts > 2
    || typeof policy.primaryRouteId !== 'string' || !Array.isArray(policy.modelFallbackRouteIds) || !Array.isArray(policy.providerFallbackRouteIds)) throw configError()
}

function assertCandidate(route, { policy, primaryRoute, fallback, now }) {
  if (!route || typeof route !== 'object' || route.enabled !== true || !Array.isArray(route.operations) || !route.operations.includes(policy.operation)) throw configError()
  const expiry = new Date(route.evidenceExpiresAt)
  if (Number.isNaN(expiry.getTime()) || expiry <= now()) throw configError()
  if (!capabilityAllows(route.capability, policy.requiredCapability)) throw privacyError()
  if (fallback === 'model' && (route.providerFailureDomainId !== primaryRoute.providerFailureDomainId || route.model === primaryRoute.model)) throw configError()
  if (fallback === 'provider' && route.providerFailureDomainId === primaryRoute.providerFailureDomainId) throw configError()
  if ((policy.operation === 'embed' || policy.operation === 'embedding') && fallback !== 'none'
    && (route.artifactCompatibilityId !== primaryRoute.artifactCompatibilityId
      || route.embeddingDimensions !== primaryRoute.embeddingDimensions
      || route.embeddingVersion !== primaryRoute.embeddingVersion)) throw configError()
}

function candidateIds(policy, fallback) {
  if (fallback === 'model') return policy.modelFallbackRouteIds
  if (fallback === 'provider') return policy.providerFallbackRouteIds
  return [policy.primaryRouteId]
}

function reportOutcome(classification) {
  if (classification.failureClass === 'model-retryable') return 'model-retryable-failure'
  if (classification.failureClass === 'provider-retryable') return 'provider-retryable-failure'
  return 'terminal-failure'
}

export function createProviderRouter({ workloadPolicies, admission, now = () => new Date() } = {}) {
  if (!Array.isArray(workloadPolicies) || typeof now !== 'function' || !admission
    || typeof admission.getRoute !== 'function' || typeof admission.admitProviderDomain !== 'function'
    || typeof admission.reportProviderDomain !== 'function' || typeof admission.run !== 'function') throw new Error('Provider router configuration is invalid')
  const policies = new Map()
  for (const policy of workloadPolicies) {
    assertPolicy(policy)
    if (policies.has(policy.workloadId)) throw new Error('Provider workload policy is duplicated')
    policies.set(policy.workloadId, policy)
  }

  return Object.freeze({
    async execute({ workloadId, admittedInput, attemptId, units = 1, invoke, validateOutput } = {}) {
      const policy = policies.get(workloadId)
      if (!policy || typeof attemptId !== 'string' || attemptId.length < 1 || typeof invoke !== 'function' || typeof validateOutput !== 'function' || !Number.isFinite(units) || units <= 0) throw configError()
      const input = immutableCopy(admittedInput)
      const primaryRoute = admission.getRoute(policy.primaryRouteId)
      assertCandidate(primaryRoute, { policy, primaryRoute, fallback: 'none', now })
      let fallback = 'none'
      let externalAttempts = 0
      let lastError

      while (externalAttempts < policy.maxExternalAttempts) {
        const routeId = candidateIds(policy, fallback)[0]
        const route = admission.getRoute(routeId)
        assertCandidate(route, { policy, primaryRoute, fallback, now })
        let domainAdmission
        try {
          domainAdmission = await admission.admitProviderDomain({ routeId, attemptId })
        } catch {
          throw configError()
        }
        if (!domainAdmission?.allowed) {
          const unavailable = new ProviderAdapterError('provider-retryable', { retryAfterSeconds: domainAdmission?.retryAfterSeconds })
          if (fallback === 'none' && policy.providerFallbackRouteIds.length > 0) {
            fallback = 'provider'
            lastError = unavailable
            continue
          }
          throw routingError(unavailable)
        }

        let output
        let completed = false
        try {
          output = await admission.run({
            routeId,
            capability: policy.requiredCapability,
            attemptId,
            kind: operationKind(policy.operation, fallback),
            units,
            invoke: async (admittedRoute) => {
              externalAttempts += 1
              const rawOutput = await invoke({ route: admittedRoute, admittedInput: input })
              return validateOutput({ route: admittedRoute, output: rawOutput, admittedInput: input })
            },
          })
          completed = true
        } catch (error) {
          const classification = classifyProviderError(error)
          try {
            await admission.reportProviderDomain({
              routeId,
              reservationId: domainAdmission.reservationId,
              outcome: error?.providerDomainOutcome ?? reportOutcome(classification),
              errorCode: classification.code,
            })
          } catch {
            throw routingError(new ProviderAdapterError('ambiguous'))
          }
          lastError = error
          if (externalAttempts >= policy.maxExternalAttempts) break
          if (fallback !== 'none') break
          if (classification.failureClass === 'model-retryable' && policy.modelFallbackRouteIds.length > 0) fallback = 'model'
          else if (classification.failureClass === 'provider-retryable' && policy.providerFallbackRouteIds.length > 0) fallback = 'provider'
          else break
        }
        if (!completed) continue
        try {
          await admission.reportProviderDomain({ routeId, reservationId: domainAdmission.reservationId, outcome: 'succeeded' })
        } catch {
          throw routingError(new ProviderAdapterError('ambiguous'))
        }
        return Object.freeze({ output, metadata: routeMetadata({ policy, route, externalAttempts, fallback }) })
      }
      throw routingError(lastError ?? new ProviderAdapterError('config'))
    },
  })
}
