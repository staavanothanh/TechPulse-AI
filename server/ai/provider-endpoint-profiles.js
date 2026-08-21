function profile(value) {
  return Object.freeze({
    ...value,
    operationEndpoints: Object.freeze({ ...value.operationEndpoints }),
  })
}

const MODEL_CODES = new Set(['model_not_found', 'model_rate_limited', 'model_unavailable'])

function reviewedHttpClassifier({ status, errorCode, errorType } = {}) {
  if ((status === 404 || status === 408 || status === 425 || status === 429 || status >= 500)
    && (MODEL_CODES.has(errorCode) || MODEL_CODES.has(errorType))) return 'model-retryable'
  if (status === 408 || status === 425 || status === 429 || status >= 500) return 'provider-retryable'
  return null
}

export const TRUSTED_PROVIDER_ENDPOINT_PROFILES = Object.freeze([
  profile({
    trustedEndpointProfileId: 'opencode-zen-v1',
    adapterId: 'openai-compatible',
    operationEndpoints: {
      summary: 'https://opencode.ai/zen/v1/chat/completions',
      answer: 'https://opencode.ai/zen/v1/chat/completions',
      support: 'https://opencode.ai/zen/v1/chat/completions',
    },
    allowRedirects: false,
    classifyHttpFailure: reviewedHttpClassifier,
  }),
  profile({
    trustedEndpointProfileId: 'openrouter-v1',
    adapterId: 'openai-compatible',
    operationEndpoints: {
      summary: 'https://openrouter.ai/api/v1/chat/completions',
      answer: 'https://openrouter.ai/api/v1/chat/completions',
      support: 'https://openrouter.ai/api/v1/chat/completions',
      embedding: 'https://openrouter.ai/api/v1/embeddings',
    },
    allowRedirects: false,
    classifyHttpFailure: reviewedHttpClassifier,
  }),
  profile({
    trustedEndpointProfileId: 'gemini-ai-studio-openai-v1',
    adapterId: 'openai-compatible',
    operationEndpoints: {
      summary: 'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions',
      answer: 'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions',
      support: 'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions',
    },
    allowRedirects: false,
    classifyHttpFailure: reviewedHttpClassifier,
  }),
])
