import { ObjectId } from 'mongodb'
import { describe, expect, it } from 'vitest'
import {
  SOURCE_COLLECTIONS,
  SOURCE_AUDIT_VALIDATOR,
  SOURCE_INDEXES,
  buildSourcesMigration,
  validateSourceDocument,
} from '../../scripts/migrations/sources.js'

function validSource() {
  const now = new Date('2026-08-10T00:00:00.000Z')
  return {
    _id: new ObjectId(), name: 'Example', sourceKey: 'rss:example', publisherName: 'Example Publisher', domain: 'example.com',
    connectorType: 'rss', accessMethod: 'rss', authorityTier: 'editorial', connectorConfig: { kind: 'rss', feedUrl: 'https://example.com/feed.xml', batchSize: 20 },
    operationalStatus: 'draft', licenseStatus: 'review-needed', llmInputScope: 'none',
    storageScope: { metadata: false, excerpt: false, summary: false, embedding: false },
    mediaPolicy: { imageMode: 'none', videoMode: 'none', allowedHosts: [], attributionRequired: false, evidenceNote: null },
    attributionRequired: false, policyVersion: 1,
    reconciliation: { status: 'idle', requiredPolicyVersion: 1, completedPolicyVersion: null, requestedAt: null, error: null },
    technicalCheck: { status: 'not-run', checkedAt: null, contentType: null, resolvedHost: null, sampleCount: null, error: null },
    health: { lastIngestSucceededAt: null, lastIngestFailedAt: null, consecutiveFailures: 0, lastError: null },
    createdAt: now, updatedAt: now,
  }
}

describe('sources migration contract', () => {
  it('creates a strict sources validator and exact required indexes idempotently', () => {
    expect(SOURCE_COLLECTIONS.sources.validator).toBeTruthy()
    expect(SOURCE_INDEXES.sources).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: 'sources_key_unique', key: { sourceKey: 1 }, options: { unique: true } }),
      expect.objectContaining({ name: 'sources_connector_status', key: { connectorType: 1, operationalStatus: 1 } }),
      expect.objectContaining({ name: 'sources_license_reviewed', key: { licenseStatus: 1, reviewedAt: 1 } }),
      expect.objectContaining({ name: 'sources_reconciliation', key: { 'reconciliation.status': 1, 'reconciliation.requiredPolicyVersion': 1 } }),
    ]))
    const first = buildSourcesMigration({ existingCollections: [], existingIndexes: {} })
    const rerun = buildSourcesMigration({ existingCollections: ['sources'], existingIndexes: { sources: SOURCE_INDEXES.sources.map((index) => index.name) } })
    expect(first.length).toBeGreaterThan(0)
    expect(rerun.filter((operation) => operation.type === 'createIndex')).toHaveLength(0)
    expect(SOURCE_AUDIT_VALIDATOR).toBeTruthy()
    expect(first).toEqual(expect.arrayContaining([expect.objectContaining({ type: 'collMod', collection: 'adminAuditLogs' })]))
  })

  it('accepts a closed draft and rejects matrix, connector, attribution and reconciliation drift', () => {
    expect(validateSourceDocument(validSource())).toEqual({ valid: true, errors: [] })
    const connectorMismatch = validSource(); connectorMismatch.authorityTier = 'community-signal'
    expect(validateSourceDocument(connectorMismatch).valid).toBe(false)
    const attribution = validSource(); attribution.attributionRequired = true
    expect(validateSourceDocument(attribution).valid).toBe(false)
    const completedMismatch = validSource(); completedMismatch.reconciliation = { status: 'completed', requiredPolicyVersion: 2, completedPolicyVersion: 1, requestedAt: new Date(), error: null }
    expect(validateSourceDocument(completedMismatch).valid).toBe(false)
    const missingReviewEvidence = validSource(); missingReviewEvidence.licenseStatus = 'metadata-only'; missingReviewEvidence.llmInputScope = 'metadata'; missingReviewEvidence.storageScope.metadata = true
    expect(validateSourceDocument(missingReviewEvidence).valid).toBe(false)
  })
})
