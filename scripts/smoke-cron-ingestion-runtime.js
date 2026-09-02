import assert from 'node:assert/strict'
import { createConfiguredIngestionExecutor } from '../server/bootstrap/ingestion.js'
import { createRssConnector } from '../server/connectors/rss/index.js'
import { createIngestionQueueAdapter } from '../server/jobs/ingestion-queue.js'
import { runDueWork } from '../server/jobs/due-work-coordinator.js'
import { createRuntimeTracer } from '../server/jobs/runtime-trace.js'

const RSS_BODY = '<rss version="2.0"><channel><title>Smoke feed</title>'
  + '<item><title>First item</title><link>https://news.example.test/one</link><guid>one</guid><pubDate>Tue, 01 Sep 2026 00:00:00 GMT</pubDate></item>'
  + '<item><title>Second item</title><link>https://news.example.test/two</link><guid>two</guid><pubDate>Tue, 01 Sep 2026 00:00:00 GMT</pubDate></item>'
  + '<item><title>Third item</title><link>https://news.example.test/three</link><guid>three</guid><pubDate>Tue, 01 Sep 2026 00:00:00 GMT</pubDate></item>'
  + '</channel></rss>'

function smokeSource(id) {
  return {
    id,
    sourceKey: `rss:smoke-${id}`,
    name: 'Smoke source',
    publisherName: 'Smoke publisher',
    domain: 'news.example.test',
    connectorType: 'rss',
    accessMethod: 'rss',
    authorityTier: 'editorial',
    connectorConfig: { kind: 'rss', feedUrl: 'https://news.example.test/feed.xml', batchSize: 2 },
    operationalStatus: 'active',
    licenseStatus: 'metadata-only',
    policyVersion: 1,
    technicalCheck: { status: 'passed' },
    llmInputScope: 'metadata',
    storageScope: { metadata: true, excerpt: false, summary: false, embedding: false },
    mediaPolicy: { imageMode: 'none', videoMode: 'none', allowedHosts: [], attributionRequired: false },
  }
}

function smokeJob(id, source) {
  return {
    id,
    sourceId: source.id,
    connectorType: 'rss',
    expectedSourcePolicyVersion: source.policyVersion,
    batchSize: source.connectorConfig.batchSize,
    checkpoint: {},
    availableAt: new Date(),
    task: undefined,
    status: 'queued',
  }
}

