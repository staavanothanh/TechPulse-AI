import { describe, expect, it } from 'vitest'
import {
  applySourceUpdate,
  createDraftSource,
  requestPolicyReReview,
  reviewSourcePolicy,
  transitionOperationalStatus,
} from '../../../server/domain/source/state-machine.js'

const now = new Date('2026-08-10T00:00:00.000Z')
const connector = { name: 'Example', sourceKey: 'rss:example', publisherName: 'Example Publisher', domain: 'example.com', connectorType: 'rss', accessMethod: 'rss', authorityTier: 'editorial', connectorConfig: { kind: 'rss', feedUrl: 'https://example.com/feed.xml', batchSize: 20 } }
const review = { licenseStatus: 'metadata-only', llmInputScope: 'metadata', storageScope: { metadata: true, excerpt: false, summary: true, embedding: true }, mediaPolicy: { imageMode: 'none', videoMode: 'none', allowedHosts: [], attributionRequired: false, evidenceNote: null }, attributionRequired: true, attributionText: 'Nguồn Example', termsUrl: 'https://example.com/terms', licenseUrl: null, evidenceNote: 'Reviewed publisher terms.', reasonCode: 'source_policy_reviewed' }

function reviewedTestingSource() {
  let source = createDraftSource(connector, { id: 'source-reviewed', now })
  source = transitionOperationalStatus(source, 'testing', { now }).source
  source.technicalCheck = { status: 'passed', checkedAt: now, contentType: 'application/rss+xml', resolvedHost: 'example.com', sampleCount: 1, error: null }
  return reviewSourcePolicy(source, review, { reviewerId: 'admin-1', now }).source
}

