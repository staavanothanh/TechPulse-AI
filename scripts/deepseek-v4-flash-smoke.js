import { pathToFileURL } from 'node:url'
import { createConfiguredProviderAdapters } from '../server/ai/provider-adapters.js'
import { validateProviderConfiguration } from '../server/ai/provider-registry.js'
import {
  parseGeminiSmokeMode,
  runGeminiLlmSmoke,
  validateGeminiAnswerOutput,
  validateGeminiSupportOutput,
} from './gemini-llm-smoke.js'

const MODEL = 'deepseek-v4-flash'
const CREDENTIAL_ENV = 'DEEPSEEK_API_KEY'
const EVIDENCE_URL = 'https://api-docs.deepseek.com/quick_start/pricing/'
const REVIEWED_AT = '2026-08-23T00:00:00.000Z'
const EVIDENCE_EXPIRES_AT = '2026-11-21T00:00:00.000Z'
const SAFE_CODE = /^[a-z][a-z0-9_]{0,63}$/
const SYNTHETIC_QUESTION = 'Du lieu trong nguon co an toan cho smoke test khong?'
const SYNTHETIC_EVIDENCE_BLOCKS = Object.freeze([
  Object.freeze({ id: 'E1', citationId: 'C1', text: '<evidence-block id="E1" citation="C1">Du lieu trong nguon la synthetic an toan cho smoke test.</evidence-block>' }),
])
const SYNTHETIC_PARAGRAPHS = Object.freeze([
  Object.freeze({ text: 'Du lieu trong nguon la synthetic an toan cho smoke test.', citationIds: Object.freeze(['C1']), evidenceBlockIds: Object.freeze(['E1']) }),
])

function validDate(value) {
  return value instanceof Date && !Number.isNaN(value.getTime())
}

function route({ routeId, operation }) {
  return {
    routeId,
    providerId: 'deepseek',
    admissionDomainId: 'deepseek-main',
    model: MODEL,
    operations: [operation],
    capability: 'nonconfidential',
    evidenceUrl: EVIDENCE_URL,
    reviewedAt: REVIEWED_AT,
    evidenceExpiresAt: EVIDENCE_EXPIRES_AT,
    artifactCompatibilityId: null,
    enabled: true,
    routeFailureThreshold: 3,
    routeCooldownSeconds: 60,
  }
}

export function buildDeepSeekV4FlashGraph(now = new Date()) {
  if (!validDate(now)) throw new Error('DeepSeek smoke clock is invalid')
  return {
    providerFailureDomains: [
      { providerFailureDomainId: 'deepseek-control-plane', configVersion: 1, failureThreshold: 3, cooldownSeconds: 60 },
    ],
    providers: [
      { providerId: 'deepseek', providerFailureDomainId: 'deepseek-control-plane', adapterId: 'deepseek-openai-compatible', trustedEndpointProfileId: 'deepseek-openai-v1' },
    ],
    admissionDomains: [
      { admissionDomainId: 'deepseek-main', providerId: 'deepseek', credentialEnvName: CREDENTIAL_ENV, maxConcurrency: 4, budgetLimit: 10_000, budgetWindow: 'day' },
    ],
    routes: [
      route({ routeId: 'deepseek-summary', operation: 'summary' }),
      route({ routeId: 'deepseek-answer', operation: 'answer' }),
      route({ routeId: 'deepseek-support', operation: 'support' }),
    ],
    workloadPolicies: [
      { workloadId: 'summary', operation: 'summary', requiredCapability: 'nonconfidential', maxExternalAttempts: 2, primaryRouteId: 'deepseek-summary', modelFallbackRouteIds: [], providerFallbackRouteIds: [] },
    ],
  }
}

function safeSmokeError(error) {
  const safe = new Error('DeepSeek V4 Flash smoke failed safely')
  safe.code = typeof error?.code === 'string' && SAFE_CODE.test(error.code) ? error.code : 'deepseek_v4_flash_smoke_failed'
  safe.smokeStage = typeof error?.smokeStage === 'string' ? error.smokeStage : 'configuration'
  if (typeof error?.failureClass === 'string' && SAFE_CODE.test(error.failureClass)) safe.failureClass = error.failureClass
  if (error?.retryable === true) safe.retryable = true
  if (Number.isInteger(error?.upstreamStatus) && error.upstreamStatus >= 400 && error.upstreamStatus <= 599) safe.upstreamStatus = error.upstreamStatus
  return safe
}

