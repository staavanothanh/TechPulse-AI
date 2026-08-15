import { createHash, randomUUID } from 'node:crypto'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { pathToFileURL } from 'node:url'
import { validateEmbeddingVector } from '../server/ai/embedding.js'
import { DEFAULT_CHAT_TIMEOUT_MS, createConfiguredProviderAdapters } from '../server/ai/provider-adapters.js'
import { createProviderRouter } from '../server/ai/provider-router.js'
import { validateProviderConfiguration } from '../server/ai/provider-registry.js'
import { retrievalFixtureDigest, runRetrievalEvaluation, DEFAULT_RETRIEVAL_FIXTURE_PATH } from '../server/evals/retrieval.js'
import { validateVietnameseSummary } from '../server/ai/summary.js'

const BENCHMARK_ITEMS = [
  ['q-chip-ai', 'chip AI tiết kiệm năng lượng cho trung tâm dữ liệu'],
  ['q-ai-safety', 'đánh giá an toàn mô hình trí tuệ nhân tạo'],
  ['q-vietnamese-model', 'mô hình ngôn ngữ tiếng Việt mã nguồn mở'],
  ['q-cloud', 'cập nhật hạ tầng điện toán đám mây'],
  ['q-robot', 'nghiên cứu robot học từ quan sát'],
  ['q-security', 'bản vá bảo mật phần mềm quan trọng'],
  ['doc-chip-ai', 'Bộ tăng tốc AI mới giảm điện năng tại trung tâm dữ liệu mà vẫn giữ hiệu năng xử lý.'],
  ['doc-ai-safety', 'Nhóm nghiên cứu công bố quy trình đánh giá an toàn cho mô hình trí tuệ nhân tạo.'],
  ['doc-vietnamese-model', 'Dự án công bố mô hình ngôn ngữ tiếng Việt mã nguồn mở cho nghiên cứu và giáo dục.'],
  ['doc-cloud', 'Nhà cung cấp cập nhật hạ tầng điện toán đám mây với lớp điều phối mới.'],
  ['doc-robot', 'Bài báo trình bày phương pháp để robot học kỹ năng từ quan sát có kiểm soát.'],
  ['doc-security', 'Bản vá bảo mật khắc phục lỗ hổng nghiêm trọng trong phần mềm máy chủ.'],
  ['doc-distractor-1', 'Báo cáo thị trường thiết bị di động trong quý mới nhất.'],
  ['doc-distractor-2', 'Hướng dẫn thiết kế giao diện cho ứng dụng nội bộ.'],
  ['doc-distractor-3', 'Tin tức về hội nghị cộng đồng lập trình cuối tuần.'],
  ['doc-distractor-4', 'Bài viết giới thiệu lịch sử của mạng máy tính.'],
  ['doc-distractor-5', 'Tổng hợp công cụ kiểm thử giao diện người dùng.'],
  ['doc-distractor-6', 'Ghi chú về tối ưu hóa bộ nhớ trong ứng dụng JavaScript.'],
]

function hash(value) {
  return createHash('sha256').update(value).digest('hex')
}

function nonEmptyEnvironmentNames(environment) {
  return Object.keys(environment).filter((name) => typeof environment[name] === 'string' && environment[name].length > 0)
}

export function parseSmokeRegistry(environment = process.env, { now = new Date() } = {}) {
  let graph
  try { graph = JSON.parse(environment.PROVIDER_ADMISSION_DOMAINS_JSON || '[]') } catch { throw Object.assign(new Error('smoke_provider_graph_invalid'), { code: 'smoke_provider_graph_invalid' }) }
  try {
    return validateProviderConfiguration(graph, { now, credentialEnvNames: nonEmptyEnvironmentNames(environment) })
  } catch (error) {
    throw Object.assign(new Error('smoke_provider_graph_invalid', { cause: error }), { code: 'smoke_provider_graph_invalid' })
  }
}

function configuredWorkload(registry, operation, environment) {
  const overrideName = `STEP9_${operation.toUpperCase()}_WORKLOAD_ID`
  const override = environment[overrideName]
  const policy = override
    ? registry.workloadPolicies.find((item) => item.workloadId === override && item.operation === operation)
    : registry.workloadPolicies.find((item) => item.operation === operation)
  if (!policy) throw Object.assign(new Error(`smoke_${operation}_workload_unavailable`), { code: 'smoke_workload_unavailable' })
  const route = registry.routes.find((item) => item.routeId === policy.primaryRouteId)
  if (!route) throw Object.assign(new Error('smoke_route_unavailable'), { code: 'smoke_route_unavailable' })
  return Object.freeze({
    workloadId: policy.workloadId,
    operation,
    routeId: route.routeId,
    providerId: route.providerId,
    providerFailureDomainId: route.providerFailureDomainId,
    model: route.model,
    trustedEndpointProfileId: route.trustedEndpointProfileId,
    artifactCompatibilityId: route.artifactCompatibilityId,
    embeddingDimensions: route.embeddingDimensions,
    embeddingVersion: route.embeddingVersion,
  })
}

