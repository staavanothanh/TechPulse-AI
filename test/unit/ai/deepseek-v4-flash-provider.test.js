import { describe, expect, it, vi } from 'vitest'
import {
  DEEPSEEK_OPENAI_COMPATIBLE_PROTOCOL_ADAPTER,
  createConfiguredProviderAdapters,
} from '../../../server/ai/provider-adapters.js'
import { TRUSTED_PROVIDER_ENDPOINT_PROFILES } from '../../../server/ai/provider-endpoint-profiles.js'
import {
  buildDeepSeekV4FlashGraph,
  runDeepSeekV4FlashSmoke,
} from '../../../scripts/deepseek-v4-flash-smoke.js'

const ENDPOINT = 'https://api.deepseek.com/chat/completions'
const MODEL = 'deepseek-v4-flash'
const CREDENTIAL = 'synthetic-deepseek-secret'
const NOW = new Date('2026-08-23T00:00:00.000Z')

function environment() {
  return { DEEPSEEK_API_KEY: CREDENTIAL }
}

function operationFromPayload(payload) {
  const instruction = payload?.messages?.[0]?.content
  if (instruction?.startsWith('Summarize')) return 'summary'
  if (instruction?.startsWith('Tra loi')) return 'answer'
  if (instruction?.startsWith('Kiem tra')) return 'support'
  throw new Error('unexpected operation')
}

function responseFor(operation) {
  if (operation === 'summary') return { titleVi: 'Hệ thống làm mát mới', summaryVi: 'Dữ liệu tổng hợp an toàn cho phép kiểm tra tóm tắt.' }
  if (operation === 'answer') return { status: 'answered', paragraphs: [{ text: 'Nguồn xác nhận dữ liệu tổng hợp an toàn.', citationIds: ['C1'], evidenceBlockIds: ['E1'] }] }
  return { verdict: 'supported', addressesQuestion: true, evidenceBlockIds: ['E1'] }
}