export async function runDeepSeekV4FlashSmoke({ mode = 'full', environment = process.env, fetchImpl = globalThis.fetch, now = () => new Date() } = {}) {
  const clock = typeof now === 'function' ? now : () => now
  const credential = environment?.[CREDENTIAL_ENV]
  if (typeof credential !== 'string' || credential.length < 1) throw safeSmokeError({ code: 'deepseek_credential_unavailable' })
  const selected = parseGeminiSmokeMode(mode)
  const graph = buildDeepSeekV4FlashGraph(clock())
  const smokeEnvironment = {
    PROVIDER_ADMISSION_DOMAINS_JSON: JSON.stringify(graph),
    [CREDENTIAL_ENV]: credential,
  }
  let stage = 'configuration'
  try {
    const registry = validateProviderConfiguration(graph, { now: clock() })
    const adapters = createConfiguredProviderAdapters({
      registry,
      fetchImpl,
      resolveCredential: (name) => smokeEnvironment[name],
    })
    const report = { ok: true, mode: selected.mode, outboundRequests: 0 }

    if (selected.summary) {
      stage = 'summary'
      const summaryReport = await runGeminiLlmSmoke({ mode: 'summary', environment: smokeEnvironment, fetchImpl, now: clock })
      report.summary = summaryReport.summary
      report.outboundRequests += summaryReport.outboundRequests
    }

    if (selected.answer) {
      stage = 'answer'
      const admittedInput = answerInput()
      const output = await adapters.llmProvider.answer({ route: routeFor(registry, 'answer'), input: admittedInput.input, locale: 'vi', tools: [] })
      validateGeminiAnswerOutput({ output, admittedInput })
      report.answer = compatibilityMetadata(routeFor(registry, 'answer'))
      report.outboundRequests += 1
    }

    if (selected.support) {
      stage = 'support'
      const admittedInput = supportInput()
      const output = await adapters.llmProvider.verifySupport({ route: routeFor(registry, 'support'), input: admittedInput.input, locale: 'vi', tools: [] })
      validateGeminiSupportOutput({ output, admittedInput })
      report.support = compatibilityMetadata(routeFor(registry, 'support'))
      report.outboundRequests += 1
    }

    return Object.freeze(report)
  } catch (error) {
    throw safeSmokeError({
      code: error?.code,
      smokeStage: error?.smokeStage ?? stage,
      failureClass: error?.failureClass,
      retryable: error?.retryable,
      upstreamStatus: error?.upstreamStatus,
    })
  }
}

function routeFor(registry, operation) {
  return registry.routes.find((route) => route.operations.includes(operation))
}

function compatibilityMetadata(route) {
  return Object.freeze({
    routeId: route.routeId,
    providerId: route.providerId,
    providerFailureDomainId: route.providerFailureDomainId,
    model: route.model,
    externalAttempts: 1,
    fallback: 'none',
    policyEligible: false,
  })
}

function answerInput() {
  return Object.freeze({
    input: [`<question>${SYNTHETIC_QUESTION}</question>`, ...SYNTHETIC_EVIDENCE_BLOCKS.map(({ text }) => text)].join('\n'),
    citationIds: Object.freeze(['C1']),
    evidenceBlocks: SYNTHETIC_EVIDENCE_BLOCKS,
  })
}

function supportInput() {
  const evidenceMap = Object.freeze({ E1: 'C1' })
  return Object.freeze({
    input: JSON.stringify({ question: SYNTHETIC_QUESTION, evidenceBlocks: SYNTHETIC_EVIDENCE_BLOCKS, evidenceMap, paragraphs: SYNTHETIC_PARAGRAPHS }),
    evidenceBlocks: SYNTHETIC_EVIDENCE_BLOCKS,
    evidenceMap,
    paragraphs: SYNTHETIC_PARAGRAPHS,
  })
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    console.log(JSON.stringify(await runDeepSeekV4FlashSmoke({ mode: process.argv[2] ?? 'full' })))
  } catch (error) {
    console.error(JSON.stringify({ ok: false, error: 'deepseek_v4_flash_smoke_failed', stage: error.smokeStage, code: error.code, ...(error.upstreamStatus ? { upstreamStatus: error.upstreamStatus } : {}) }))
    process.exitCode = 1
  }
}