describe('Source state, policy version and reconciliation marker', () => {
  it('enforces the complete operational transition matrix', () => {
    const statuses = ['draft', 'testing', 'active', 'paused', 'archived']
    const allowed = new Set(['draft:testing', 'testing:active', 'testing:paused', 'active:paused', 'paused:active', 'paused:archived'])
    for (const from of statuses) {
      for (const to of statuses) {
        const candidate = createDraftSource(connector, { id: 'source-matrix', now })
        candidate.operationalStatus = from
        candidate.technicalCheck = { status: 'passed', checkedAt: now, contentType: 'application/rss+xml', resolvedHost: 'example.com', sampleCount: 1, error: null }
        candidate.licenseStatus = 'metadata-only'
        candidate.llmInputScope = 'metadata'
        candidate.storageScope = { metadata: true, excerpt: false, summary: true, embedding: true }
        candidate.attributionRequired = true
        candidate.attributionText = 'Example Publisher'
        candidate.evidenceNote = 'Human review evidence.'
        candidate.reviewedAt = now
        candidate.reviewedBy = 'admin-1'
        const operation = () => transitionOperationalStatus(candidate, to, { now })
        if (allowed.has(`${from}:${to}`)) expect(operation()).toEqual(expect.objectContaining({ source: expect.objectContaining({ operationalStatus: to }), stateTransition: { from, to } }))
        else expect(operation).toThrow(/transition/i)
      }
    }
  })

  it('creates a closed draft without granting text or media rights', () => {
    const source = createDraftSource(connector, { id: 'source-1', now })
    expect(source).toEqual(expect.objectContaining({ operationalStatus: 'draft', licenseStatus: 'review-needed', llmInputScope: 'none', policyVersion: 1 }))
    expect(source.storageScope).toEqual({ metadata: false, excerpt: false, summary: false, embedding: false })
    expect(source.mediaPolicy).toEqual(expect.objectContaining({ imageMode: 'none', videoMode: 'none', allowedHosts: [] }))
    expect(source.reconciliation).toEqual({ status: 'idle', requiredPolicyVersion: 1, completedPolicyVersion: null, requestedAt: null, error: null })
  })

  it('increments exactly once for a multi-field ingestion-affecting update and writes the matching marker', () => {
    const source = createDraftSource(connector, { id: 'source-1', now })
    const result = applySourceUpdate(source, {
      domain: 'feeds.example.com',
      connectorConfig: { kind: 'rss', feedUrl: 'https://feeds.example.com/atom.xml', batchSize: 30 },
      mediaPolicy: { imageMode: 'remote-preview', videoMode: 'none', allowedHosts: ['images.example.com'], attributionRequired: true, evidenceNote: 'Remote preview allowed.' },
      attributionRequired: true,
      attributionText: 'Example Publisher',
      reasonCode: 'source_configuration_changed',
    }, { now: new Date('2026-08-11T00:00:00.000Z') })
    expect(result.source.policyVersion).toBe(2)
    expect(result.source.reconciliation).toEqual({ status: 'pending', requiredPolicyVersion: 2, completedPolicyVersion: null, requestedAt: new Date('2026-08-11T00:00:00.000Z'), error: null })
    expect(result.versionChanged).toBe(true)
  })

  it('atomically applies a configuration plus status transition with one policy increment', () => {
    const source = createDraftSource(connector, { id: 'source-mixed', now })
    const result = applySourceUpdate(source, { domain: 'feeds.example.com', operationalStatus: 'testing', reasonCode: 'source_configuration_changed' }, { now: new Date('2026-08-11T00:00:00.000Z') })
    expect(result.source).toEqual(expect.objectContaining({ domain: 'feeds.example.com', operationalStatus: 'testing', policyVersion: 2 }))
    expect(result.reconciliation ?? result.source.reconciliation).toEqual(expect.objectContaining({ status: 'pending', requiredPolicyVersion: 2 }))
    expect(result.changedFields).toEqual(['domain', 'operationalStatus'])
    expect(result.stateTransition).toEqual({ from: 'draft', to: 'testing' })
  })

  it('does not increment policy version for display-name or status-only mutation', () => {
    const source = createDraftSource(connector, { id: 'source-1', now })
    const renamed = applySourceUpdate(source, { name: 'Renamed', reasonCode: 'source_configuration_changed' }, { now })
    expect(renamed.source.policyVersion).toBe(1)
    const testing = transitionOperationalStatus(renamed.source, 'testing', { now })
    expect(testing.source.policyVersion).toBe(1)
  })

  it.each([
    ['publisherName', 'Changed Publisher'],
    ['domain', 'changed.example.com'],
    ['authorityTier', 'primary'],
    ['connectorConfig', { kind: 'rss', feedUrl: 'https://changed.example.com/feed.xml', batchSize: 30 }],
    ['mediaPolicy', { imageMode: 'remote-preview', videoMode: 'none', allowedHosts: ['media.example.com'], attributionRequired: true, evidenceNote: 'Reviewed media rights.' }],
    ['attributionText', 'Changed attribution'],
  ])('requires re-review before changing rights-affecting field %s', (field, value) => {
    const source = reviewedTestingSource()
    expect(() => applySourceUpdate(source, { [field]: value, reasonCode: 'source_configuration_changed' }, { now: new Date('2026-08-11T00:00:00.000Z') })).toThrow(/re-review/i)
  })

  it('invalidates technical evidence after re-review and blocks checked-A to changed-B activation', () => {
    const reviewed = reviewedTestingSource()
    expect(() => applySourceUpdate(reviewed, { domain: 'b.example.com', operationalStatus: 'active', reasonCode: 'source_configuration_changed' }, { now: new Date('2026-08-11T00:00:00.000Z') })).toThrow(/re-review/i)

    const awaitingReview = requestPolicyReReview(reviewed, { reviewerId: 'admin-1', now: new Date('2026-08-11T00:00:00.000Z') }).source
    const changed = applySourceUpdate(awaitingReview, { domain: 'b.example.com', reasonCode: 'source_configuration_changed' }, { now: new Date('2026-08-12T00:00:00.000Z') })
    expect(changed.source.technicalCheck).toEqual({ status: 'not-run', checkedAt: null, contentType: null, resolvedHost: null, sampleCount: null, error: null })
    expect(changed.changedFields).toContain('technicalCheck')
    expect(() => transitionOperationalStatus(changed.source, 'active', { now: new Date('2026-08-13T00:00:00.000Z') })).toThrow(/technical|policy/i)
  })

  it('uses server-owned reviewer/time and blocks activation until technical and rights prerequisites pass', () => {
    let source = createDraftSource(connector, { id: 'source-1', now })
    source = transitionOperationalStatus(source, 'testing', { now }).source
    expect(() => transitionOperationalStatus(source, 'active', { now })).toThrow(/technical|policy/i)
    source.technicalCheck = { status: 'passed', checkedAt: now, contentType: 'application/rss+xml', resolvedHost: 'example.com', sampleCount: 1, error: null }
    source = reviewSourcePolicy(source, review, { reviewerId: 'admin-1', now }).source
    const active = transitionOperationalStatus(source, 'active', { now }).source
    expect(active.operationalStatus).toBe('active')
    expect(active.reviewedBy).toBe('admin-1')
    expect(active.reviewedAt).toEqual(now)
  })

  it('cannot activate a permitted source when human evidence text is missing', () => {
    const source = createDraftSource(connector, { id: 'source-evidence', now })
    source.operationalStatus = 'testing'
    source.technicalCheck = { status: 'passed', checkedAt: now, contentType: 'application/rss+xml', resolvedHost: 'example.com', sampleCount: 1, error: null }
    source.licenseStatus = 'permitted'
    source.llmInputScope = 'metadata'
    source.storageScope = { metadata: true, excerpt: false, summary: true, embedding: true }
    source.reviewedAt = now
    source.reviewedBy = 'admin-1'
    source.evidenceNote = null
    expect(() => transitionOperationalStatus(source, 'active', { now })).toThrow(/evidence|review/i)
  })

  it('re-review pauses active source, clears rights and advances one durable marker version', () => {
    let source = createDraftSource(connector, { id: 'source-1', now })
    source.technicalCheck = { status: 'passed', checkedAt: now, contentType: 'application/rss+xml', resolvedHost: 'example.com', sampleCount: 1, error: null }
    source = reviewSourcePolicy(source, review, { reviewerId: 'admin-1', now }).source
    source.operationalStatus = 'active'
    const result = requestPolicyReReview(source, { reviewerId: 'admin-2', now: new Date('2026-08-12T00:00:00.000Z') })
    expect(result.source).toEqual(expect.objectContaining({ operationalStatus: 'paused', licenseStatus: 'review-needed', llmInputScope: 'none', policyVersion: 3 }))
    expect(result.source.storageScope).toEqual({ metadata: false, excerpt: false, summary: false, embedding: false })
    expect(result.source.reconciliation.requiredPolicyVersion).toBe(3)
  })
})
