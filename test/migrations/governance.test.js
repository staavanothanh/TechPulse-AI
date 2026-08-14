import { describe, expect, it } from 'vitest'
import {
  GOVERNANCE_COLLECTIONS,
  GOVERNANCE_INDEXES,
  buildGovernanceMigration,
  buildGovernanceDatabaseMigration,
  validateTakedownRequestDocument,
  validateAccountDeletionRequestDocument,
} from '../../scripts/migrations/governance.js'
import { GOVERNANCE_HARDENING_INDEXES, buildGovernanceHardeningMigration } from '../../scripts/migrations/governance-hardening.js'
import { ObjectId } from 'mongodb'

const now = new Date('2026-08-13T00:00:00.000Z')

function takedown(overrides = {}) {
  return {
    _id: new ObjectId(), status: 'received', requesterName: 'Publisher', requesterContact: 'legal@example.com',
    targetType: 'article', targetIds: [new ObjectId()], reason: 'Rights request', requestedScope: ['metadata'],
    decisionReasonCode: null, completion: {
      hidden: false, metadataRemoved: false, mediaMetadataRemoved: false, summaryRemoved: false,
      embeddingRemoved: false, historicalChatCitationsRedacted: false,
    }, completedAt: null, createdAt: now, updatedAt: now, ...overrides,
  }
}

function deletion(overrides = {}) {
  return {
    _id: new ObjectId(), userId: new ObjectId(), actorScope: 'user:opaque', idempotencyKey: 'delete-key',
    requestHash: 'a'.repeat(64), status: 'queued', attempt: 1, priority: 50, availableAt: now,
    agingEligibleAt: new Date(now.getTime() + 300000), idempotencyExpiresAt: new Date(now.getTime() + 14 * 86400000),
    leaseGeneration: 0, safeReasonCategory: 'user-request', completion: {
      sessionsRevoked: true, sessionsDeleted: false, savedArticlesDeleted: false, chatSessionsDeleted: false,
      answerAttemptsDeleted: false, userQuotaDataDeleted: false, identityAnonymized: false,
    }, error: null, requestedAt: now, startedAt: null, completedAt: null, updatedAt: now, ...overrides,
  }
}

describe('Step 11 governance migration contract', () => {
  it('owns takedown and account-deletion collections with deadline indexes', () => {
    expect(Object.keys(GOVERNANCE_COLLECTIONS)).toEqual(['takedownRequests', 'accountDeletionRequests'])
    expect(GOVERNANCE_HARDENING_INDEXES.takedownRequests).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: 'takedown_cleanup_due', key: { status: 1, 'completion.historicalChatCitationsRedacted': 1, updatedAt: 1, _id: 1 } }),
    ]))
    expect(GOVERNANCE_INDEXES.takedownRequests).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: 'takedown_pii_deadline', key: { piiPurgeAfter: 1, _id: 1 } }),
      expect.objectContaining({ name: 'takedown_workflow_deadline', key: { workflowPurgeAfter: 1, _id: 1 } }),
      expect.objectContaining({ name: 'takedown_target_lookup', key: { targetType: 1, targetIds: 1 } }),
    ]))
    expect(GOVERNANCE_INDEXES.accountDeletionRequests).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: 'account_deletion_user_unique', options: { unique: true } }),
      expect.objectContaining({ name: 'account_deletion_purge_deadline', key: { purgeAfter: 1, _id: 1 } }),
    ]))
  })

  it('includes app and governance database plans without destructive operations', () => {
    const app = buildGovernanceMigration({ dryRun: true })
    const governance = buildGovernanceDatabaseMigration({ dryRun: true })
    const hardening = buildGovernanceHardeningMigration({ dryRun: true })
    expect([...app, ...hardening, ...governance].every((operation) => ['createCollection', 'collMod', 'createIndex'].includes(operation.type))).toBe(true)
  })

  it('does not register a PII purge operation until the 90-180 day DTO authority is resolved', () => {
    const app = buildGovernanceMigration({ dryRun: true })
    expect(app.some((operation) => operation.type === 'updateMany' || operation.type === 'unset')).toBe(false)
  })

  it('validates strict takedown PII and seven-flag deletion documents', () => {
    expect(validateTakedownRequestDocument(takedown())).toEqual({ valid: true, errors: [] })
    expect(validateTakedownRequestDocument(takedown({ requesterContact: null })).valid).toBe(false)
    const purged = takedown({ status: 'completed', piiPurgeAfter: now, completion: { hidden: true, metadataRemoved: true, mediaMetadataRemoved: false, summaryRemoved: false, embeddingRemoved: false, historicalChatCitationsRedacted: true } })
    for (const field of ['requesterName', 'requesterContact', 'reason', 'evidenceNote']) delete purged[field]
    expect(validateTakedownRequestDocument(purged).valid).toBe(false)
    expect(validateTakedownRequestDocument({ ...purged, requesterName: 'retained' }).valid).toBe(false)
    expect(validateAccountDeletionRequestDocument(deletion())).toEqual({ valid: true, errors: [] })
    expect(validateAccountDeletionRequestDocument(deletion({ safeReasonCategory: 'free-form' })).valid).toBe(false)
    expect(validateAccountDeletionRequestDocument(deletion({ completion: { ...deletion().completion, identityAnonymized: true }, status: 'completed', error: { code: 'bad' } })).valid).toBe(false)
  })
})
