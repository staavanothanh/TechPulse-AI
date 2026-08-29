import Ajv from 'ajv'
import addFormats from 'ajv-formats'
import { describe, expect, it } from 'vitest'
import { loadOpenApi } from '../../scripts/contracts/openapi-utils.js'
import { runAdminSourcesContractFixtures } from '../../scripts/contracts/admin-sources-fixtures.js'

const document = loadOpenApi()
const ajv = new Ajv({ allErrors: true, strict: false })
addFormats(ajv)
ajv.addSchema({ ...document, $id: 'techpulse-openapi-source-tests' })
const validate = (name, value) => ajv.compile({ $ref: `techpulse-openapi-source-tests#/components/schemas/${name}` })(value)

const connector = { name: 'Example', sourceKey: 'rss:example', publisherName: 'Example Publisher', domain: 'example.com', connectorType: 'rss', accessMethod: 'rss', authorityTier: 'editorial', connectorConfig: { kind: 'rss', feedUrl: 'https://example.com/feed.xml', batchSize: 20 } }
const storage = { metadata: true, excerpt: false, summary: true, embedding: true }
const media = { imageMode: 'none', videoMode: 'none', allowedHosts: [], attributionRequired: false, evidenceNote: null }

describe('admin Source Registry OpenAPI contract', () => {
  it('validates serialized success and error responses for every Source operation', async () => {
    const result = await runAdminSourcesContractFixtures({ document })
    expect(result.cases).toBeGreaterThanOrEqual(17)
  })

  it('contains all nine Source Registry operation IDs', () => {
    const ids = Object.entries(document.paths).filter(([path]) => path.includes('/admin/sources')).flatMap(([, item]) => Object.values(item).map((operation) => operation.operationId)).filter(Boolean)
    expect(ids.sort()).toEqual(['createSource', 'getSource', 'getSourcePolicyReconciliation', 'listSources', 'requestSourcePolicyReReview', 'reviewSourcePolicy', 'runSourcePolicyReconciliation', 'runSourceTechnicalCheck', 'updateSource'].sort())
    expect(Object.entries(document.paths).filter(([path]) => path.includes('/admin/sources')).some(([, item]) => Object.hasOwn(item, 'delete'))).toBe(false)
  })

  it('rejects connector discriminant and authority mismatches', () => {
    expect(validate('SourceCreateRequest', connector)).toBe(true)
    expect(validate('SourceCreateRequest', { ...connector, accessMethod: 'api' })).toBe(false)
    expect(validate('SourceCreateRequest', { ...connector, connectorType: 'hacker-news', accessMethod: 'api', authorityTier: 'primary', connectorConfig: { kind: 'hacker-news', hackerNewsStream: 'topstories', batchSize: 20 } })).toBe(false)
  })

  it('rejects incompatible policy and missing/empty attribution', () => {
    const base = { licenseStatus: 'metadata-only', llmInputScope: 'metadata', storageScope: storage, mediaPolicy: media, attributionRequired: true, attributionText: 'Example Publisher', evidenceNote: 'Reviewed publisher terms.', reasonCode: 'source_policy_reviewed' }
    expect(validate('PolicyReviewRequest', base)).toBe(true)
    expect(validate('PolicyReviewRequest', { ...base, llmInputScope: 'excerpt' })).toBe(false)
    expect(validate('PolicyReviewRequest', { ...base, attributionText: '' })).toBe(false)
    expect(validate('PolicyReviewRequest', { ...base, attributionText: null })).toBe(false)
    const missing = { ...base }; delete missing.attributionText
    expect(validate('PolicyReviewRequest', missing)).toBe(false)
    expect(validate('PolicyReviewRequest', { ...base, reviewedBy: '507f1f77bcf86cd799439012' })).toBe(false)
    expect(validate('PolicyReviewRequest', { ...base, reviewedAt: '2026-08-10T00:00:00.000Z' })).toBe(false)
  })

  it('rejects invalid terminal reconciliation shapes at the HTTP boundary', () => {
    expect(validate('SourceReconciliation', { status: 'completed', requiredPolicyVersion: 2, completedPolicyVersion: null, requestedAt: '2026-08-10T00:00:00.000Z', error: null })).toBe(false)
    expect(validate('SourceReconciliation', { status: 'failed', requiredPolicyVersion: 2, completedPolicyVersion: null, requestedAt: '2026-08-10T00:00:00.000Z', error: null })).toBe(false)
  })
})
