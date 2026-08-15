import { ObjectId } from 'mongodb'
import { describe, expect, it } from 'vitest'
import { buildIngestionArtifactJobs, indexingJobDocument, purgeAfterForIndexing, serializeIndexingJob } from '../../../server/repositories/mongo/indexing-job-repository.js'

const createdAt = new Date('2026-08-10T00:00:00.000Z')
const embeddingTarget = { dimensions: 3, version: 7, artifactCompatibilityId: 'embedding-compat-v1' }
const job = {
  id: '507f1f77bcf86cd799439041', idempotencyKey: 'indexing-test-key', actorScope: 'admin:opaque', requestHash: 'a'.repeat(64),
  articleId: '507f1f77bcf86cd799439011', sourceId: '507f1f77bcf86cd799439021', expectedSourcePolicyVersion: 4,
  task: 'embedding', trigger: 'admin', requestedBy: '507f1f77bcf86cd799439001', status: 'queued', attempt: 1, priority: 50,
  availableAt: createdAt, agingEligibleAt: new Date(createdAt.getTime() + 30 * 60_000), idempotencyExpiresAt: new Date(createdAt.getTime() + 14 * 24 * 60 * 60_000),
  leaseGeneration: 0, targetEmbeddingVersion: 1, createdAt, updatedAt: createdAt,
}

describe('Step 9 indexing Mongo repository documents', () => {
  it('round-trips exact task identity and version metadata with Mongo ObjectIds', () => {
    const document = indexingJobDocument(job)
    expect(document).toEqual(expect.objectContaining({ _id: new ObjectId(job.id), articleId: new ObjectId(job.articleId), sourceId: new ObjectId(job.sourceId), task: 'embedding', targetEmbeddingVersion: 1 }))
    expect(serializeIndexingJob(document)).toEqual(expect.objectContaining({ id: job.id, articleId: job.articleId, sourceId: job.sourceId, task: 'embedding', targetEmbeddingVersion: 1 }))
  })

  it('never purges before idempotency expiry and retains failed/partial for thirty days', () => {
    const finishedAt = new Date('2026-08-11T00:00:00.000Z')
    const earlyExpiry = new Date('2026-08-12T00:00:00.000Z')
    const lateExpiry = new Date('2026-10-01T00:00:00.000Z')
    expect(purgeAfterForIndexing('failed', finishedAt, earlyExpiry)).toEqual(new Date('2026-09-10T00:00:00.000Z'))
    expect(purgeAfterForIndexing('succeeded', finishedAt, lateExpiry)).toEqual(lateExpiry)
  })

  it('fans each ingested article into independent, deterministic summary and embedding jobs', () => {
    const source = {
      id: job.sourceId, policyVersion: 4, operationalStatus: 'active', licenseStatus: 'permitted', llmInputScope: 'excerpt',
      storageScope: { metadata: true, excerpt: true, summary: true, embedding: true }, technicalCheck: { status: 'passed' },
      mediaPolicy: { imageMode: 'none', videoMode: 'none', allowedHosts: [], attributionRequired: false, evidenceNote: null }, attributionRequired: false, attributionText: null,
    }
    const article = { id: job.articleId, status: 'published', titleOriginal: 'A safe title', excerptOriginal: 'A bounded excerpt', topics: ['ai'], sourceLanguage: 'en' }
    const first = buildIngestionArtifactJobs({ source, article, now: createdAt, embeddingTarget })
    const replay = buildIngestionArtifactJobs({ source, article, now: createdAt, embeddingTarget })
    expect(first.map(({ task }) => task)).toEqual(['summary', 'embedding'])
    expect(first.map(({ trigger }) => trigger)).toEqual(['ingestion', 'ingestion'])
    expect(first.map(({ idempotencyKey }) => idempotencyKey)).toEqual(replay.map(({ idempotencyKey }) => idempotencyKey))
    expect(first.find(({ task }) => task === 'embedding')).toEqual(expect.objectContaining({ targetEmbeddingVersion: embeddingTarget.version, targetEmbeddingArtifactCompatibilityId: embeddingTarget.artifactCompatibilityId }))
    expect(JSON.stringify(first)).not.toContain(article.excerptOriginal)
  })

  it('changes embedding identity and request hash when version or compatibility target changes', () => {
    const source = { id: job.sourceId, policyVersion: 4, operationalStatus: 'active', licenseStatus: 'permitted', llmInputScope: 'excerpt', storageScope: { metadata: true, excerpt: true, summary: true, embedding: true }, technicalCheck: { status: 'passed' }, mediaPolicy: { imageMode: 'none', videoMode: 'none', allowedHosts: [], attributionRequired: false } }
    const article = { id: job.articleId, status: 'published', titleOriginal: 'A safe title', excerptOriginal: 'A bounded excerpt', topics: ['ai'], sourceLanguage: 'en' }
    const first = buildIngestionArtifactJobs({ source, article, now: createdAt, embeddingTarget })
    const changed = buildIngestionArtifactJobs({ source, article, now: createdAt, embeddingTarget: { ...embeddingTarget, version: 8, artifactCompatibilityId: 'embedding-compat-v2' } })
    const firstEmbedding = first.find(({ task }) => task === 'embedding')
    const changedEmbedding = changed.find(({ task }) => task === 'embedding')
    expect(changedEmbedding.idempotencyKey).not.toBe(firstEmbedding.idempotencyKey)
    expect(changedEmbedding.requestHash).not.toBe(firstEmbedding.requestHash)
  })
})