export function createSmokePlan(registry, { environment = process.env, summary = true, embedding = true } = {}) {
  return Object.freeze({
    ...(summary ? { summary: configuredWorkload(registry, 'summary', environment) } : {}),
    ...(embedding ? { embedding: configuredWorkload(registry, 'embedding', environment) } : {}),
  })
}

export function createSmokeAdmission(registry) {
  const routes = new Map((registry?.routes ?? []).map((route) => [route.routeId, route]))
  return Object.freeze({
    getRoute(routeId) {
      return routes.get(routeId) ?? null
    },
    async admitProviderDomain({ routeId } = {}) {
      return routes.has(routeId) ? { allowed: true, reservationId: randomUUID() } : { allowed: false, reason: 'route-unavailable' }
    },
    async reportProviderDomain() {
      return true
    },
    async run({ routeId, invoke } = {}) {
      const route = routes.get(routeId)
      if (!route || typeof invoke !== 'function') throw Object.assign(new Error('smoke_route_unavailable'), { code: 'smoke_route_unavailable' })
      return invoke(route)
    },
  })
}

function parseSmokeMode(mode) {
  if (!['--summary-only', '--embedding-only', '--full'].includes(mode)) throw Object.assign(new Error('smoke_mode_invalid'), { code: 'smoke_mode_invalid' })
  return Object.freeze({ mode, summary: mode !== '--embedding-only', embedding: mode !== '--summary-only' })
}

function summaryInput() {
  return '<external-source-data>\n{"sourceName":"Kiem thu noi bo","titleOriginal":"He thong lam mat moi giam dien nang cho trung tam du lieu","excerptOriginal":"Du lieu tong hop an toan chi dung de kiem thu tom tat tieng Viet."}\n</external-source-data>'
}

function validateSummaryOutput({ output }) {
  try {
    return validateVietnameseSummary({ titleVi: output?.titleVi, summaryVi: output?.summaryVi })
  } catch (error) {
    const message = String(error?.message ?? '')
    error.summaryValidation = true
    error.summaryCategory = /shape/i.test(message) ? 'summary_shape_invalid' : /Vietnamese/i.test(message) ? 'summary_language_invalid' : 'summary_length_invalid'
    throw error
  }
}

function validateEmbeddingOutput({ route, output, admittedInput }) {
  if (!output || output.model !== route.model || !Array.isArray(output.embeddings) || output.embeddings.length !== admittedInput.inputs.length) throw Object.assign(new Error('embedding_batch_invalid'), { code: 'embedding_batch_invalid' })
  output.embeddings.forEach((embedding) => validateEmbeddingVector(embedding, { dimensions: route.embeddingDimensions }))
  return Object.freeze({ model: route.model, embeddings: Object.freeze(output.embeddings.map((embedding) => Object.freeze([...embedding]))) })
}

function fixtureFor({ plan, batch, dimensions, version, generatedAt }) {
  const vectors = new Map(BENCHMARK_ITEMS.map(([id], index) => [id, batch.embeddings[index]]))
  const hashes = new Map(BENCHMARK_ITEMS.map(([id, text]) => [id, hash(text)]))
  const queryIds = BENCHMARK_ITEMS.slice(0, 6).map(([id]) => id)
  const documentIds = BENCHMARK_ITEMS.slice(6).map(([id]) => id)
  const value = {
    fixtureVersion: 'configured-retrieval-v1',
    provenance: {
      providerId: plan.providerId,
      endpointId: plan.trustedEndpointProfileId,
      model: plan.model,
      dimensions,
      embeddingVersion: version,
      artifactCompatibilityId: plan.artifactCompatibilityId,
      generatedAt,
      inputIds: BENCHMARK_ITEMS.map(([id]) => ({ id, hash: hashes.get(id) })),
    },
    queries: queryIds.map((id) => ({ id, inputHash: hashes.get(id), embedding: vectors.get(id) })),
    documents: documentIds.map((id) => ({ id, inputHash: hashes.get(id), embedding: vectors.get(id) })),
    cases: queryIds.map((id) => ({ queryId: id, targetId: `doc-${id.slice(2)}` })),
  }
  return Object.freeze({ ...value, fixtureDigest: retrievalFixtureDigest(value) })
}

function defaultWriteFixture(path, fixture) {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, `${JSON.stringify(fixture)}\n`, { encoding: 'utf8', mode: 0o600 })
}

