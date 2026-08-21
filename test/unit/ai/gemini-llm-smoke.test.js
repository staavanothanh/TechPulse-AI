import { readFileSync } from 'node:fs'
import { describe, expect, it, vi } from 'vitest'
import {
  createGeminiSmokePlan,
  parseGeminiRegistry,
  runGeminiLlmSmoke,
} from '../../../scripts/gemini-llm-smoke.js'

const NOW = new Date('2026-08-21T00:00:00.000Z')

const CHAT_ENDPOINT = 'https://gemini.example.test/v1/chat/completions'
const EMBEDDING_ENDPOINT = 'https://embedding.example.test/v1/embeddings'

const GEMINI_PROFILE = Object.freeze({
  trustedEndpointProfileId: 'gemini-profile',
  adapterId: 'openai-compatible',
  operationEndpoints: {
    summary: CHAT_ENDPOINT,
    answer: CHAT_ENDPOINT,
    support: CHAT_ENDPOINT,
  },
  allowRedirects: false,
  classifyHttpFailure: ({ status }) => status === 404 ? 'model-retryable' : null,
})

const EMBEDDING_PROFILE = Object.freeze({
  trustedEndpointProfileId: 'embedding-profile',
  adapterId: 'openai-compatible',
  operationEndpoints: { embedding: EMBEDDING_ENDPOINT },
  allowRedirects: false,
})

function route({ routeId, model, operations, capability = 'nonconfidential', providerId = 'gemini', admissionDomainId = 'gemini-main', artifactCompatibilityId = null, embeddingDimensions, embeddingVersion }) {
  return {
    routeId,
    providerId,
    admissionDomainId,
    model,
    operations,
    capability,
    evidenceUrl: 'https://evidence.example.test/gemini',
    reviewedAt: NOW.toISOString(),
    evidenceExpiresAt: '2026-11-19T00:00:00.000Z',
    artifactCompatibilityId,
    ...(embeddingDimensions === undefined ? {} : { embeddingDimensions, embeddingVersion }),
    enabled: true,
    routeFailureThreshold: 3,
    routeCooldownSeconds: 60,
  }
}

function graph() {
  return {
    providerFailureDomains: [
      { providerFailureDomainId: 'gemini-domain', configVersion: 1, failureThreshold: 3, cooldownSeconds: 60 },
      { providerFailureDomainId: 'embedding-domain', configVersion: 1, failureThreshold: 3, cooldownSeconds: 60 },
    ],
    providers: [
      { providerId: 'gemini', providerFailureDomainId: 'gemini-domain', adapterId: 'openai-compatible', trustedEndpointProfileId: 'gemini-profile' },
      { providerId: 'embedding-provider', providerFailureDomainId: 'embedding-domain', adapterId: 'openai-compatible', trustedEndpointProfileId: 'embedding-profile' },
    ],
    admissionDomains: [
      { admissionDomainId: 'gemini-main', providerId: 'gemini', credentialEnvName: 'GEMINI_API_KEY', maxConcurrency: 2, budgetLimit: 1000, budgetWindow: 'day' },
      { admissionDomainId: 'embedding-main', providerId: 'embedding-provider', credentialEnvName: 'EMBEDDING_API_KEY', maxConcurrency: 2, budgetLimit: 1000, budgetWindow: 'day' },
    ],
    routes: [
      route({ routeId: 'summary-primary', model: 'gemini-summary-primary', operations: ['summary'] }),
      route({ routeId: 'summary-fallback', model: 'gemini-summary-fallback', operations: ['summary'] }),
      route({ routeId: 'qa-primary', model: 'gemini-answer', operations: ['answer'], capability: 'zdr-verified' }),
      route({ routeId: 'qa-support', model: 'gemini-support', operations: ['support'], capability: 'zdr-verified' }),
      route({ routeId: 'embedding-primary', providerId: 'embedding-provider', admissionDomainId: 'embedding-main', model: 'embedding-model', operations: ['embedding'], artifactCompatibilityId: 'embedding-v1', embeddingDimensions: 4, embeddingVersion: 1 }),
    ],
    workloadPolicies: [
      { workloadId: 'summary', operation: 'summary', requiredCapability: 'nonconfidential', maxExternalAttempts: 2, primaryRouteId: 'summary-primary', modelFallbackRouteIds: ['summary-fallback'], providerFallbackRouteIds: [] },
      { workloadId: 'qa-generation', operation: 'answer', requiredCapability: 'zdr-verified', maxExternalAttempts: 2, primaryRouteId: 'qa-primary', modelFallbackRouteIds: [], providerFallbackRouteIds: [] },
      { workloadId: 'qa-support', operation: 'support', requiredCapability: 'zdr-verified', maxExternalAttempts: 1, primaryRouteId: 'qa-support', modelFallbackRouteIds: [], providerFallbackRouteIds: [] },
      { workloadId: 'embedding', operation: 'embedding', requiredCapability: 'nonconfidential', maxExternalAttempts: 1, primaryRouteId: 'embedding-primary', modelFallbackRouteIds: [], providerFallbackRouteIds: [] },
    ],
  }
}

