import { describe, expect, it, vi } from 'vitest'
import { createConfiguredProviderAdapters } from '../../../server/ai/provider-adapters.js'

const registry = {
  domains: [{ admissionDomainId: 'openrouter-main', provider: 'openrouter', credentialEnvName: 'OPENROUTER_KEY_ENV' }],
  routes: [
    { routeId: 'summary-primary', admissionDomainId: 'openrouter-main', provider: 'openrouter', model: 'summary/model' },
    { routeId: 'embedding-bge-m3', admissionDomainId: 'openrouter-main', provider: 'openrouter', model: 'baai/bge-m3' },
  ],
}

describe('Step 9 controlled provider adapters', () => {
  it('sends a bounded structured summary request without tools or secret exposure', async () => {
    const fetchImpl = vi.fn(async (_url, _init) => new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ titleVi: 'Tiêu đề tiếng Việt', summaryVi: 'Nội dung tiếng Việt có nguồn.' }) } }] }), { status: 200, headers: { 'Content-Type': 'application/json' } }))
    const adapters = createConfiguredProviderAdapters({ registry, fetchImpl, resolveCredential: (name) => name === 'OPENROUTER_KEY_ENV' ? 'secret-value' : null })
    const result = await adapters.llmProvider.summarize({ route: registry.routes[0], input: '<external-source-data>{}</external-source-data>', locale: 'vi', tools: [] })
    expect(result).toEqual({ titleVi: 'Tiêu đề tiếng Việt', summaryVi: 'Nội dung tiếng Việt có nguồn.', model: 'summary/model' })
    const [url, init] = fetchImpl.mock.calls[0]
    expect(url).toBe('https://openrouter.ai/api/v1/chat/completions')
    expect(init.headers.Authorization).toBe('Bearer secret-value')
    const body = JSON.parse(init.body)
    expect(body.model).toBe('summary/model')
    expect(body).not.toHaveProperty('tools')
    expect(JSON.stringify(body)).not.toMatch(/leadMedia|providerPayload|secret-value/)
  })

  it('pins embedding requests to BGE-M3/1024 and maps retryable failures safely', async () => {
    const vector = Array(1024).fill(0.01)
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ data: [{ embedding: vector }], model: 'baai/bge-m3' }), { status: 200, headers: { 'Content-Type': 'application/json' } }))
      .mockResolvedValueOnce(new Response('raw provider secret payload', { status: 503 }))
    const adapters = createConfiguredProviderAdapters({ registry, fetchImpl, resolveCredential: () => 'secret-value' })
    await expect(adapters.embeddingProvider.embed({ route: registry.routes[1], input: 'safe input', model: 'baai/bge-m3', dimensions: 1024 })).resolves.toEqual({ model: 'baai/bge-m3', embedding: vector })
    expect(JSON.parse(fetchImpl.mock.calls[0][1].body)).toEqual({ model: 'baai/bge-m3', input: ['safe input'], dimensions: 1024 })
    await expect(adapters.embeddingProvider.embed({ route: registry.routes[1], input: 'safe input', model: 'baai/bge-m3', dimensions: 1024 })).rejects.toMatchObject({ code: 'provider_http_error', retryable: true, message: 'AI provider request failed safely' })
  })

  it('fails closed before network I/O when credential or route/model binding is invalid', async () => {
    const fetchImpl = vi.fn()
    const missing = createConfiguredProviderAdapters({ registry, fetchImpl, resolveCredential: () => null })
    await expect(missing.llmProvider.summarize({ route: registry.routes[0], input: 'safe', locale: 'vi', tools: [] })).rejects.toMatchObject({ retryable: false })
    await expect(missing.embeddingProvider.embed({ route: { ...registry.routes[1], model: 'alternate' }, input: 'safe', model: 'baai/bge-m3', dimensions: 1024 })).rejects.toMatchObject({ retryable: false })
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('instructs the answer provider to return exact evidence block IDs for every cited paragraph', async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ status: 'answered', paragraphs: [] }) } }] }), { status: 200, headers: { 'Content-Type': 'application/json' } }))
    const answerRoute = { routeId: 'answer-primary', admissionDomainId: 'openrouter-main', provider: 'openrouter', model: 'summary/model' }
    const adapters = createConfiguredProviderAdapters({ registry: { ...registry, routes: [...registry.routes, answerRoute] }, fetchImpl, resolveCredential: () => 'secret-value' })

    await adapters.llmProvider.answer({ route: answerRoute, input: '<evidence-block id="E1" citation="C1">du lieu</evidence-block>', locale: 'vi', tools: [] })

    const body = JSON.parse(fetchImpl.mock.calls[0][1].body)
    expect(body.messages[0].content).toMatch(/evidenceBlockIds/)
  })

  it('requires the support provider to bind its verdict to the exact evidence block set', async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ verdict: 'supported', evidenceBlockIds: ['E1'] }) } }] }), { status: 200, headers: { 'Content-Type': 'application/json' } }))
    const supportRoute = { routeId: 'answer-support', admissionDomainId: 'openrouter-main', provider: 'openrouter', model: 'summary/model' }
    const adapters = createConfiguredProviderAdapters({ registry: { ...registry, routes: [...registry.routes, supportRoute] }, fetchImpl, resolveCredential: () => 'secret-value' })

    await expect(adapters.llmProvider.verifySupport({ route: supportRoute, input: JSON.stringify({ evidenceBlocks: [{ id: 'E1', citationId: 'C1', text: 'exact admitted block' }], evidenceMap: { E1: 'C1' }, paragraphs: [] }), locale: 'vi', tools: [] })).resolves.toMatchObject({ verdict: 'supported', evidenceBlockIds: ['E1'] })

    const body = JSON.parse(fetchImpl.mock.calls[0][1].body)
    expect(body.messages[0].content).toMatch(/evidenceBlockIds/)
  })
})
