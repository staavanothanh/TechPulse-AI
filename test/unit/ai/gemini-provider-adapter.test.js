import { describe, expect, it, vi } from 'vitest'
import { createConfiguredProviderAdapters } from '../../../server/ai/provider-adapters.js'
import { TRUSTED_PROVIDER_ENDPOINT_PROFILES } from '../../../server/ai/provider-endpoint-profiles.js'

const GEMINI_ENDPOINT = 'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions'
const GEMINI_CREDENTIAL = 'gemini-test-secret'

const routes = Object.freeze({
  summary: Object.freeze({ routeId: 'gemini-summary', admissionDomainId: 'gemini-main', providerId: 'gemini', model: 'gemini-2.5-flash', operations: ['summary'] }),
  answer: Object.freeze({ routeId: 'gemini-answer', admissionDomainId: 'gemini-main', providerId: 'gemini', model: 'gemini-2.5-flash', operations: ['answer'] }),
  support: Object.freeze({ routeId: 'gemini-support', admissionDomainId: 'gemini-main', providerId: 'gemini', model: 'gemini-2.5-flash', operations: ['support'] }),
})

const registry = Object.freeze({
  providers: [Object.freeze({ providerId: 'gemini', providerFailureDomainId: 'gemini-ai-studio', adapterId: 'openai-compatible', trustedEndpointProfileId: 'gemini-ai-studio-openai-v1' })],
  admissionDomains: [Object.freeze({ admissionDomainId: 'gemini-main', providerId: 'gemini', credentialEnvName: 'GEMINI_API_KEY_ENV' })],
  routes: Object.freeze(Object.values(routes)),
})

const operationCases = [
  {
    operation: 'summary',
    call: (adapters) => adapters.llmProvider.summarize({ route: routes.summary, input: 'nguon da phan cach', locale: 'vi', tools: [] }),
    providerValue: { titleVi: 'Tin mới', summaryVi: 'Bản tóm tắt có nguồn.' },
  },
  {
    operation: 'answer',
    call: (adapters) => adapters.llmProvider.answer({ route: routes.answer, input: 'evidence da phan cach', locale: 'vi', tools: [] }),
    providerValue: { status: 'answered', paragraphs: [{ text: 'Câu trả lời.', citationIds: ['C1'], evidenceBlockIds: ['E1'] }] },
  },
  {
    operation: 'support',
    call: (adapters) => adapters.llmProvider.verifySupport({ route: routes.support, input: 'ket qua va evidence da phan cach', locale: 'vi', tools: [] }),
    providerValue: { verdict: 'supported', addressesQuestion: true, evidenceBlockIds: ['E1'] },
  },
]

function successfulResponse(value) {
  return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(value) } }] }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  })
}

function adaptersFor(fetchImpl) {
  return createConfiguredProviderAdapters({
    registry,
    fetchImpl,
    resolveCredential: (name) => name === 'GEMINI_API_KEY_ENV' ? GEMINI_CREDENTIAL : null,
  })
}

describe('Gemini AI Studio OpenAI-compatible provider adapter', () => {
  it('installs one exact HTTPS chat endpoint profile without changing embedding routing', () => {
    const profile = TRUSTED_PROVIDER_ENDPOINT_PROFILES.find((item) => item.trustedEndpointProfileId === 'gemini-ai-studio-openai-v1')
    const openRouterProfile = TRUSTED_PROVIDER_ENDPOINT_PROFILES.find((item) => item.trustedEndpointProfileId === 'openrouter-v1')

    expect(profile).toEqual(expect.objectContaining({
      adapterId: 'openai-compatible',
      allowRedirects: false,
      operationEndpoints: {
        summary: GEMINI_ENDPOINT,
        answer: GEMINI_ENDPOINT,
        support: GEMINI_ENDPOINT,
      },
    }))
    expect(profile.operationEndpoints).not.toHaveProperty('embedding')
    expect(openRouterProfile.operationEndpoints.embedding).toBe('https://openrouter.ai/api/v1/embeddings')
  })

  it.each(operationCases)('sends and parses a structured $operation request', async ({ call, providerValue }) => {
    const fetchImpl = vi.fn(async () => successfulResponse(providerValue))

    await expect(call(adaptersFor(fetchImpl))).resolves.toEqual({ ...providerValue, model: 'gemini-2.5-flash' })

    const [url, init] = fetchImpl.mock.calls[0]
    const payload = JSON.parse(init.body)
    expect(url).toBe(GEMINI_ENDPOINT)
    expect(init).toMatchObject({ method: 'POST', redirect: 'error' })
    expect(init.headers).toMatchObject({ Authorization: `Bearer ${GEMINI_CREDENTIAL}`, 'Content-Type': 'application/json', Accept: 'application/json' })
    expect(payload).toMatchObject({
      model: 'gemini-2.5-flash',
      messages: [
        { role: 'system', content: expect.any(String) },
        { role: 'user', content: expect.any(String) },
      ],
      response_format: { type: 'json_object' },
      temperature: 0.1,
    })
    expect(payload).not.toHaveProperty('tools')
    expect(JSON.stringify(payload)).not.toContain(GEMINI_CREDENTIAL)
  })

  it.each([
    { status: 401, failureClass: 'config', code: 'provider_config_invalid', retryable: false },
    { status: 429, failureClass: 'provider-retryable', code: 'provider_domain_unavailable', retryable: true },
    { status: 503, failureClass: 'provider-retryable', code: 'provider_domain_unavailable', retryable: true },
  ])('classifies Gemini HTTP $status without reading or exposing its body', async ({ status, failureClass, code, retryable }) => {
    const responseHeaders = new Response('', { status, headers: { 'x-provider-error-code': 'safe_code' } }).headers
    const response = {
      status,
      ok: false,
      headers: responseHeaders,
      get body() { throw new Error('provider body must not be read') },
      text: vi.fn(async () => { throw new Error('provider body must not be read') }),
    }

    const request = adaptersFor(vi.fn(async () => response)).llmProvider.summarize({ route: routes.summary, input: 'safe', locale: 'vi', tools: [] })
    const error = await request.catch((value) => value)

    expect(error).toMatchObject({
      failureClass,
      code,
      retryable,
      upstreamStatus: status,
      message: 'AI provider request failed safely',
    })
    expect(error).not.toHaveProperty('cause')
    expect(JSON.stringify(error)).not.toContain(GEMINI_CREDENTIAL)
    expect(response.text).not.toHaveBeenCalled()
  })

  it('maps invalid Gemini completion content to the closed schema failure', async () => {
    const fetchImpl = vi.fn(async () => successfulResponse('not-json'))

    await expect(adaptersFor(fetchImpl).llmProvider.summarize({ route: routes.summary, input: 'safe', locale: 'vi', tools: [] })).rejects.toMatchObject({
      failureClass: 'schema',
      code: 'provider_schema_invalid',
      retryable: false,
      message: 'AI provider request failed safely',
    })
  })
})
