import { randomUUID } from 'node:crypto'
import { pathToFileURL } from 'node:url'
import { validateParagraphCitations } from '../server/domain/qa/citations.js'
import { validateVietnameseSummary } from '../server/ai/summary.js'
import { ProviderAdapterError } from '../server/ai/provider-error-taxonomy.js'
import { createConfiguredProviderAdapters } from '../server/ai/provider-adapters.js'
import { validateProviderConfiguration } from '../server/ai/provider-registry.js'
import { createProviderRouter } from '../server/ai/provider-router.js'

const LLM_WORKLOADS = Object.freeze([
  Object.freeze({ key: 'summary', workloadId: 'summary', operation: 'summary' }),
  Object.freeze({ key: 'answer', workloadId: 'qa-generation', operation: 'answer' }),
  Object.freeze({ key: 'support', workloadId: 'qa-support', operation: 'support' }),
])

const MODE_NAMES = new Set(['summary', 'answer', 'support', 'full'])
const SAFE_CODE = /^[a-z][a-z0-9_]{0,63}$/

function safeError(code) {
  const error = new Error(code)
  error.code = code
  return error
}

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value
  for (const nested of Object.values(value)) deepFreeze(nested)
  return Object.freeze(value)
}

function parseMode(mode = 'full') {
  if (typeof mode !== 'string') throw safeError('gemini_smoke_mode_invalid')
  const normalized = mode.trim().toLowerCase().replace(/^--/, '')
  const aliases = {
    'summary-only': 'summary',
    'answer-only': 'answer',
    'support-only': 'support',
  }
  const selected = aliases[normalized] ?? normalized
  if (!MODE_NAMES.has(selected)) throw safeError('gemini_smoke_mode_invalid')
  return Object.freeze({
    mode: selected,
    summary: selected === 'summary' || selected === 'full',
    answer: selected === 'answer' || selected === 'full',
    support: selected === 'support' || selected === 'full',
  })
}

function parseGraph(environment) {
  if (!environment || typeof environment !== 'object') throw safeError('gemini_provider_graph_invalid')
  const encoded = environment.PROVIDER_ADMISSION_DOMAINS_JSON
  if (typeof encoded !== 'string' || encoded.trim() === '') throw safeError('gemini_provider_graph_invalid')
  try {
    return JSON.parse(encoded)
  } catch {
    throw safeError('gemini_provider_graph_invalid')
  }
}

function validationOptions({ now, installedAdapters, trustedEndpointProfiles }) {
  return {
    now,
    ...(installedAdapters === undefined ? {} : { installedAdapters }),
    ...(trustedEndpointProfiles === undefined ? {} : { trustedEndpointProfiles }),
  }
}

export function parseGeminiRegistry(environment = process.env, options = {}) {
  const graph = parseGraph(environment)
  try {
    const rawNow = options.now ?? new Date()
    const now = typeof rawNow === 'function' ? rawNow() : rawNow
    return validateProviderConfiguration(graph, validationOptions({
      now,
      installedAdapters: options.installedAdapters,
      trustedEndpointProfiles: options.trustedEndpointProfiles,
    }))
  } catch {
    throw safeError('gemini_provider_graph_invalid')
  }
}

function routeFor(registry, routeId) {
  return registry.routes.find((route) => route.routeId === routeId) ?? null
}

function policyFor(registry, descriptor) {
  const policy = registry.workloadPolicies.find((item) => item.workloadId === descriptor.workloadId)
  if (!policy || policy.operation !== descriptor.operation) throw safeError('gemini_workload_unavailable')
  const route = routeFor(registry, policy.primaryRouteId)
  if (!route || !route.operations.includes(descriptor.operation)) throw safeError('gemini_route_unavailable')
  return Object.freeze({
    workloadId: policy.workloadId,
    operation: policy.operation,
    routeId: route.routeId,
    providerId: route.providerId,
    providerFailureDomainId: route.providerFailureDomainId,
    model: route.model,
    trustedEndpointProfileId: route.trustedEndpointProfileId,
    fallbackRouteIds: Object.freeze([...policy.modelFallbackRouteIds, ...policy.providerFallbackRouteIds]),
  })
}