const PROFILE_OPTIONS = { trustedEndpointProfiles: [GEMINI_PROFILE, EMBEDDING_PROFILE] }

function environment() {
  return {
    PROVIDER_ADMISSION_DOMAINS_JSON: JSON.stringify(graph()),
    GEMINI_API_KEY: 'synthetic-gemini-secret',
  }
}

function responseFor(operation, { invalid = false } = {}) {
  if (invalid && operation === 'answer') {
    return { status: 'answered', paragraphs: [{ text: 'Cau tra loi khong co lien ket.' }] }
  }
  if (invalid && operation === 'support') {
    return { verdict: 'supported', addressesQuestion: true, evidenceBlockIds: ['E9'] }
  }
  if (operation === 'summary') {
    return { titleVi: 'Tiêu đề tiếng Việt', summaryVi: 'Tóm tắt tiếng Việt có nguồn.' }
  }
  if (operation === 'answer') {
    return { status: 'answered', paragraphs: [{ text: 'Ket luan duoc neu trong nguon.', citationIds: ['C1'], evidenceBlockIds: ['E1'] }] }
  }
  return { verdict: 'supported', addressesQuestion: true, evidenceBlockIds: ['E1'] }
}

function operationFromPayload(payload) {
  const instruction = payload?.messages?.[0]?.content
  if (instruction?.startsWith('Tom tat')) return 'summary'
  if (instruction?.startsWith('Tra loi')) return 'answer'
  if (instruction?.startsWith('Kiem tra')) return 'support'
  throw new Error('unexpected synthetic operation')
}

function fakeFetch({ invalidOperation, failFirstSummary = false } = {}) {
  let summaryCalls = 0
  return vi.fn(async (_url, init) => {
    const payload = JSON.parse(init.body)
    const operation = operationFromPayload(payload)
    if (operation === 'summary' && failFirstSummary && summaryCalls++ === 0) return new Response('', { status: 404 })
    const invalid = operation === invalidOperation
    return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(responseFor(operation, { invalid })) } }] }), { headers: { 'Content-Type': 'application/json' } })
  })
}

describe('Gemini LLM smoke harness', () => {
  it('validates the server graph and selects only the three LLM workloads', () => {
    const registry = parseGeminiRegistry(environment(), { now: NOW, ...PROFILE_OPTIONS })
    const plan = createGeminiSmokePlan(registry)

    expect(Object.keys(plan)).toEqual(['summary', 'answer', 'support'])
    expect(plan).toMatchObject({
      summary: { workloadId: 'summary', operation: 'summary', routeId: 'summary-primary', providerId: 'gemini' },
      answer: { workloadId: 'qa-generation', operation: 'answer', routeId: 'qa-primary', providerId: 'gemini' },
      support: { workloadId: 'qa-support', operation: 'support', routeId: 'qa-support', providerId: 'gemini' },
    })
  })

  it('runs summary, answer, and support through the configured adapter and router ports', async () => {
    const fetchImpl = fakeFetch()
    const report = await runGeminiLlmSmoke({ mode: 'full', environment: environment(), fetchImpl, now: () => NOW, ...PROFILE_OPTIONS })

    expect(report).toMatchObject({
      ok: true,
      mode: 'full',
      outboundRequests: 3,
      summary: { workloadId: 'summary', operation: 'summary', providerId: 'gemini', routeId: 'summary-primary' },
      answer: { workloadId: 'qa-generation', operation: 'answer', providerId: 'gemini', routeId: 'qa-primary' },
      support: { workloadId: 'qa-support', operation: 'support', providerId: 'gemini', routeId: 'qa-support' },
    })
    expect(fetchImpl).toHaveBeenCalledTimes(3)
    expect(JSON.stringify(report)).not.toContain('synthetic-gemini-secret')
  })

  it('uses the configured model fallback when the primary route is model-retryable', async () => {
    const fetchImpl = fakeFetch({ failFirstSummary: true })
    const report = await runGeminiLlmSmoke({ mode: 'summary', environment: environment(), fetchImpl, now: () => NOW, ...PROFILE_OPTIONS })

    expect(report.summary).toMatchObject({ routeId: 'summary-fallback', model: 'gemini-summary-fallback', fallback: 'model', externalAttempts: 2 })
    expect(fetchImpl).toHaveBeenCalledTimes(2)
  })

  it.each([
    ['answer', 'provider_schema_invalid'],
    ['support', 'provider_support_invalid'],
  ])('fails safely when %s output violates its contract', async (mode, code) => {
    const fetchImpl = fakeFetch({ invalidOperation: mode })

    await expect(runGeminiLlmSmoke({ mode, environment: environment(), fetchImpl, now: () => NOW, ...PROFILE_OPTIONS }))
      .rejects.toMatchObject({ code })
    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })

  it('does not contain unrelated provider or model literals in the harness', () => {
    const source = readFileSync(new URL('../../../scripts/gemini-llm-smoke.js', import.meta.url), 'utf8')
    expect(source).not.toMatch(/opencode|deepseek/i)
  })
})
