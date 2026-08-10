import { describe, expect, it, vi } from 'vitest'
import { createSourceService } from '../../../server/application/sources/service.js'

const admin = {
  user: { id: '64d2f4bda57d0c1d2c38f001', role: 'admin', status: 'active' },
  session: { _id: '64d2f4bda57d0c1d2c38f002', userSessionVersion: 3 },
}
const user = { ...admin, user: { ...admin.user, role: 'user' } }
const request = { serverRequestId: 'server-request-1' }
const input = {
  name: 'Example', sourceKey: 'rss:example', publisherName: 'Example Publisher', domain: 'example.com',
  connectorType: 'rss', accessMethod: 'rss', authorityTier: 'editorial',
  connectorConfig: { kind: 'rss', feedUrl: 'https://example.com/feed.xml', batchSize: 20 },
}
const allowAdmission = { reserve: vi.fn(async () => ({ allowed: true })) }

function memoryRepository() {
  let source
  const audits = []
  const failedAudits = []
  return {
    audits,
    failedAudits,
    listSources: vi.fn(async () => ({ sources: source ? [source] : [], hasNext: false, nextCursor: null })),
    findSourceById: vi.fn(async () => source),
    commitCreate: vi.fn(async (value) => { source = value.source; audits.push(value.audit); return source }),
    commitReplacement: vi.fn(async (value) => { source = value.source; audits.push(value.audit); return source }),
    commitFailedAudit: vi.fn(async (value) => { failedAudits.push(value.audit); return value.audit }),
  }
}

