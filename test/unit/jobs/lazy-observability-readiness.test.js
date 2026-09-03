import { describe, expect, it, vi } from 'vitest'

const common = {
  context: { name: 'runtime-context' },
  runtime: { providerRegistry: {} },
  rateLimitAdmission: { reserve: vi.fn() },
  quotaKeyring: {},
  governanceKeyring: {},
}

function mockRuntimeModules({ readiness } = {}) {
  const order = []
  const assertCronObservabilityReady = vi.fn(async () => {
    order.push('live-readiness')
    if (readiness) throw readiness
  })
  const verifyAttestation = vi.fn(async () => {
    order.push('attestation')
  })
  const MongoCronEventRepository = vi.fn(function MongoCronEventRepository() {
    order.push('repository')
  })
  const createConfiguredJobRuntime = vi.fn(async () => ({ jobService: {} }))
  const createProductionJobRuntime = vi.fn(async ({ jobOptions, createJobRuntime }) => ({
    jobs: await createJobRuntime(jobOptions),
    maintenanceContext: null,
  }))
  vi.doMock('../../../server/maintenance/job-runtime.js', () => ({ createProductionJobRuntime }))
  vi.doMock('../../../server/bootstrap/jobs.js', () => ({ createConfiguredJobRuntime, assertCronObservabilityReady }))
  vi.doMock('../../../server/bootstrap/ingestion.js', () => ({ createConfiguredIngestionExecutor: vi.fn(() => vi.fn()) }))
  vi.doMock('../../../server/bootstrap/schema-readiness.js', () => ({
    createReleaseVerifiedSchemaVerifier: vi.fn(() => verifyAttestation),
  }))
  vi.doMock('../../../server/repositories/mongo/cron-event-repository.js', () => ({ MongoCronEventRepository }))
  vi.doMock('../../../server/jobs/runtime-trace.js', () => ({
    createRuntimeTracer: vi.fn(() => vi.fn()),
    reportRuntimeTraceDegraded: vi.fn(),
  }))
  return { order, assertCronObservabilityReady, createConfiguredJobRuntime, MongoCronEventRepository }
}

describe('lazy cron observability readiness', () => {
  it('requires live Mongo validator/index readiness after release attestation', async () => {
    vi.resetModules()
    const mocks = mockRuntimeModules()
    const { createConfiguredRuntimeFactories } = await import('../../../server/bootstrap/lazy-runtime.js')
    const factories = createConfiguredRuntimeFactories({ environment: {} })

    const result = await factories.jobs({ common })

    expect(mocks.order).toEqual(['attestation', 'live-readiness', 'repository'])
    expect(mocks.assertCronObservabilityReady).toHaveBeenCalledOnce()
    expect(mocks.MongoCronEventRepository).toHaveBeenCalledOnce()
    expect(result.cronObservabilityReady).toBe(true)
  })

  it('disables lifecycle tracing when live readiness fails without disabling durable jobs', async () => {
    vi.resetModules()
    const readinessError = new Error('cron lifecycle indexes are stale')
    const mocks = mockRuntimeModules({ readiness: readinessError })
    const { createConfiguredRuntimeFactories } = await import('../../../server/bootstrap/lazy-runtime.js')
    const factories = createConfiguredRuntimeFactories({ environment: {} })

    const result = await factories.jobs({ common })
    expect(mocks.createConfiguredJobRuntime).toHaveBeenCalledWith(expect.objectContaining({ cronEventRepository: null }))
    expect(mocks.order).toEqual(['attestation', 'live-readiness'])
    expect(mocks.MongoCronEventRepository).not.toHaveBeenCalled()
    expect(result.cronEventRepository).toBeNull()
    expect(result.cronObservabilityReady).toBe(false)
    expect(mocks.createConfiguredJobRuntime).toBeDefined()
  })
})
