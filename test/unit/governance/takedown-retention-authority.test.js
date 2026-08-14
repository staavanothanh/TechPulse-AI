import { describe, expect, it, vi } from 'vitest'
import { ObjectId } from 'mongodb'
import { MongoTakedownRepository } from '../../../server/repositories/mongo/takedown-repository.js'
import { serializeTakedownDetail } from '../../../server/application/takedowns/repository.js'
import { createStep11Mongo } from '../../helpers/step11-mongo.js'
import { buildGovernanceRetentionHardeningMigration, GOVERNANCE_RETENTION_TAKEDOWN_VALIDATOR } from '../../../scripts/migrations/governance-retention-hardening.js'

const cutoff = new Date('2026-08-14T00:00:00.000Z')
const due = new Date('2026-08-13T00:00:00.000Z')

function completion() {
  return {
    hidden: true,
    metadataRemoved: true,
    mediaMetadataRemoved: false,
    summaryRemoved: false,
    embeddingRemoved: false,
    historicalChatCitationsRedacted: true,
  }
}

function request(_id, overrides = {}) {
  return {
    _id,
    status: 'completed',
    requesterName: 'Rights team',
    requesterContact: 'rights@example.test',
    targetType: 'article',
    targetIds: [new ObjectId('507f1f77bcf86cd799439011')],
    reason: 'Rights request',
    evidenceNote: 'Evidence is retained only before the PII deadline.',
    requestedScope: ['metadata'],
    decisionReasonCode: 'takedown_completed',
    completion: completion(),
    completedAt: due,
    piiPurgeAfter: due,
    workflowPurgeAfter: new Date('2026-08-15T00:00:00.000Z'),
    createdAt: due,
    updatedAt: due,
    ...overrides,
  }
}

