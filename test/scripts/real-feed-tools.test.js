import { describe, expect, it } from 'vitest'
import {
  GOVERNANCE_DATABASE,
  PRESERVED_GOVERNANCE_COLLECTIONS,
  PRESERVED_APP_COLLECTIONS,
  parseClearArgs,
  planCollectionClears,
} from '../../scripts/real-feed-tools.js'
import {
  aiReadySource,
  buildIndexingJobs,
  parseSeedArgs,
  refreshAuditIdentities,
} from '../../scripts/real-feed-tools.js'

describe('real feed maintenance tools', () => {
  it('requires an explicit apply flag and preserves account/security collections', () => {
    expect(parseClearArgs([])).toEqual({ apply: false })
    expect(parseClearArgs(['--apply'])).toEqual({ apply: true })
    expect(PRESERVED_APP_COLLECTIONS).toEqual(expect.arrayContaining(['users', 'sessions', 'adminAuditLogs', 'hmacKeyLifecycleSnapshots']))
    expect(PRESERVED_GOVERNANCE_COLLECTIONS).toEqual(expect.arrayContaining(['governanceSuppressions', 'governanceCheckpoints', 'auditRetentionManifests']))
    expect(GOVERNANCE_DATABASE).toBe('techpulse_governance')

    const plan = planCollectionClears({
      database: 'techpulse_app',
      collections: ['users', 'sessions', 'articles', 'sources', 'runtimeCapabilityProbes', 'system.views'],
    })
    expect(plan.map(({ collection }) => collection)).toEqual(['articles', 'sources', 'runtimeCapabilityProbes'])
    expect(() => planCollectionClears({ database: 'techpulse_app', collections: ['unexpectedCollection'] })).toThrow(/unsupported collection/)
    expect(planCollectionClears({ database: GOVERNANCE_DATABASE, collections: ['governanceCheckpoints', 'runtimeCapabilityProbes'] })).toEqual([{ database: GOVERNANCE_DATABASE, collection: 'runtimeCapabilityProbes' }])
  })

  it('requires apply mode for a real seed and makes source policy AI-eligible', () => {
    expect(parseSeedArgs([])).toEqual({ apply: false, maxArticles: 30 })
    expect(parseSeedArgs(['--apply', '--max-articles=24'])).toEqual({ apply: true, maxArticles: 24 })

    const source = aiReadySource({
      _id: '507f1f77bcf86cd799439011',
      licenseStatus: 'metadata-only',
      storageScope: { metadata: true, excerpt: false, summary: false, embedding: false },
      llmInputScope: 'metadata',
    })
    expect(source.storageScope).toEqual({ metadata: true, excerpt: false, summary: true, embedding: true })
    expect(source.llmInputScope).toBe('metadata')
  })

  it('materializes summary and embedding jobs only when the policy permits both', () => {
    const source = aiReadySource({
      _id: '507f1f77bcf86cd799439011',
      licenseStatus: 'metadata-only',
      llmInputScope: 'metadata',
      storageScope: { metadata: true, excerpt: false, summary: false, embedding: false },
      policyVersion: 2,
      operationalStatus: 'active',
      technicalCheck: { status: 'passed' },
      mediaPolicy: { imageMode: 'none', videoMode: 'none', allowedHosts: [], attributionRequired: false },
      attributionRequired: false,
    })
    const article = { _id: '507f1f77bcf86cd799439012', sourceId: source._id, status: 'published', titleOriginal: 'AI data platform' }
    const jobs = buildIndexingJobs({ source, article, now: new Date('2026-08-21T00:00:00.000Z'), embeddingTarget: { model: 'baai/bge-m3', dimensions: 1024, version: 1, artifactCompatibilityId: 'bge-m3-v1-1024' } })
    expect(jobs.map(({ task }) => task).sort()).toEqual(['embedding', 'summary'])
  })

  it('refreshes audit identities so preserved append-only logs do not collide on a new seed run', () => {
    const audit = {
      actorType: 'admin', actorId: '507f1f77bcf86cd799439011', action: 'source_policy_reviewed',
      targetType: 'source', targetId: '507f1f77bcf86cd799439012', changedFields: ['licenseStatus', 'llmInputScope', 'storageScope', 'mediaPolicy', 'attributionRequired', 'attributionText', 'termsUrl', 'licenseUrl', 'evidenceNote', 'reviewedAt', 'reviewedBy', 'policyVersion'],
      reasonCode: 'source_policy_reviewed', requestId: 'seed:old', result: 'succeeded', createdAt: new Date('2026-08-21T00:00:00.000Z'),
    }
    const [next] = refreshAuditIdentities([audit], 'new-run-20260821')
    expect(next).toMatchObject({ actorType: 'admin', action: audit.action, targetId: audit.targetId, result: 'succeeded' })
    expect(next.eventId).not.toBe('seed:old')
    expect(next.requestId).toBe('seed:real-demo:new-run-20260821:0')
    expect(next._id).toBeDefined()
  })
})
