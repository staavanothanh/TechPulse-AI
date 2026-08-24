export const PROVIDER_FAILURE_CLASSES = Object.freeze([
  'model-retryable',
  'provider-retryable',
  'policy',
  'privacy',
  'sensitive-input',
  'config',
  'schema',
  'support',
  'ambiguous',
])

const DEFINITIONS = Object.freeze({
  'model-retryable': Object.freeze({ code: 'provider_model_unavailable', retryable: true }),
  'provider-retryable': Object.freeze({ code: 'provider_domain_unavailable', retryable: true }),
  policy: Object.freeze({ code: 'policy_blocked', retryable: false }),
  privacy: Object.freeze({ code: 'privacy_blocked', retryable: false }),
  'sensitive-input': Object.freeze({ code: 'sensitive_input', retryable: false }),
  config: Object.freeze({ code: 'provider_config_invalid', retryable: false }),
  schema: Object.freeze({ code: 'provider_schema_invalid', retryable: false }),
  support: Object.freeze({ code: 'provider_support_invalid', retryable: false }),
  ambiguous: Object.freeze({ code: 'ambiguous_provider_outcome', retryable: false }),
})

function positiveInteger(value) {
  return Number.isInteger(value) && value > 0
}

export class ProviderAdapterError extends Error {
  constructor(failureClass, { upstreamStatus, retryAfterSeconds, localControl = false } = {}) {
    const definition = DEFINITIONS[failureClass]
    if (!definition) throw new Error('Provider failure class is invalid')
    super('AI provider request failed safely')
    this.name = 'ProviderAdapterError'
    this.failureClass = failureClass
    this.code = definition.code
    this.retryable = definition.retryable
    if (localControl === true) this.providerLocalControl = true
    if (positiveInteger(upstreamStatus) && upstreamStatus >= 400 && upstreamStatus <= 599) this.upstreamStatus = upstreamStatus
    if (positiveInteger(retryAfterSeconds)) this.retryAfterSeconds = retryAfterSeconds
  }
}

export function classifyProviderError(error) {
  if (!(error instanceof ProviderAdapterError) || !DEFINITIONS[error.failureClass]) return Object.freeze({ ...DEFINITIONS.ambiguous, failureClass: 'ambiguous' })
  return Object.freeze({
    failureClass: error.failureClass,
    code: DEFINITIONS[error.failureClass].code,
    retryable: DEFINITIONS[error.failureClass].retryable,
    ...(positiveInteger(error.upstreamStatus) ? { upstreamStatus: error.upstreamStatus } : {}),
    ...(positiveInteger(error.retryAfterSeconds) ? { retryAfterSeconds: error.retryAfterSeconds } : {}),
  })
}

export function providerFailure(failureClass) {
  const definition = DEFINITIONS[failureClass]
  if (!definition) throw new Error('Provider failure class is invalid')
  return Object.freeze({ failureClass, ...definition })
}