describe('takedown retention authority', () => {
  it('serializes a PII-complete detail before the deadline', () => {
    expect(serializeTakedownDetail(request(new ObjectId('507f1f77bcf86cd799439001')))).toEqual(expect.objectContaining({
      requesterName: 'Rights team',
      requesterContact: 'rights@example.test',
      reason: 'Rights request',
      evidenceNote: 'Evidence is retained only before the PII deadline.',
    }))
  })

  it('serializes one canonical redacted detail after the PII fields are unset', () => {
    const document = request(new ObjectId('507f1f77bcf86cd799439002'))
    for (const field of ['requesterName', 'requesterContact', 'reason', 'evidenceNote']) delete document[field]
    const result = serializeTakedownDetail(document)
    expect(result).toEqual(expect.objectContaining({
      id: document._id.toHexString(),
      status: 'completed',
      targetType: 'article',
      targetIds: [document.targetIds[0].toHexString()],
      requestedScope: ['metadata'],
      decisionReasonCode: 'takedown_completed',
    }))
    expect(result).not.toHaveProperty('requesterName')
    expect(result).not.toHaveProperty('requesterContact')
    expect(result).not.toHaveProperty('reason')
    expect(result).not.toHaveProperty('evidenceNote')
  })

  it('rejects a partial or non-terminal redacted detail shape', () => {
    const partial = request(new ObjectId('507f1f77bcf86cd799439003'))
    delete partial.requesterContact
    expect(() => serializeTakedownDetail(partial)).toThrow(/retention shape/i)

    const nonTerminal = request(new ObjectId('507f1f77bcf86cd799439004'), { status: 'reviewing' })
    for (const field of ['requesterName', 'requesterContact', 'reason', 'evidenceNote']) delete nonTerminal[field]
    expect(() => serializeTakedownDetail(nonTerminal)).toThrow(/retention shape/i)
  })

  it('purges only due terminal requests in stable deadline plus _id pages', async () => {
    const ids = ['001', '002', '003', '004'].map((suffix) => new ObjectId(`507f1f77bcf86cd79943${suffix.padStart(4, '0')}`))
    const mongo = createStep11Mongo({ app: {
      takedownRequests: [
        request(ids[0]),
        request(ids[1]),
        request(ids[2], { status: 'reviewing' }),
        request(ids[3], { piiPurgeAfter: new Date('2026-08-15T00:00:00.000Z') }),
      ],
    } })
    const repository = new MongoTakedownRepository({ db: mongo.db, client: mongo.client, now: () => cutoff })

    await expect(repository.purgePii({ cutoff, limit: 2 })).resolves.toEqual({ inspected: 2, affected: 2, hasMore: false })
    const rows = await mongo.db.collection('takedownRequests').find({}).toArray()
    expect(rows[0]).not.toHaveProperty('requesterName')
    expect(rows[0]).not.toHaveProperty('requesterContact')
    expect(rows[0]).not.toHaveProperty('reason')
    expect(rows[0]).not.toHaveProperty('evidenceNote')
    expect(rows[0]).not.toHaveProperty('piiPurgeAfter')
    expect(rows[1]).not.toHaveProperty('requesterName')
    expect(rows[2]).toHaveProperty('requesterName')
    expect(rows[3]).toHaveProperty('requesterName')
    expect(mongo.db.hints).toContainEqual({ collection: 'takedownRequests', hint: 'takedown_pii_deadline' })
  })

  it('rejects an unbounded retention batch before querying MongoDB', async () => {
    const find = vi.fn()
    const repository = new MongoTakedownRepository({ db: { collection: () => ({ find }) }, now: () => cutoff })
    await expect(repository.purgePii({ cutoff, limit: 101 })).rejects.toMatchObject({ status: 422, code: 'validation_error' })
    expect(find).not.toHaveBeenCalled()
  })

  it('provides a next migration that accepts only the closed terminal detail branch', () => {
    const plan = buildGovernanceRetentionHardeningMigration({ dryRun: true })
    expect(plan).toEqual([expect.objectContaining({ type: 'collMod', collection: 'takedownRequests', dryRun: true })])
    expect(GOVERNANCE_RETENTION_TAKEDOWN_VALIDATOR.$or).toHaveLength(2)
    expect(GOVERNANCE_RETENTION_TAKEDOWN_VALIDATOR.$or[1].$jsonSchema.additionalProperties).toBe(false)
    expect(GOVERNANCE_RETENTION_TAKEDOWN_VALIDATOR.$or[1].$jsonSchema.required).not.toContain('requesterName')
    expect(GOVERNANCE_RETENTION_TAKEDOWN_VALIDATOR.$or[1].$jsonSchema.properties).not.toHaveProperty('piiPurgeAfter')
    expect(GOVERNANCE_RETENTION_TAKEDOWN_VALIDATOR.$or[1].$jsonSchema.properties).toHaveProperty('workflowPurgeAfter')
    expect(GOVERNANCE_RETENTION_TAKEDOWN_VALIDATOR.$or[1].$jsonSchema.required).toContain('workflowPurgeAfter')
    expect(GOVERNANCE_RETENTION_TAKEDOWN_VALIDATOR.$or[1].$jsonSchema.properties.workflowPurgeAfter).toEqual({ bsonType: 'date' })
    expect(GOVERNANCE_RETENTION_TAKEDOWN_VALIDATOR.$or[1].$jsonSchema.properties.completedAt).toEqual({ bsonType: 'date' })
    expect(GOVERNANCE_RETENTION_TAKEDOWN_VALIDATOR.$or[0].$and[1]).toEqual({
      $or: [
        { status: { $nin: ['rejected', 'completed'] } },
        {
          $and: [
            { status: { $in: ['rejected', 'completed'] } },
            { completedAt: { $type: 'date' } },
            { piiPurgeAfter: { $type: 'date' } },
            { workflowPurgeAfter: { $type: 'date' } },
          ],
        },
      ],
    })
    expect(GOVERNANCE_RETENTION_TAKEDOWN_VALIDATOR.$or[1].$jsonSchema.properties.status.enum).toEqual(['rejected', 'completed'])
  })
})
