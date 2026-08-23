import { pathToFileURL } from 'node:url'
import { validateProviderConfiguration } from '../server/ai/provider-registry.js'
import {
  parseGeminiSmokeMode,
  runGeminiLlmSmoke,
} from './gemini-llm-smoke.js'

const MODEL = 'deepseek-v4-flash'
const CREDENTIAL_ENV = 'DEEPSEEK_API_KEY'
const EVIDENCE_URL = 'https://api-docs.deepseek.com/quick_start/pricing/'
const REVIEWED_AT = '2026-08-23T00:00:00.000Z'
const EVIDENCE_EXPIRES_AT = '2026-11-21T00:00:00.000Z'
const SAFE_CODE = /^[a-z][a-z0-9_]{0,63}$/

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
      { workloadId: 'qa-generation', operation: 'answer', requiredCapability: 'nonconfidential', maxExternalAttempts: 2, primaryRouteId: 'deepseek-answer', modelFallbackRouteIds: [], providerFallbackRouteIds: [] },
      { workloadId: 'qa-support', operation: 'support', requiredCapability: 'nonconfidential', maxExternalAttempts: 1, primaryRouteId: 'deepseek-support', modelFallbackRouteIds: [], providerFallbackRouteIds: [] },
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
    validateProviderConfiguration(graph, { now: clock() })
    const report = { ok: true, mode: selected.mode, outboundRequests: 0 }

    if (selected.summary) {
      stage = 'summary'
      const summaryReport = await runGeminiLlmSmoke({ mode: 'summary', environment: smokeEnvironment, fetchImpl, now: clock })
      report.summary = summaryReport.summary
      report.outboundRequests += summaryReport.outboundRequests
    }

    if (selected.answer) {
      stage = 'answer'
      const answerReport = await runGeminiLlmSmoke({ mode: 'answer', environment: smokeEnvironment, fetchImpl, now: clock })
      report.answer = { ...answerReport.answer, policyEligible: true }
      report.outboundRequests += answerReport.outboundRequests
    }

    if (selected.support) {
      stage = 'support'
      const supportReport = await runGeminiLlmSmoke({ mode: 'support', environment: smokeEnvironment, fetchImpl, now: clock })
      report.support = { ...supportReport.support, policyEligible: true }
      report.outboundRequests += supportReport.outboundRequests
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

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    console.log(JSON.stringify(await runDeepSeekV4FlashSmoke({ mode: process.argv[2] ?? 'full' })))
  } catch (error) {
    console.error(JSON.stringify({ ok: false, error: 'deepseek_v4_flash_smoke_failed', stage: error.smokeStage, code: error.code, ...(error.upstreamStatus ? { upstreamStatus: error.upstreamStatus } : {}) }))
    process.exitCode = 1
  }
}