export function createGeminiSmokePlan(registry, selected = {}) {
  if (!registry || !Array.isArray(registry.workloadPolicies) || !Array.isArray(registry.routes)) throw safeError('gemini_provider_graph_invalid')
  const descriptors = LLM_WORKLOADS.filter(({ key }) => selected[key] !== false)
  if (descriptors.length === 0) throw safeError('gemini_smoke_mode_invalid')
  return deepFreeze(Object.fromEntries(descriptors.map((descriptor) => [descriptor.key, policyFor(registry, descriptor)])))
}

function credentialNamesForPlan(registry, plan) {
  const domains = new Map((registry.admissionDomains ?? registry.domains ?? []).map((domain) => [domain.admissionDomainId, domain]))
  const routes = new Map((registry.routes ?? []).map((route) => [route.routeId, route]))
  const policies = new Map((registry.workloadPolicies ?? []).map((policy) => [policy.workloadId, policy]))
  const names = new Set()
  for (const item of Object.values(plan)) {
    const policy = policies.get(item.workloadId)
    const routeIds = [policy.primaryRouteId, ...policy.modelFallbackRouteIds, ...policy.providerFallbackRouteIds]
    for (const routeId of routeIds) {
      const route = routes.get(routeId)
      const domain = route ? domains.get(route.admissionDomainId) : null
      if (!domain || typeof domain.credentialEnvName !== 'string') throw safeError('gemini_credential_unavailable')
      names.add(domain.credentialEnvName)
    }
  }
  return names
}

function assertCredentials(environment, registry, plan) {
  for (const name of credentialNamesForPlan(registry, plan)) {
    if (typeof environment?.[name] !== 'string' || environment[name].length < 1) throw safeError('gemini_credential_unavailable')
  }
}

export function createGeminiSmokeAdmission(registry) {
  const routes = new Map((registry?.routes ?? []).map((route) => [route.routeId, route]))
  return Object.freeze({
    getRoute(routeId) {
      return routes.get(routeId) ?? null
    },
    async admitProviderDomain({ routeId, attemptId } = {}) {
      if (!routes.has(routeId) || typeof attemptId !== 'string' || attemptId.length < 1) return Object.freeze({ allowed: false, reason: 'route-unavailable' })
      return Object.freeze({ allowed: true, reservationId: randomUUID() })
    },
    async reportProviderDomain() {
      return true
    },
    async run({ routeId, invoke } = {}) {
      const route = routes.get(routeId)
      if (!route || typeof invoke !== 'function') throw safeError('gemini_route_unavailable')
      return invoke(route)
    },
  })
}

const SYNTHETIC_SUMMARY_INPUT = '<external-source-data>\n{"sourceName":"Synthetic smoke source","titleOriginal":"He thong lam mat moi","excerptOriginal":"Du lieu tong hop an toan cho smoke test."}\n</external-source-data>'
const SYNTHETIC_QUESTION = 'Du lieu trong nguon co an toan cho smoke test khong?'
const SYNTHETIC_EVIDENCE_BLOCKS = Object.freeze([
  Object.freeze({ id: 'E1', citationId: 'C1', text: '<evidence-block id="E1" citation="C1">Du lieu trong nguon la synthetic an toan cho smoke test.</evidence-block>' }),
])
const SYNTHETIC_PARAGRAPHS = Object.freeze([
  Object.freeze({ text: 'Du lieu trong nguon la synthetic an toan cho smoke test.', citationIds: Object.freeze(['C1']), evidenceBlockIds: Object.freeze(['E1']) }),
])

function summaryInput() {
  return Object.freeze({ input: SYNTHETIC_SUMMARY_INPUT, locale: 'vi', tools: Object.freeze([]) })
}