function successfulFetch() {
  return vi.fn(async (_url, init) => {
    const operation = operationFromPayload(JSON.parse(init.body))
    return new Response(JSON.stringify({
      model: MODEL,
      choices: [{ message: { content: JSON.stringify(responseFor(operation)) } }],
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })
  })
}

describe('DeepSeek V4 Flash provider smoke', () => {
  it('installs an exact HTTPS profile and a non-thinking OpenAI-compatible adapter', () => {
    const profile = TRUSTED_PROVIDER_ENDPOINT_PROFILES.find((item) => item.trustedEndpointProfileId === 'deepseek-openai-v1')

    expect(profile).toMatchObject({
      adapterId: 'deepseek-openai-compatible',
      allowRedirects: false,
      operationEndpoints: { summary: ENDPOINT, answer: ENDPOINT, support: ENDPOINT },
    })
    expect(DEEPSEEK_OPENAI_COMPATIBLE_PROTOCOL_ADAPTER).toMatchObject({
      adapterId: 'deepseek-openai-compatible',
      supportedOperations: ['summary', 'answer', 'support'],
    })
    expect(DEEPSEEK_OPENAI_COMPATIBLE_PROTOCOL_ADAPTER.buildHeaders(CREDENTIAL)).toMatchObject({
      Authorization: `Bearer ${CREDENTIAL}`,
      'Content-Type': 'application/json',
    })
    expect(DEEPSEEK_OPENAI_COMPATIBLE_PROTOCOL_ADAPTER.buildPayload({
      operation: 'summary',
      route: { model: MODEL },
      input: 'safe synthetic input',
      systemInstruction: 'Return JSON.',
    })).toMatchObject({
      model: MODEL,
      thinking: { type: 'disabled' },
      response_format: { type: 'json_object' },
    })
  })

  it('binds summary and both Q&A workloads to deepseek-v4-flash with explicit nonconfidential approval', () => {
    const graph = buildDeepSeekV4FlashGraph(NOW)

    expect(graph.routes).toHaveLength(3)
    expect(graph.routes.every((route) => route.model === MODEL)).toBe(true)
    expect(graph.routes.map((route) => route.operations[0])).toEqual(['summary', 'answer', 'support'])
    expect(graph.routes.every((route) => route.capability === 'nonconfidential')).toBe(true)
    expect(graph.workloadPolicies).toEqual([
      expect.objectContaining({ workloadId: 'summary', operation: 'summary', requiredCapability: 'nonconfidential' }),
      expect.objectContaining({ workloadId: 'qa-generation', operation: 'answer', requiredCapability: 'nonconfidential' }),
      expect.objectContaining({ workloadId: 'qa-support', operation: 'support', requiredCapability: 'nonconfidential' }),
    ])
    expect(graph.routes.every((route) => route.reviewedAt === '2026-08-23T00:00:00.000Z')).toBe(true)
    expect(graph.routes.every((route) => route.evidenceExpiresAt === '2026-11-21T00:00:00.000Z')).toBe(true)
  })

  it('rejects an invalid evidence clock before building a provider graph', () => {
    expect(() => buildDeepSeekV4FlashGraph(new Date('invalid'))).toThrow(/clock/i)
  })

  it('fails closed before dispatch when the DeepSeek credential is absent', async () => {
    const fetchImpl = vi.fn()

    await expect(runDeepSeekV4FlashSmoke({ environment: {}, fetchImpl, now: () => NOW }))
      .rejects.toMatchObject({ code: 'deepseek_credential_unavailable', smokeStage: 'configuration' })
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('runs summary, answer and support through the adapter boundary without exposing the credential', async () => {
    const fetchImpl = successfulFetch()
    const report = await runDeepSeekV4FlashSmoke({ environment: environment(), fetchImpl, now: () => NOW })

    expect(report).toMatchObject({
      ok: true,
      mode: 'full',
      outboundRequests: 3,
      summary: { providerId: 'deepseek', model: MODEL },
      answer: { workloadId: 'qa-generation', operation: 'answer', providerId: 'deepseek', model: MODEL, policyEligible: true },
      support: { workloadId: 'qa-support', operation: 'support', providerId: 'deepseek', model: MODEL, policyEligible: true },
    })
    expect(fetchImpl).toHaveBeenCalledTimes(3)
    for (const [url, init] of fetchImpl.mock.calls) {
      expect(url).toBe(ENDPOINT)
      expect(init.headers).toMatchObject({ Authorization: `Bearer ${CREDENTIAL}` })
      expect(JSON.parse(init.body)).toMatchObject({
        model: MODEL,
        thinking: { type: 'disabled' },
        response_format: { type: 'json_object' },
      })
    }
    expect(JSON.stringify(report)).not.toContain(CREDENTIAL)
  })

  it('rejects output that does not satisfy the grounded answer contract', async () => {
    const fetchImpl = vi.fn(async (_url, init) => {
      const operation = operationFromPayload(JSON.parse(init.body))
      const value = operation === 'answer'
        ? { status: 'answered', paragraphs: [{ text: 'Không có citation.' }] }
        : responseFor(operation)
      return new Response(JSON.stringify({ model: MODEL, choices: [{ message: { content: JSON.stringify(value) } }] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    })

    await expect(runDeepSeekV4FlashSmoke({ mode: 'answer', environment: environment(), fetchImpl, now: () => NOW }))
      .rejects.toMatchObject({ code: 'provider_schema_invalid', smokeStage: 'answer' })
  })

  it('classifies HTTP 429 as a retryable provider limit without exposing the response body', async () => {
    const fetchImpl = vi.fn(async () => new Response('private provider payload', { status: 429 }))

    await expect(runDeepSeekV4FlashSmoke({ mode: 'summary', environment: environment(), fetchImpl, now: () => NOW }))
      .rejects.toMatchObject({ code: 'provider_domain_unavailable', smokeStage: 'summary', upstreamStatus: 429, retryable: true })
  })

  it('rejects a successful response that reports a different upstream model', async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({
      model: 'deepseek-v4-pro',
      choices: [{ message: { content: JSON.stringify(responseFor('summary')) } }],
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }))

    await expect(runDeepSeekV4FlashSmoke({ mode: 'summary', environment: environment(), fetchImpl, now: () => NOW }))
      .rejects.toMatchObject({ code: 'provider_config_invalid', smokeStage: 'summary' })
  })

  it('uses the configured adapter directly for a structured summary request', async () => {
    const registry = buildDeepSeekV4FlashGraph(NOW)
    const fetchImpl = successfulFetch()
    const adapters = createConfiguredProviderAdapters({
      registry,
      fetchImpl,
      resolveCredential: (name) => name === 'DEEPSEEK_API_KEY' ? CREDENTIAL : null,
    })

    await expect(adapters.llmProvider.summarize({ route: registry.routes[0], input: 'safe synthetic input', locale: 'vi', tools: [] }))
      .resolves.toMatchObject({ titleVi: expect.any(String), summaryVi: expect.any(String), model: MODEL })
  })

  it('combines a caller cancellation signal with the provider timeout signal', async () => {
    const registry = buildDeepSeekV4FlashGraph(NOW)
    let observedSignal
    const fetchImpl = vi.fn(async (_url, init) => {
      observedSignal = init.signal
      return successfulFetch()(_url, init)
    })
    const adapters = createConfiguredProviderAdapters({
      registry,
      fetchImpl,
      resolveCredential: (name) => name === 'DEEPSEEK_API_KEY' ? CREDENTIAL : null,
    })
    const controller = new globalThis.AbortController()
    controller.abort(new Error('lease lost'))

    await adapters.llmProvider.summarize({
      route: registry.routes[0], input: 'safe synthetic input', locale: 'vi', tools: [], signal: controller.signal,
    })

    expect(observedSignal.aborted).toBe(true)
  })
})