function createInMemoryRuntime() {
  const sources = new Map(['source-1', 'source-2'].map((id) => [id, smokeSource(id)]))
  const jobs = ['source-1', 'source-2'].map((id, index) => smokeJob(`job-${index + 1}`, sources.get(id)))
  const activeLeases = new Map()
  const committed = []
  const traceLines = []
  const trace = createRuntimeTracer({ log: (line) => traceLines.push(line) })
  let generation = 0

  const sourceRepository = {
    findSourceById: async (sourceId) => sources.get(sourceId) ?? null,
  }
  const articleRepository = {
    commitIngestionBatch: async ({ job, candidates, articles, checkpoint, counters }) => {
      committed.push({ jobId: job.id, candidates: [...candidates], articles: [...articles], checkpoint: { ...checkpoint }, counters: { ...counters } })
      return { status: 'succeeded', checkpoint, counters }
    },
  }
  const connector = createRssConnector({ now: () => new Date() })
  const executorForSecondJob = createConfiguredIngestionExecutor({
    sourceRepository,
    articleRepository,
    connectorRegistry: { resolve: () => ({ run: (input) => connector.run({ ...input, payload: { body: RSS_BODY, contentType: 'application/rss+xml', url: 'https://news.example.test/feed.xml' } }) }) },
    currentSourcePolicy: { content: async () => ({ allowed: true, policyVersion: 1 }) },
  })
  const executor = async (input) => input.job.id === 'job-1' ? new Promise(() => {}) : executorForSecondJob(input)
  const jobRepository = {
    selectDueIngestion: async ({ now }) => jobs.find((job) => job.status === 'queued' && job.availableAt <= now) ?? null,
    claimQueuedWithFence: async ({ jobId, fence }) => {
      const job = jobs.find((item) => item.id === jobId)
      if (!job || job.status !== 'queued') return false
      job.status = 'running'
      job.leaseGeneration = fence.leaseGeneration
      return true
    },
    completeWithFence: async ({ jobId, status, error, checkpoint, counters }) => {
      const job = jobs.find((item) => item.id === jobId)
      assert.equal(job?.status, 'running')
      job.status = status
      job.error = error
      job.checkpoint = checkpoint
      job.counters = counters
      activeLeases.delete(jobId)
      return { ...job }
    },
    deferWithFence: async () => ({ status: 'queued' }),
    finalizeOrphanedAttempt: async () => false,
    recoverExpiredIngestion: async () => ({ inspected: 0, recovered: 0, retriesCreated: 0, failed: 0 }),
    nextAvailableAt: async () => jobs.find((job) => job.status === 'queued')?.availableAt ?? null,
  }
  const leaseRepository = {
    acquire: async ({ key, jobId, ownerToken: _ownerToken }) => {
      generation += 1
      const fence = { key, jobId, ownerTokenHash: 'a'.repeat(64), leaseGeneration: generation }
      activeLeases.set(jobId, fence)
      return fence
    },
    heartbeat: async ({ jobId }) => activeLeases.has(jobId),
    release: async ({ jobId }) => activeLeases.delete(jobId),
  }
  const queue = createIngestionQueueAdapter({
    jobRepository,
    leaseRepository,
    executor,
    executionTimeoutMs: 500,
    finalizationGraceMs: 0,
    ownerToken: () => 'smoke-owner-token',
    trace,
  })
  return { jobs, committed, activeLeases, traceLines, queue }
}

async function main() {
  const runtime = createInMemoryRuntime()
  const result = await runDueWork({
    registry: { registered: () => [runtime.queue] },
    budgetMs: 3_000,
    maxJobs: 2,
    maxRecoveries: 0,
    runId: 'smoke-run-1',
    now: () => new Date(),
  })
  assert.equal(result.queues.ingestion.claimed, 2)
  assert.equal(runtime.jobs[0].status, 'failed')
  assert.equal(runtime.jobs[0].error.code, 'ingestion_deadline_exceeded')
  assert.equal(runtime.jobs[0].error.retryable, false)
  assert.equal(runtime.jobs[1].status, 'succeeded')
  assert.equal(runtime.committed.length, 1)
  assert.equal(runtime.committed[0].candidates.length, 2)
  assert.equal(runtime.committed[0].articles.length, 2)
  assert.equal(runtime.committed[0].checkpoint.processedCount, 2)
  assert.equal(runtime.committed[0].counters.fetched, 2)
  assert.equal(runtime.jobs.filter((job) => job.status === 'running').length, 0)
  assert.equal(runtime.activeLeases.size, 0)

  const events = runtime.traceLines.map((line) => JSON.parse(line))
  const firstJobEvents = events.filter((event) => event.jobId === 'job-1')
  assert.deepEqual(firstJobEvents.map((event) => `${event.stage}:${event.status}`), [
    'ingestion.claim:succeeded',
    'ingestion.executor:started',
    'ingestion.deadline:timeout',
    'ingestion.executor:timeout',
    'ingestion.completion:started',
    'ingestion.completion:succeeded',
  ])
  const serializedTrace = JSON.stringify(events)
  for (const sentinel of ['smoke-owner-token', 'aaaaaaaa', 'https://news.example.test', '<rss', 'raw']) assert.equal(serializedTrace.includes(sentinel), false)
  console.log(JSON.stringify({ outcome: 'passed', runId: result.runId, queued: 2, failedDeadline: 1, committedCandidates: runtime.committed[0].candidates.length, running: 0, activeLeases: 0 }))
}

main().catch((error) => {
  console.error(JSON.stringify({ outcome: 'failed', code: error?.code ?? 'smoke_failed' }))
  process.exitCode = 1
})
