import { describe, expect, it, vi } from 'vitest'
import { createAdminGovernanceService } from '../../../server/application/admin/service.js'

const adminAuth = { user: { id: '507f1f77bcf86cd799439001', role: 'admin', status: 'active' }, session: { id: '507f1f77bcf86cd799439002', userSessionVersion: 1 } }
const receiverArticle = Object.freeze({ _id: '507f1f77bcf86cd799439010', sourceId: '507f1f77bcf86cd799439011', titleOriginal: 'Receiver-bound article', status: 'published', topics: [], leadMedia: null, leadMediaStatus: 'none', summaryStatus: 'ready', embeddingStatus: 'ready', updatedAt: new Date('2026-01-01') })

describe('admin governance service', () => {
  it('returns safe overview counters without private fields', async () => {
    const repository = {
      getOverview: vi.fn(async () => ({ activeSources: 2, pausedSources: 1, sourcesNeedingReview: 0, queuedJobs: 3, failedJobs: 1, articlesNeedingReview: 4, failedIndexes: 1, openTakedowns: 0, failedAccountDeletions: 0, lastSuccessfulIngestionAt: null, passwordHash: 'must-not-leak' })),
    }
    const service = createAdminGovernanceService({ repository })
    await expect(service.getAdminOverview({ auth: adminAuth })).resolves.toEqual({ activeSources: 2, pausedSources: 1, sourcesNeedingReview: 0, queuedJobs: 3, failedJobs: 1, articlesNeedingReview: 4, failedIndexes: 1, openTakedowns: 0, failedAccountDeletions: 0, lastSuccessfulIngestionAt: null })
  })

  it('preserves the repository receiver for overview reads', async () => {
    const repository = {
      overview: { activeSources: 7 },
      getOverview() { return this.overview },
    }
    const service = createAdminGovernanceService({ repository })

    await expect(service.getAdminOverview({ auth: adminAuth })).resolves.toMatchObject({ activeSources: 7 })
  })

  it('preserves the repository receiver for article list reads', async () => {
    const repository = {
      article: { _id: '507f1f77bcf86cd799439010', sourceId: '507f1f77bcf86cd799439011', titleOriginal: 'Bound article', status: 'published', topics: [], leadMedia: null, leadMediaStatus: 'none', summaryStatus: 'ready', embeddingStatus: 'ready', updatedAt: new Date('2026-01-01') },
      listAdminArticles() { return { articles: [this.article], hasNext: true, nextCursor: 'article-next' } },
    }
    const service = createAdminGovernanceService({ repository })

    await expect(service.listAdminArticles({ auth: adminAuth })).resolves.toMatchObject({ articles: [expect.objectContaining({ titleOriginal: 'Bound article' })], hasNext: true, nextCursor: 'article-next' })
  })

  it('preserves the repository receiver for audit list reads', async () => {
    const repository = {
      audit: { _id: '507f1f77bcf86cd799439020', actorType: 'user', actorId: '507f1f77bcf86cd799439001', action: 'article_status_changed', targetType: 'article', targetId: '507f1f77bcf86cd799439010', changedFields: ['status'], stateTransition: { from: 'published', to: 'hidden' }, reasonCode: 'article_status_changed', requestId: 'request-1', result: 'success', createdAt: new Date('2026-01-01') },
      listAuditLogs() { return { logs: [this.audit], hasNext: false, nextCursor: null } },
    }
    const service = createAdminGovernanceService({ repository })

    await expect(service.listAuditLogs({ auth: adminAuth })).resolves.toMatchObject({ logs: [expect.objectContaining({ action: 'article_status_changed', requestId: 'request-1' })] })
  })

  it('preserves the repository receiver for article detail reads', async () => {
    const repository = {
      article: receiverArticle,
      findAdminArticle(articleId) { return articleId === this.article._id ? this.article : null },
    }
    const service = createAdminGovernanceService({ repository })

    await expect(service.getAdminArticle({ auth: adminAuth, articleId: receiverArticle._id })).resolves.toMatchObject({ id: receiverArticle._id, titleOriginal: 'Receiver-bound article' })
  })

  it('preserves the repository receiver for article updates', async () => {
    const repository = {
      article: { ...receiverArticle, status: 'hidden' },
      updateAdminArticle(articleId, input) { return articleId === this.article._id && input.category === 'status' ? this.article : null },
    }
    const service = createAdminGovernanceService({ repository })

    await expect(service.updateAdminArticle({ auth: adminAuth, articleId: receiverArticle._id, patch: { status: 'hidden', reasonCode: 'article_status_changed' } })).resolves.toMatchObject({ id: receiverArticle._id, status: 'hidden' })
  })

  it('preserves the repository receiver for duplicate merges', async () => {
    const repository = {
      article: receiverArticle,
      idempotencyKey: 'receiver-merge-1',
      mergeDuplicateArticles(input) { return input.idempotencyKey === this.idempotencyKey ? { canonical: this.article } : null },
    }
    const service = createAdminGovernanceService({ repository })

    await expect(service.mergeDuplicateArticles({ auth: adminAuth, input: { canonicalArticleId: receiverArticle._id, duplicateArticleIds: ['507f1f77bcf86cd799439012'], reasonCode: 'duplicate_merge_confirmed' }, idempotencyKey: repository.idempotencyKey })).resolves.toMatchObject({ id: receiverArticle._id, titleOriginal: 'Receiver-bound article' })
  })

  it('serializes article diagnostics without body, vector or provider fields', async () => {
    const repository = { findAdminArticle: vi.fn(async () => ({ _id: '507f1f77bcf86cd799439010', sourceId: '507f1f77bcf86cd799439011', titleOriginal: 'Safe title', originalUrl: 'https://example.test/a', status: 'published', topics: ['AI'], leadMedia: null, leadMediaStatus: 'none', summaryStatus: 'ready', summaryModel: 'model', summarySourcePolicyVersion: 1, summaryGeneratedAt: new Date('2026-01-01'), summaryError: null, embeddingStatus: 'ready', embeddingModel: 'baai/bge-m3', embeddingVersion: 1, embeddingSourcePolicyVersion: 1, embeddedAt: new Date('2026-01-01'), embeddingError: null, provenance: [{ sourceId: '507f1f77bcf86cd799439011', originalUrl: 'https://example.test/a', observedAt: new Date('2026-01-01') }], rightsSnapshot: { sourcePolicyVersion: 1, licenseStatus: 'permitted', llmInputScope: 'excerpt', capturedAt: new Date('2026-01-01') }, body: 'private', embedding: [1, 2], providerPayload: { secret: true }, updatedAt: new Date('2026-01-01') })) }
    const service = createAdminGovernanceService({ repository })
    const result = await service.getAdminArticle({ auth: adminAuth, articleId: '507f1f77bcf86cd799439010' })
    expect(result).toMatchObject({ id: '507f1f77bcf86cd799439010', titleOriginal: 'Safe title', summaryModel: 'model' })
    expect(result).not.toHaveProperty('body')
    expect(result).not.toHaveProperty('embedding')
    expect(result).not.toHaveProperty('providerPayload')
  })

  it('serializes a removed article as a closed metadata-free tombstone', async () => {
    const repository = { findAdminArticle: vi.fn(async () => ({ _id: '507f1f77bcf86cd799439010', sourceId: '507f1f77bcf86cd799439011', status: 'removed', evidenceEligible: false, canonicalUrlHash: 'a'.repeat(64), removalPolicyVersion: 4, removedAt: new Date('2026-08-14T00:00:00.000Z'), updatedAt: new Date('2026-08-14T00:00:00.000Z'), titleOriginal: 'must not escape', originalUrl: 'https://private.example/article', provenance: [{ secret: true }], summaryVi: 'private', embedding: [1, 2] })) }
    const service = createAdminGovernanceService({ repository })
    const result = await service.getAdminArticle({ auth: adminAuth, articleId: '507f1f77bcf86cd799439010' })
    expect(result).toEqual({ id: '507f1f77bcf86cd799439010', sourceId: '507f1f77bcf86cd799439011', status: 'removed', removalPolicyVersion: 4, removedAt: '2026-08-14T00:00:00.000Z', updatedAt: '2026-08-14T00:00:00.000Z' })
    expect(JSON.stringify(result)).not.toContain('private')
    expect(result).not.toHaveProperty('titleOriginal')
  })

  it('replaces persisted article diagnostic text with an allowlisted safe error', async () => {
    const article = { _id: '507f1f77bcf86cd799439010', sourceId: '507f1f77bcf86cd799439011', titleOriginal: 'Safe title', originalUrl: 'https://example.test/a', status: 'published', topics: [], leadMedia: null, leadMediaStatus: 'none', summaryStatus: 'failed', summaryError: { code: 'provider_failed', message: 'mongodb://user:secret@private.example/db', retryable: true, occurredAt: new Date('2026-01-01') }, embeddingStatus: 'failed', embeddingError: { code: 'unknown_internal', message: 'stack trace and secret', retryable: false, occurredAt: new Date('2026-01-01') }, updatedAt: new Date('2026-01-01') }
    const service = createAdminGovernanceService({ repository: { findAdminArticle: vi.fn(async () => article) } })

    const result = await service.getAdminArticle({ auth: adminAuth, articleId: article._id })

    expect(result.summaryError).toMatchObject({ code: 'artifact_generation_failed', message: 'AI artifact did not complete safely' })
    expect(result.embeddingError).toMatchObject({ code: 'operation_failed', message: 'Operation did not complete safely' })
    expect(JSON.stringify(result)).not.toContain('secret')
    expect(JSON.stringify(result)).not.toContain('mongodb://')
  })

  it('requires exactly one article mutation category and matching reason code', async () => {
    const repository = { updateAdminArticle: vi.fn() }
    const service = createAdminGovernanceService({ repository })
    await expect(service.updateAdminArticle({ auth: adminAuth, articleId: '507f1f77bcf86cd799439010', patch: { status: 'hidden', topics: ['AI'], reasonCode: 'article_status_changed' } })).rejects.toMatchObject({ status: 422, code: 'validation_error' })
    await expect(service.updateAdminArticle({ auth: adminAuth, articleId: '507f1f77bcf86cd799439010', patch: { status: 'hidden', reasonCode: 'article_topics_changed' } })).rejects.toMatchObject({ status: 422, code: 'validation_error' })
    expect(repository.updateAdminArticle).not.toHaveBeenCalled()
  })

  it('rejects non-admin and unavailable repository safely', async () => {
    const service = createAdminGovernanceService({ repository: { getOverview: vi.fn() } })
    await expect(service.getAdminOverview({ auth: { user: { role: 'user', status: 'active' } } })).rejects.toMatchObject({ status: 403, code: 'forbidden' })
    await expect(service.listAuditLogs({ auth: adminAuth })).rejects.toMatchObject({ status: 503, code: 'service_unavailable' })
  })
})
