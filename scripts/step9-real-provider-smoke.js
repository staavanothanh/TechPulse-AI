import { createHash } from 'node:crypto'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { validateBgeM3Embedding } from '../server/ai/embedding.js'
import { createConfiguredProviderAdapters, ZEN_SUMMARY_TIMEOUT_MS } from '../server/ai/provider-adapters.js'
import { validateProviderConfiguration } from '../server/ai/provider-registry.js'
import { retrievalFixtureDigest, runRetrievalEvaluation, BGE_M3_VI_FIXTURE_PATH } from '../server/evals/retrieval.js'
import { validateVietnameseSummary } from '../server/ai/summary.js'

const SUMMARY_MODEL = 'deepseek-v4-flash-free'
const EMBEDDING_MODEL = 'baai/bge-m3'
const mode = process.argv[2] ?? '--summary-only'
const summaryOnly = mode === '--summary-only'
const embeddingOnly = mode === '--embedding-only'
const fullSmoke = mode === '--full'

const benchmarkItems = [
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

function routeFor(registry, provider, model) {
  return registry.routes.find((route) => route.provider === provider && route.model === model && route.enabled)
}

function credentialEnvName(value) {
  if (typeof value !== 'string' || !/^[A-Z][A-Z0-9_]{1,127}$/.test(value)) throw Object.assign(new Error('smoke_credential_binding_invalid'), { code: 'smoke_credential_binding_invalid' })
  return value
}

function smokeRegistry() {
  const reviewedAt = new Date()
  const evidenceExpiresAt = new Date(reviewedAt.getTime() + 24 * 60 * 60 * 1000)
  return validateProviderConfiguration([
    {
      admissionDomainId: 'smoke-opencode-zen', provider: 'opencode-zen', credentialEnvName: credentialEnvName(process.env.LLM_PRIMARY_API_KEY_ENV), maxConcurrency: 1, budgetLimit: 2, budgetWindow: 'day',
      routes: [{ routeId: 'smoke-zen-summary', admissionDomainId: 'smoke-opencode-zen', model: SUMMARY_MODEL, capability: 'nonconfidential', enabled: true, evidenceUrl: 'https://dev.opencode.ai/docs/zen', reviewedAt: reviewedAt.toISOString(), evidenceExpiresAt: evidenceExpiresAt.toISOString(), retryableFailureThreshold: 3, cooldownSeconds: 60 }],
    },
    {
      admissionDomainId: 'smoke-openrouter', provider: 'openrouter', credentialEnvName: credentialEnvName(process.env.EMBEDDING_API_KEY_ENV), maxConcurrency: 1, budgetLimit: 2, budgetWindow: 'day',
      routes: [{ routeId: 'smoke-bge-m3', admissionDomainId: 'smoke-openrouter', model: EMBEDDING_MODEL, capability: 'nonconfidential', enabled: true, evidenceUrl: 'https://openrouter.ai/baai/bge-m3/api', reviewedAt: reviewedAt.toISOString(), evidenceExpiresAt: evidenceExpiresAt.toISOString(), retryableFailureThreshold: 3, cooldownSeconds: 60 }],
    },
  ], { now: reviewedAt })
}

function reportFailure(stage, error) {
  const code = error?.summaryValidation === true
    ? error.summaryCategory
    : typeof error?.code === 'string' && /^[a-z_]{1,64}$/.test(error.code) ? error.code : 'unexpected'
  console.error(JSON.stringify({ ok: false, error: 'real_provider_smoke_failed', stage, code }))
  process.exitCode = 1
}

let stage = 'configuration'
try {
  if (!summaryOnly && !embeddingOnly && !fullSmoke) throw Object.assign(new Error('smoke_mode_invalid'), { code: 'smoke_mode_invalid' })
  const registry = smokeRegistry()
  const summaryRoute = routeFor(registry, 'opencode-zen', SUMMARY_MODEL)
  const embeddingRoute = routeFor(registry, 'openrouter', EMBEDDING_MODEL)
  if (!summaryRoute || !embeddingRoute) throw Object.assign(new Error('configured_routes_unavailable'), { code: 'configured_routes_unavailable' })
  const adapters = createConfiguredProviderAdapters({ registry, summaryTimeoutMs: ZEN_SUMMARY_TIMEOUT_MS })
  const summaryInput = '<external-source-data>\n{"sourceName":"Kiem thu noi bo","titleOriginal":"He thong lam mat moi giam dien nang cho trung tam du lieu","excerptOriginal":"Du lieu tong hop an toan chi dung de kiem thu tom tat tieng Viet."}\n</external-source-data>'
  if (!embeddingOnly) {
    stage = 'summary'
    const summaryResult = await adapters.llmProvider.summarize({ route: summaryRoute, input: summaryInput, locale: 'vi', tools: [] })
    try {
      validateVietnameseSummary({ titleVi: summaryResult.titleVi, summaryVi: summaryResult.summaryVi })
    } catch (error) {
      const message = String(error?.message ?? '')
      error.summaryValidation = true
      error.summaryCategory = /shape/i.test(message) ? 'summary_shape_invalid' : /Vietnamese/i.test(message) ? 'summary_language_invalid' : 'summary_length_invalid'
      throw error
    }
    if (summaryOnly) {
      console.log(JSON.stringify({ ok: true, outboundRequests: 1, providerId: 'opencode-zen', model: SUMMARY_MODEL, providerGate: 'step9_provider_pass' }))
      process.exit(0)
    }
  }
  stage = 'embedding'
  const batch = await adapters.embeddingProvider.embedBatch({ route: embeddingRoute, inputs: benchmarkItems.map(([, text]) => text), model: EMBEDDING_MODEL, dimensions: 1024 })
  if (batch.embeddings.length !== benchmarkItems.length) throw new Error('embedding_batch_invalid')
  for (const embedding of batch.embeddings) validateBgeM3Embedding({ model: batch.model, embedding })

  const generatedAt = new Date().toISOString()
  const vectors = new Map(benchmarkItems.map(([id], index) => [id, batch.embeddings[index]]))
  const hashes = new Map(benchmarkItems.map(([id, text]) => [id, hash(text)]))
  const queryIds = benchmarkItems.slice(0, 6).map(([id]) => id)
  const documentIds = benchmarkItems.slice(6).map(([id]) => id)
  stage = 'fixture'
  const fixtureValue = {
    fixtureVersion: 'bge-m3-vi-real-v1',
    provenance: {
      providerId: 'openrouter', endpointId: 'openrouter-embeddings', model: EMBEDDING_MODEL, dimensions: 1024, embeddingVersion: 1, generatedAt,
      inputIds: benchmarkItems.map(([id]) => ({ id, hash: hashes.get(id) })),
    },
    queries: queryIds.map((id) => ({ id, inputHash: hashes.get(id), embedding: vectors.get(id) })),
    documents: documentIds.map((id) => ({ id, inputHash: hashes.get(id), embedding: vectors.get(id) })),
    cases: queryIds.map((id) => ({ queryId: id, targetId: `doc-${id.slice(2)}` })),
  }
  const fixture = { ...fixtureValue, fixtureDigest: retrievalFixtureDigest(fixtureValue) }
  mkdirSync(dirname(BGE_M3_VI_FIXTURE_PATH), { recursive: true })
  writeFileSync(BGE_M3_VI_FIXTURE_PATH, `${JSON.stringify(fixture)}\n`, { encoding: 'utf8', mode: 0o600 })
  const evaluation = runRetrievalEvaluation({ fixture })
  const embeddingEstimatedInputTokens = Math.ceil(benchmarkItems.reduce((total, [, text]) => total + text.length, 0) / 4)
  const embeddingEstimatedCostUsd = Number((embeddingEstimatedInputTokens * 0.01 / 1_000_000).toFixed(8))
  console.log(JSON.stringify({
    ok: evaluation.passed,
    outboundRequests: embeddingOnly ? 1 : 2,
    summary: { providerId: 'opencode-zen', model: SUMMARY_MODEL, structuredVietnamese: !embeddingOnly, attempted: !embeddingOnly },
    embedding: { providerId: 'openrouter', model: EMBEDDING_MODEL, dimensions: 1024, batchSize: benchmarkItems.length },
    benchmark: { fixtureVersion: fixture.fixtureVersion, fixtureDigest: fixture.fixtureDigest, top5Rate: evaluation.top5Rate, passed: evaluation.passed },
    estimatedCostUsd: { summary: 0, embedding: embeddingEstimatedCostUsd, total: embeddingEstimatedCostUsd },
  }))
  if (!evaluation.passed) process.exitCode = 1
} catch (error) {
  reportFailure(stage, error)
}