describe('Source application service', () => {
  it('requires an active admin for reads and mutations', async () => {
    const service = createSourceService({ repository: memoryRepository() })
    await expect(service.list({ auth: user, query: {} })).rejects.toMatchObject({ status: 403, code: 'forbidden' })
    await expect(service.create({ auth: null, input, request })).rejects.toMatchObject({ status: 401, code: 'unauthorized' })
  })

  it('creates a fail-closed draft and commits an allowlisted audit atomically', async () => {
    const repository = memoryRepository()
    const service = createSourceService({ repository, now: () => new Date('2026-08-10T00:00:00.000Z') })
    const source = await service.create({ auth: admin, input, request })

    expect(source).toEqual(expect.objectContaining({ operationalStatus: 'draft', licenseStatus: 'review-needed', policyVersion: 1 }))
    expect(repository.commitCreate).toHaveBeenCalledWith(expect.objectContaining({ actorFence: expect.objectContaining({ sessionVersion: 3 }) }))
    expect(repository.audits[0]).toEqual(expect.objectContaining({ action: 'source_created', targetType: 'source', changedFields: ['sourceKey', 'operationalStatus', 'policyVersion'], reasonCode: 'source_created' }))
    expect(JSON.stringify(repository.audits[0])).not.toMatch(/password|secret|credential|evidenceNote/i)
  })

  it('advances one policy version and matching reconciliation marker for one connector patch', async () => {
    const repository = memoryRepository()
    const service = createSourceService({ repository, now: () => new Date('2026-08-10T00:00:00.000Z') })
    const created = await service.create({ auth: admin, input, request })
    const updated = await service.update({
      auth: admin,
      sourceId: created.id,
      patch: { domain: 'feeds.example.com', connectorConfig: { kind: 'rss', feedUrl: 'https://feeds.example.com/feed.xml', batchSize: 30 }, reasonCode: 'source_configuration_changed' },
      request: { serverRequestId: 'server-request-2' },
    })

    expect(updated.policyVersion).toBe(2)
    expect(updated.reconciliation).toEqual(expect.objectContaining({ status: 'pending', requiredPolicyVersion: 2 }))
    expect(repository.audits.at(-1)).toEqual(expect.objectContaining({ action: 'source_configuration_updated', changedFields: ['connectorConfig', 'domain'] }))
  })

  it('audits an atomic configuration plus status transition without splitting the request', async () => {
    const repository = memoryRepository()
    const service = createSourceService({ repository, now: () => new Date('2026-08-10T00:00:00.000Z') })
    const created = await service.create({ auth: admin, input, request })
    const updated = await service.update({ auth: admin, sourceId: created.id, patch: { domain: 'feeds.example.com', operationalStatus: 'testing', reasonCode: 'source_configuration_changed' }, request: { serverRequestId: 'mixed-update-1' } })
    expect(updated).toEqual(expect.objectContaining({ operationalStatus: 'testing', policyVersion: 2 }))
    expect(updated.updatedAt.getTime()).toBeGreaterThan(created.updatedAt.getTime())
    expect(repository.audits.at(-1)).toEqual(expect.objectContaining({ action: 'source_configuration_updated', changedFields: ['domain', 'operationalStatus'], stateTransition: { from: 'draft', to: 'testing' } }))
  })

  it('records server-owned review evidence then atomically fail-closes an active source for re-review', async () => {
    const repository = memoryRepository()
    const service = createSourceService({ repository, now: () => new Date('2026-08-10T00:00:00.000Z') })
    const source = await service.create({ auth: admin, input, request })
    const reviewed = await service.reviewPolicy({
      auth: admin,
      sourceId: source.id,
      review: {
        licenseStatus: 'metadata-only', llmInputScope: 'metadata', storageScope: { metadata: true, excerpt: false, summary: true, embedding: true },
        mediaPolicy: { imageMode: 'none', videoMode: 'none', allowedHosts: [], attributionRequired: false, evidenceNote: null },
        attributionRequired: true, attributionText: 'Example Publisher', termsUrl: 'https://example.com/terms', licenseUrl: null,
        evidenceNote: 'Human-reviewed publisher terms.', reasonCode: 'source_policy_reviewed',
      },
      request: { serverRequestId: 'server-request-3' },
    })
    reviewed.operationalStatus = 'active'
    const result = await service.requestReReview({ auth: admin, sourceId: source.id, request: { serverRequestId: 'server-request-4' } })

    expect(result).toEqual(expect.objectContaining({ operationalStatus: 'paused', licenseStatus: 'review-needed', llmInputScope: 'none', policyVersion: 3 }))
    expect(result.reviewedBy).toBe(admin.user.id)
    expect(repository.audits.at(-1)).toEqual(expect.objectContaining({ action: 'source_policy_re_review_requested', reasonCode: 'source_policy_re_review_requested' }))
  })

  it('fails closed with 503 when Step 4 technical-check adapter is absent', async () => {
    const repository = memoryRepository()
    const service = createSourceService({ repository })
    const source = await service.create({ auth: admin, input, request })
    await expect(service.runTechnicalCheck({ auth: admin, sourceId: source.id, request })).rejects.toMatchObject({ status: 503, code: 'service_unavailable' })
  })

  it('fails closed before outbound technical work when rate-limit admission is missing or unavailable', async () => {
    const repository = memoryRepository()
    const adapter = { run: vi.fn(async () => ({ status: 'passed', contentType: 'application/rss+xml', resolvedHost: 'example.com', sampleCount: 1 })) }
    expect(() => createSourceService({ repository, technicalCheckAdapter: adapter })).toThrow(/rate-limit/i)
    const creator = createSourceService({ repository })
    const source = await creator.create({ auth: admin, input, request })

    const unavailable = createSourceService({ repository, technicalCheckAdapter: adapter, rateLimitAdmission: { reserve: async () => { throw new Error('unavailable') } } })
    await expect(unavailable.runTechnicalCheck({ auth: admin, sourceId: source.id, request })).rejects.toMatchObject({ status: 503, code: 'service_unavailable' })
    expect(adapter.run).not.toHaveBeenCalled()
  })

  it('does not let the technical-check adapter mutate or elevate Source Policy', async () => {
    const repository = memoryRepository()
    const technicalCheckAdapter = { run: vi.fn(async ({ source }) => {
      expect(Object.isFrozen(source)).toBe(true)
      expect(Object.isFrozen(source.connectorConfig)).toBe(true)
      try { source.licenseStatus = 'permitted' } catch { /* expected frozen input */ }
      try { source.connectorConfig.feedUrl = 'https://evil.example/feed.xml' } catch { /* expected frozen input */ }
      return { status: 'passed', contentType: 'application/rss+xml', resolvedHost: 'example.com', sampleCount: 1, licenseStatus: 'permitted' }
    }) }
    const service = createSourceService({ repository, technicalCheckAdapter, rateLimitAdmission: allowAdmission, now: () => new Date('2026-08-10T00:00:00.000Z') })
    const source = await service.create({ auth: admin, input, request })
    const result = await service.runTechnicalCheck({ auth: admin, sourceId: source.id, request: { serverRequestId: 'technical-no-elevation' } })
    expect(result.technicalCheck.status).toBe('passed')
    const persisted = await repository.findSourceById(source.id)
    expect(persisted).toEqual(expect.objectContaining({ licenseStatus: 'review-needed', llmInputScope: 'none', policyVersion: 1 }))
    expect(persisted.connectorConfig.feedUrl).toBe('https://example.com/feed.xml')
  })

  it('rejects unsafe technical-check output and maps Mongo outages to canonical 503', async () => {
    const repository = memoryRepository()
    const unsafe = createSourceService({ repository, technicalCheckAdapter: { run: vi.fn(async () => ({ status: 'passed', contentType: 'application/rss+xml', resolvedHost: '127.0.0.1', sampleCount: 1 })) }, rateLimitAdmission: allowAdmission })
    const source = await unsafe.create({ auth: admin, input, request })
    await expect(unsafe.runTechnicalCheck({ auth: admin, sourceId: source.id, request })).rejects.toMatchObject({ status: 503, code: 'service_unavailable' })

    const outage = createSourceService({ repository: { listSources: vi.fn(async () => { const error = new Error('selection failed'); error.name = 'MongoServerSelectionError'; throw error }) } })
    await expect(outage.list({ auth: admin, query: {} })).rejects.toMatchObject({ status: 503, code: 'service_unavailable' })
    const malformedCursor = createSourceService({ repository: { listSources: vi.fn(async () => { throw Object.assign(new Error('Source cursor is invalid'), { code: 'source_validation' }) }) } })
    await expect(malformedCursor.list({ auth: admin, query: { cursor: 'bad' } })).rejects.toMatchObject({ status: 422, code: 'validation_error' })
  })

  it('maps missing repository, malformed identifiers and absent sources without leaking internals', async () => {
    const unavailable = createSourceService()
    await expect(unavailable.list({ auth: admin })).rejects.toMatchObject({ status: 503, code: 'service_unavailable' })
    const service = createSourceService({ repository: memoryRepository() })
    await expect(service.get({ auth: admin, sourceId: 'invalid-id' })).rejects.toMatchObject({ status: 404, code: 'not_found' })
    await expect(service.get({ auth: admin, sourceId: '64d2f4bda57d0c1d2c38f099' })).rejects.toMatchObject({ status: 404, code: 'not_found' })
  })

  it('persists a bounded failed technical-check result and rejects malformed adapter payloads', async () => {
    const repository = memoryRepository()
    const failedAdapter = { run: vi.fn(async () => ({ status: 'failed', error: { code: 'upstream_timeout', message: 'Timed out safely', retryable: true, upstreamStatus: 504 } })) }
    const failedService = createSourceService({ repository, technicalCheckAdapter: failedAdapter, rateLimitAdmission: allowAdmission, now: () => new Date('2026-08-10T00:00:00.000Z') })
    const source = await failedService.create({ auth: admin, input, request })
    await expect(failedService.runTechnicalCheck({ auth: admin, sourceId: source.id, request: { serverRequestId: 'technical-failed-safe' } })).resolves.toEqual(expect.objectContaining({ technicalCheck: expect.objectContaining({ status: 'failed', contentType: null, error: expect.objectContaining({ code: 'upstream_timeout', upstreamStatus: 504 }) }) }))

    for (const output of [null, { status: 'unknown' }, { status: 'passed', contentType: '', resolvedHost: 'example.com', sampleCount: 1 }, { status: 'failed', error: { code: 'bad', message: '', retryable: true } }]) {
      const malformed = createSourceService({ repository, technicalCheckAdapter: { run: vi.fn(async () => output) }, rateLimitAdmission: allowAdmission })
      await expect(malformed.runTechnicalCheck({ auth: admin, sourceId: source.id, request: { serverRequestId: `malformed-${String(output?.status)}` } })).rejects.toMatchObject({ status: 503, code: 'service_unavailable' })
    }
  })

  it('persists an allowlisted failed audit for an authenticated invalid transition', async () => {
    const repository = memoryRepository()
    const service = createSourceService({ repository, now: () => new Date('2026-08-10T00:00:00.000Z') })
    const source = await service.create({ auth: admin, input, request })

    await expect(service.update({ auth: admin, sourceId: source.id, patch: { operationalStatus: 'active', reasonCode: 'source_status_changed' }, request: { serverRequestId: 'failed-transition-1' } })).rejects.toMatchObject({ status: 409, code: 'invalid_state_transition' })
    expect(repository.failedAudits).toEqual([expect.objectContaining({ action: 'source_status_updated', result: 'failed', changedFields: ['operationalStatus'], stateTransition: { from: 'draft', to: 'active' } })])
  })

  it('fails closed with canonical 503 when a required failed-mutation audit cannot persist', async () => {
    const repository = memoryRepository()
    repository.commitFailedAudit.mockRejectedValue(new Error('audit storage unavailable'))
    const service = createSourceService({ repository, now: () => new Date('2026-08-10T00:00:00.000Z') })
    const source = await service.create({ auth: admin, input, request })

    await expect(service.update({ auth: admin, sourceId: source.id, patch: { operationalStatus: 'active', reasonCode: 'source_status_changed' }, request: { serverRequestId: 'failed-audit-outage-1' } })).rejects.toMatchObject({ status: 503, code: 'service_unavailable' })
  })

  it('persists failed configuration and CAS audits without leaking attempted values', async () => {
    const repository = memoryRepository()
    const service = createSourceService({ repository, now: () => new Date('2026-08-10T00:00:00.000Z') })
    const source = await service.create({ auth: admin, input, request })
    await expect(service.update({ auth: admin, sourceId: source.id, patch: { domain: '127.0.0.1', reasonCode: 'source_configuration_changed' }, request: { serverRequestId: 'failed-config-1' } })).rejects.toMatchObject({ status: 422, code: 'validation_error' })
    expect(repository.failedAudits.at(-1)).toEqual(expect.objectContaining({ action: 'source_configuration_updated', result: 'failed', changedFields: ['domain'] }))
    expect(JSON.stringify(repository.failedAudits.at(-1))).not.toContain('127.0.0.1')

    repository.commitReplacement.mockRejectedValueOnce(Object.assign(new Error('race'), { code: 'source_conflict' }))
    await expect(service.update({ auth: admin, sourceId: source.id, patch: { name: 'Renamed', reasonCode: 'source_configuration_changed' }, request: { serverRequestId: 'failed-cas-1' } })).rejects.toMatchObject({ status: 409, code: 'conflict' })
    expect(repository.failedAudits.at(-1)).toEqual(expect.objectContaining({ action: 'source_configuration_updated', result: 'failed', changedFields: ['name'] }))
  })
})
