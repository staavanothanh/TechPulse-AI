import { describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { createSmokePlan, parseSmokeRegistry, runSmoke } from '../../../scripts/step9-real-provider-smoke.js'

const graph = {
  providerFailureDomains: [
    { providerFailureDomainId: 'summary-domain', configVersion: 1, failureThreshold: 3, cooldownSeconds: 60 },
    { providerFailureDomainId: 'embedding-domain', configVersion: 1, failureThreshold: 3, cooldownSeconds: 60 },
  ],
  providers: [
    { providerId: 'summary-provider', providerFailureDomainId: 'summary-domain', adapterId: 'openai-compatible', trustedEndpointProfileId: 'opencode-zen-v1' },
    { providerId: 'embedding-provider', providerFailureDomainId: 'embedding-domain', adapterId: 'openai-compatible', trustedEndpointProfileId: 'openrouter-v1' },
  ],
  admissionDomains: [
    { admissionDomainId: 'summary-admission', providerId: 'summary-provider', credentialEnvName: 'SUMMARY_KEY', maxConcurrency: 1, budgetLimit: 5, budgetWindow: 'day' },
    { admissionDomainId: 'embedding-admission', providerId: 'embedding-provider', credentialEnvName: 'EMBEDDING_KEY', maxConcurrency: 1, budgetLimit: 5, budgetWindow: 'day' },
  ],
  routes: [
    { routeId: 'summary-route', providerId: 'summary-provider', admissionDomainId: 'summary-admission', model: 'summary-model', operations: ['summary'], capability: 'nonconfidential', evidenceUrl: 'https://evidence.example/summary', reviewedAt: '2026-01-01T00:00:00.000Z', evidenceExpiresAt: '2099-01-01T00:00:00.000Z', artifactCompatibilityId: null, enabled: true, routeFailureThreshold: 3, routeCooldownSeconds: 60 },
    { routeId: 'embedding-route', providerId: 'embedding-provider', admissionDomainId: 'embedding-admission', model: 'embedding-model', operations: ['embedding'], capability: 'nonconfidential', evidenceUrl: 'https://evidence.example/embedding', reviewedAt: '2026-01-01T00:00:00.000Z', evidenceExpiresAt: '2099-01-01T00:00:00.000Z', artifactCompatibilityId: 'embedding-v1', embeddingDimensions: 6, embeddingVersion: 1, enabled: true, routeFailureThreshold: 3, routeCooldownSeconds: 60 },
  ],
  workloadPolicies: [
    { workloadId: 'summary-workload', operation: 'summary', requiredCapability: 'nonconfidential', maxExternalAttempts: 2, primaryRouteId: 'summary-route', modelFallbackRouteIds: [], providerFallbackRouteIds: [] },
    { workloadId: 'embedding-workload', operation: 'embedding', requiredCapability: 'nonconfidential', maxExternalAttempts: 1, primaryRouteId: 'embedding-route', modelFallbackRouteIds: [], providerFallbackRouteIds: [] },
  ],
}

describe('configured provider smoke harness', () => {
  it('loads the validated graph and selects workloads by operation', () => {
    const registry = parseSmokeRegistry({
      PROVIDER_ADMISSION_DOMAINS_JSON: JSON.stringify(graph),
      SUMMARY_KEY: 'test-secret',
      EMBEDDING_KEY: 'test-secret',
    }, { now: new Date('2026-08-15T00:00:00.000Z') })
    const plan = createSmokePlan(registry, { now: new Date('2026-08-15T00:00:00.000Z') })
    expect(plan.summary).toMatchObject({ workloadId: 'summary-workload', routeId: 'summary-route', model: 'summary-model', providerId: 'summary-provider' })
    expect(plan.embedding).toMatchObject({ workloadId: 'embedding-workload', routeId: 'embedding-route', model: 'embedding-model', providerId: 'embedding-provider', artifactCompatibilityId: 'embedding-v1' })
  })

  it('rejects a legacy provider array instead of constructing a fallback graph', () => {
    expect(() => parseSmokeRegistry({ PROVIDER_ADMISSION_DOMAINS_JSON: '[{}]' })).toThrow(/legacy|graph/i)
  })

  it('routes both smoke calls through the configured workloads and writes no secret metadata', async () => {
    const vectors = Array.from({ length: 18 }, (_item, index) => {
      const basis = index < 6 ? index : index < 12 ? index - 6 : 0
      return { embedding: Array.from({ length: 6 }, (_value, position) => position === basis ? 1 : 0) }
    })
    const fetchImpl = vi.fn(async (url) => url.includes('/embeddings')
      ? new Response(JSON.stringify({ data: vectors }), { headers: { 'Content-Type': 'application/json' } })
      : new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ titleVi: 'Tiêu đề tiếng Việt', summaryVi: 'Nội dung tiếng Việt an toàn có nguồn.' }) } }] }), { headers: { 'Content-Type': 'application/json' } }))
    let fixture
    const report = await runSmoke({
      mode: '--full',
      environment: { PROVIDER_ADMISSION_DOMAINS_JSON: JSON.stringify(graph), SUMMARY_KEY: 'test-secret', EMBEDDING_KEY: 'test-secret' },
      now: () => new Date('2026-08-15T00:00:00.000Z'),
      fetchImpl,
      writeFixture: async (_path, value) => { fixture = value },
    })
    expect(report).toMatchObject({ ok: true, outboundRequests: 2, summary: { providerId: 'summary-provider', routeId: 'summary-route', model: 'summary-model' }, embedding: { providerId: 'embedding-provider', routeId: 'embedding-route', model: 'embedding-model' } })
    expect(fixture.provenance).toMatchObject({ providerId: 'embedding-provider', endpointId: 'openrouter-v1', model: 'embedding-model', artifactCompatibilityId: 'embedding-v1' })
    expect(JSON.stringify(report)).not.toContain('test-secret')
    expect(fetchImpl).toHaveBeenCalledTimes(2)
  })

  it('contains no vendor or model selection in the smoke entry point', () => {
    const source = readFileSync(new URL('../../../scripts/step9-real-provider-smoke.js', import.meta.url), 'utf8')
    expect(source).not.toMatch(/opencode-zen|openrouter|deepseek|baai\/bge-m3|ZEN_SUMMARY_TIMEOUT/i)
  })
})
