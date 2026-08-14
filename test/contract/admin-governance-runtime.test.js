import Ajv from 'ajv'
import addFormats from 'ajv-formats'
import { describe, expect, it } from 'vitest'
import { loadOpenApi } from '../../scripts/contracts/openapi-utils.js'
import { runAdminGovernanceContractFixtures } from '../../scripts/contracts/admin-governance-fixtures.js'

const document = loadOpenApi()

function schemaValidator(name) {
  const ajv = new Ajv({ allErrors: true, strict: false })
  addFormats(ajv)
  ajv.addSchema({ ...document, $id: 'techpulse-openapi-admin-audit' })
  return ajv.compile({ $ref: `techpulse-openapi-admin-audit#/components/schemas/${name}` })
}

const AUTH_AUDIT = Object.freeze({
  id: '507f1f77bcf86cd799439023',
  actorType: 'user',
  actorId: '507f1f77bcf86cd799439013',
  action: 'user_logged_in',
  targetType: 'user',
  targetId: '507f1f77bcf86cd799439013',
  changedFields: [],
  stateTransition: null,
  reasonCode: 'user_login',
  requestId: 'contract-auth-login-0001',
  result: 'succeeded',
  createdAt: '2026-08-13T00:00:00.000Z',
})

describe('Step 11 admin governance OpenAPI runtime contract', () => {
  it('validates canonical success and error responses across every governance surface', async () => {
    const result = await runAdminGovernanceContractFixtures({ document })

    expect(result.cases).toBeGreaterThanOrEqual(28)
  })

  it('accepts system-auth audit reasons but rejects an unknown reason', () => {
    const validate = schemaValidator('AuditLog')
    const validateAdminReason = schemaValidator('AdminReasonCode')

    for (const reasonCode of ['user_registered', 'user_login', 'user_logout', 'preferences_updated']) {
      expect(validate({ ...AUTH_AUDIT, reasonCode })).toBe(true)
      expect(validateAdminReason(reasonCode)).toBe(false)
    }

    expect(validate({ ...AUTH_AUDIT, reasonCode: 'unknown_reason' })).toBe(false)
  })

  it('validates full and redacted takedown details without permitting PII on the redacted branch', () => {
    const validate = schemaValidator('TakedownRequest')
    const full = {
      id: '507f1f77bcf86cd799439014', status: 'reviewing', requesterName: 'Rights team', requesterContact: 'rights@example.test',
      targetType: 'article', targetIds: ['507f1f77bcf86cd799439011'], reason: 'Rights request', evidenceNote: null,
      requestedScope: ['metadata'], decisionReasonCode: 'takedown_review_started',
      completion: { hidden: false, metadataRemoved: false, mediaMetadataRemoved: false, summaryRemoved: false, embeddingRemoved: false, historicalChatCitationsRedacted: false },
      completedAt: null, createdAt: '2026-08-13T00:00:00.000Z', updatedAt: '2026-08-13T00:00:00.000Z',
    }
    const redacted = {
      id: '507f1f77bcf86cd799439014', status: 'completed', targetType: 'article', targetIds: ['507f1f77bcf86cd799439011'],
      requestedScope: ['metadata'], decisionReasonCode: 'takedown_completed',
      completion: { hidden: true, metadataRemoved: true, mediaMetadataRemoved: false, summaryRemoved: false, embeddingRemoved: false, historicalChatCitationsRedacted: true },
      completedAt: '2026-08-14T00:00:00.000Z', createdAt: '2026-08-13T00:00:00.000Z', updatedAt: '2026-08-14T00:00:00.000Z',
    }

    expect(validate(full)).toBe(true)
    expect(validate(redacted)).toBe(true)
    expect(validate({ ...redacted, completedAt: null })).toBe(false)
    expect(validate({ ...redacted, status: 'reviewing' })).toBe(false)
    expect(validate({ ...redacted, requesterName: 'must not be returned' })).toBe(false)
  })

  it('validates the removed admin article tombstone and rejects retained metadata', () => {
    const validateSummary = schemaValidator('AdminArticle')
    const validateDetail = schemaValidator('AdminArticleDetail')
    const tombstone = { id: '507f1f77bcf86cd799439010', sourceId: '507f1f77bcf86cd799439011', status: 'removed', removalPolicyVersion: 4, removedAt: '2026-08-14T00:00:00.000Z', updatedAt: '2026-08-14T00:00:00.000Z' }
    expect(validateSummary(tombstone)).toBe(true)
    expect(validateDetail(tombstone)).toBe(true)
    expect(validateDetail({ ...tombstone, titleOriginal: 'must not remain' })).toBe(false)
    expect(validateDetail({ ...tombstone, originalUrl: 'https://private.example/article' })).toBe(false)
  })
})