export async function runSmoke({ mode = '--summary-only', environment = process.env, fetchImpl = globalThis.fetch, now = () => new Date(), writeFixture = defaultWriteFixture } = {}) {
  const selected = parseSmokeMode(mode)
  const clock = typeof now === 'function' ? now : () => now
  let stage = 'configuration'
  try {
    const registry = parseSmokeRegistry(environment, { now: clock() })
    const plan = createSmokePlan(registry, { environment, summary: selected.summary, embedding: selected.embedding })
    const adapters = createConfiguredProviderAdapters({
      registry,
      fetchImpl,
      summaryTimeoutMs: DEFAULT_CHAT_TIMEOUT_MS,
      resolveCredential: (name) => environment[name],
    })
    const router = createProviderRouter({ workloadPolicies: registry.workloadPolicies, admission: createSmokeAdmission(registry), now: clock })
    let summaryResult
    if (selected.summary) {
      stage = 'summary'
      summaryResult = await router.execute({
        workloadId: plan.summary.workloadId,
        admittedInput: Object.freeze({ input: summaryInput(), locale: 'vi', tools: Object.freeze([]) }),
        attemptId: randomUUID(),
        invoke: ({ route, admittedInput }) => adapters.llmProvider.summarize({ route, ...admittedInput }),
        validateOutput: validateSummaryOutput,
      })
    }
    if (!selected.embedding) return Object.freeze({ ok: true, outboundRequests: summaryResult.metadata.externalAttempts, summary: summaryResult.metadata })

    stage = 'embedding'
    const inputs = BENCHMARK_ITEMS.map(([, text]) => text)
    const embeddingResult = await router.execute({
      workloadId: plan.embedding.workloadId,
      admittedInput: Object.freeze({ inputs: Object.freeze(inputs) }),
      attemptId: randomUUID(),
      invoke: ({ route, admittedInput }) => adapters.embeddingProvider.embedBatch({ route, inputs: admittedInput.inputs, model: route.model, dimensions: route.embeddingDimensions }),
      validateOutput: validateEmbeddingOutput,
    })
    const embeddingRoute = registry.routes.find(({ routeId }) => routeId === embeddingResult.metadata.routeId)
    if (!embeddingRoute) throw Object.assign(new Error('smoke_route_unavailable'), { code: 'smoke_route_unavailable' })
    const resolvedEmbedding = Object.freeze({
      ...embeddingResult.metadata,
      trustedEndpointProfileId: embeddingRoute.trustedEndpointProfileId,
      artifactCompatibilityId: embeddingRoute.artifactCompatibilityId,
    })
    const dimensions = embeddingRoute.embeddingDimensions
    const version = embeddingRoute.embeddingVersion
    const fixture = fixtureFor({ plan: resolvedEmbedding, batch: embeddingResult.output, dimensions, version, generatedAt: clock().toISOString() })
    stage = 'fixture'
    const fixturePath = environment.STEP9_RETRIEVAL_FIXTURE_PATH || DEFAULT_RETRIEVAL_FIXTURE_PATH
    await writeFixture(fixturePath, fixture)
    const evaluation = runRetrievalEvaluation({ fixture, embeddingSpec: fixture.provenance })
    return Object.freeze({
      ok: evaluation.passed,
      outboundRequests: (summaryResult?.metadata.externalAttempts ?? 0) + embeddingResult.metadata.externalAttempts,
      ...(summaryResult ? { summary: { ...summaryResult.metadata, structuredVietnamese: true } } : {}),
      embedding: { ...embeddingResult.metadata, dimensions, version, batchSize: inputs.length, artifactCompatibilityId: embeddingRoute.artifactCompatibilityId },
      benchmark: { fixtureVersion: fixture.fixtureVersion, fixtureDigest: fixture.fixtureDigest, top5Rate: evaluation.top5Rate, passed: evaluation.passed },
    })
  } catch (error) {
    error.smokeStage = stage
    throw error
  }
}

function isMainModule() {
  return process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href
}

function reportFailure(error) {
  const code = error?.summaryValidation === true
    ? error.summaryCategory
    : typeof error?.code === 'string' && /^[a-z_]{1,64}$/.test(error.code) ? error.code : 'unexpected'
  console.error(JSON.stringify({ ok: false, error: 'real_provider_smoke_failed', stage: error?.smokeStage ?? 'configuration', code }))
  process.exitCode = 1
}

if (isMainModule()) {
  const mode = process.argv[2] ?? '--summary-only'
  try {
    const report = await runSmoke({ mode })
    console.log(JSON.stringify(report))
    if (!report.ok) process.exitCode = 1
  } catch (error) {
    reportFailure(error)
  }
}