function answerInput() {
  const input = [
    `<question>${SYNTHETIC_QUESTION}</question>`,
    ...SYNTHETIC_EVIDENCE_BLOCKS.map(({ text }) => text),
  ].join('\n')
  return Object.freeze({
    input,
    locale: 'vi',
    tools: Object.freeze([]),
    question: SYNTHETIC_QUESTION,
    citationIds: Object.freeze(['C1']),
    evidenceBlocks: SYNTHETIC_EVIDENCE_BLOCKS,
  })
}

function supportInput() {
  const evidenceMap = Object.freeze({ E1: 'C1' })
  const input = JSON.stringify({
    question: SYNTHETIC_QUESTION,
    evidenceBlocks: SYNTHETIC_EVIDENCE_BLOCKS,
    evidenceMap,
    paragraphs: SYNTHETIC_PARAGRAPHS,
  })
  return Object.freeze({
    input,
    locale: 'vi',
    tools: Object.freeze([]),
    question: SYNTHETIC_QUESTION,
    evidenceBlocks: SYNTHETIC_EVIDENCE_BLOCKS,
    evidenceMap,
    paragraphs: SYNTHETIC_PARAGRAPHS,
  })
}

export function validateGeminiSummaryOutput({ output } = {}) {
  try {
    return validateVietnameseSummary({ titleVi: output?.titleVi, summaryVi: output?.summaryVi })
  } catch {
    throw new ProviderAdapterError('schema')
  }
}

export function validateGeminiAnswerOutput({ output, admittedInput } = {}) {
  if (!output || typeof output !== 'object' || Array.isArray(output) || (output.status !== undefined && output.status !== 'answered') || !Array.isArray(output.paragraphs)) throw new ProviderAdapterError('schema')
  let paragraphs
  try {
    paragraphs = validateParagraphCitations({
      paragraphs: output.paragraphs,
      citationIds: admittedInput?.citationIds,
      evidenceBlocks: admittedInput?.evidenceBlocks,
    })
  } catch {
    throw new ProviderAdapterError('schema')
  }
  return Object.freeze({ status: 'answered', paragraphs })
}

export function validateGeminiSupportOutput({ output, admittedInput } = {}) {
  if (!output || typeof output !== 'object' || Array.isArray(output) || output.verdict !== 'supported' || output.addressesQuestion !== true || !Array.isArray(output.evidenceBlockIds)) throw new ProviderAdapterError('support')
  const expected = (admittedInput?.evidenceBlocks ?? []).map(({ id }) => id)
  const actual = output.evidenceBlockIds
  if (actual.length !== expected.length || new Set(actual).size !== expected.length || expected.some((id) => !actual.includes(id))) throw new ProviderAdapterError('support')
  return Object.freeze({ verdict: 'supported', addressesQuestion: true, evidenceBlockIds: Object.freeze([...actual]) })
}

function executeWorkload(router, { plan, key, admittedInput, invoke, validateOutput }) {
  return router.execute({
    workloadId: plan[key].workloadId,
    admittedInput,
    attemptId: randomUUID(),
    invoke,
    validateOutput,
  })
}

function stageError(error, stage) {
  const code = typeof error?.code === 'string' && SAFE_CODE.test(error.code) ? error.code : 'gemini_smoke_failed'
  const safe = new Error('Gemini LLM smoke failed safely')
  safe.code = code
  safe.smokeStage = stage
  if (typeof error?.failureClass === 'string' && SAFE_CODE.test(error.failureClass)) safe.failureClass = error.failureClass
  if (error?.retryable === true) safe.retryable = true
  if (Number.isInteger(error?.upstreamStatus) && error.upstreamStatus >= 400 && error.upstreamStatus <= 599) safe.upstreamStatus = error.upstreamStatus
  return safe
}

export async function runGeminiLlmSmoke({ mode = 'full', environment = process.env, fetchImpl = globalThis.fetch, now = () => new Date(), installedAdapters, trustedEndpointProfiles } = {}) {
  const selected = parseMode(mode)
  const clock = typeof now === 'function' ? now : () => now
  let stage = 'configuration'
  try {
    const registry = parseGeminiRegistry(environment, { now: clock(), installedAdapters, trustedEndpointProfiles })
    const plan = createGeminiSmokePlan(registry, selected)
    assertCredentials(environment, registry, plan)
    const adapters = createConfiguredProviderAdapters({
      registry,
      fetchImpl,
      resolveCredential: (name) => environment[name],
      ...(trustedEndpointProfiles === undefined ? {} : { trustedEndpointProfiles }),
    })
    const router = createProviderRouter({ workloadPolicies: registry.workloadPolicies, admission: createGeminiSmokeAdmission(registry), now: clock })
    const report = { ok: true, mode: selected.mode, outboundRequests: 0 }

    if (selected.summary) {
      stage = 'summary'
      const result = await executeWorkload(router, {
        plan,
        key: 'summary',
        admittedInput: summaryInput(),
        invoke: ({ route, admittedInput }) => adapters.llmProvider.summarize({ route, input: admittedInput.input, locale: admittedInput.locale, tools: admittedInput.tools }),
        validateOutput: validateGeminiSummaryOutput,
      })
      report.summary = result.metadata
      report.outboundRequests += result.metadata.externalAttempts
    }

    if (selected.answer) {
      stage = 'answer'
      const result = await executeWorkload(router, {
        plan,
        key: 'answer',
        admittedInput: answerInput(),
        invoke: ({ route, admittedInput }) => adapters.llmProvider.answer({ route, input: admittedInput.input, locale: admittedInput.locale, tools: admittedInput.tools }),
        validateOutput: validateGeminiAnswerOutput,
      })
      report.answer = result.metadata
      report.outboundRequests += result.metadata.externalAttempts
    }

    if (selected.support) {
      stage = 'support'
      const result = await executeWorkload(router, {
        plan,
        key: 'support',
        admittedInput: supportInput(),
        invoke: ({ route, admittedInput }) => adapters.llmProvider.verifySupport({ route, input: admittedInput.input, locale: admittedInput.locale, tools: admittedInput.tools }),
        validateOutput: validateGeminiSupportOutput,
      })
      report.support = result.metadata
      report.outboundRequests += result.metadata.externalAttempts
    }

    return deepFreeze(report)
  } catch (error) {
    throw stageError(error, error?.smokeStage ?? stage)
  }
}

export const parseGeminiSmokeMode = parseMode
export const parseSmokeMode = parseMode
export const parseGeminiSmokeRegistry = parseGeminiRegistry
export const parseGeminiProviderGraph = parseGeminiRegistry
export const parseSmokeRegistry = parseGeminiRegistry
export const createSmokePlan = createGeminiSmokePlan
export const createSmokeAdmission = createGeminiSmokeAdmission
export const runGeminiSmoke = runGeminiLlmSmoke
export const runSmoke = runGeminiLlmSmoke
export const validateSummaryOutput = validateGeminiSummaryOutput
export const validateAnswerOutput = validateGeminiAnswerOutput
export const validateSupportOutput = validateGeminiSupportOutput

function isMainModule() {
  return process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href
}

if (isMainModule()) {
  try {
    const report = await runGeminiLlmSmoke({ mode: process.argv[2] ?? 'full' })
    console.log(JSON.stringify(report))
    if (!report.ok) process.exitCode = 1
  } catch (error) {
    const code = typeof error?.code === 'string' && SAFE_CODE.test(error.code) ? error.code : 'gemini_smoke_failed'
    console.error(JSON.stringify({ ok: false, error: 'gemini_llm_smoke_failed', stage: error?.smokeStage ?? 'configuration', code }))
    process.exitCode = 1
  }
}
