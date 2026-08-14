import { GOVERNANCE_COLLECTIONS } from './governance.js'

const objectId = Object.freeze({ bsonType: 'objectId' })
const nullableObjectId = Object.freeze({ bsonType: ['objectId', 'null'] })
const date = Object.freeze({ bsonType: 'date' })
const nullableDate = Object.freeze({ bsonType: ['date', 'null'] })

const completion = Object.freeze({
  bsonType: 'object',
  additionalProperties: false,
  required: ['hidden', 'metadataRemoved', 'mediaMetadataRemoved', 'summaryRemoved', 'embeddingRemoved', 'historicalChatCitationsRedacted'],
  properties: Object.fromEntries(['hidden', 'metadataRemoved', 'mediaMetadataRemoved', 'summaryRemoved', 'embeddingRemoved', 'historicalChatCitationsRedacted'].map((field) => [field, { bsonType: 'bool' }])),
})

const redactedTakedownSchema = Object.freeze({
  bsonType: 'object',
  additionalProperties: false,
  required: ['_id', 'status', 'targetType', 'targetIds', 'requestedScope', 'decisionReasonCode', 'completion', 'completedAt', 'workflowPurgeAfter', 'createdAt', 'updatedAt'],
  properties: {
    _id: objectId,
    status: { enum: ['rejected', 'completed'] },
    targetType: { enum: ['source', 'article'] },
    targetIds: { bsonType: 'array', minItems: 1, maxItems: 100, uniqueItems: true, items: objectId },
    requestedScope: { bsonType: 'array', minItems: 1, uniqueItems: true, items: { enum: ['metadata', 'media-metadata', 'summary', 'embedding'] } },
    decisionReasonCode: { bsonType: ['string', 'null'], maxLength: 128 },
    reviewedBy: nullableObjectId,
    reviewedAt: nullableDate,
    completion,
    completedAt: date,
    workflowPurgeAfter: date,
    createdAt: date,
    updatedAt: date,
  },
})

export const GOVERNANCE_RETENTION_TAKEDOWN_VALIDATOR = Object.freeze({
  $or: [
    {
      $and: [
        GOVERNANCE_COLLECTIONS.takedownRequests.validator,
        {
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
        },
      ],
    },
    { $jsonSchema: redactedTakedownSchema },
  ],
})

export function buildGovernanceRetentionHardeningMigration({ dryRun = false } = {}) {
  return [{
    type: 'collMod',
    collection: 'takedownRequests',
    validator: GOVERNANCE_RETENTION_TAKEDOWN_VALIDATOR,
    validationLevel: 'strict',
    validationAction: 'error',
    ...(dryRun ? { dryRun: true } : {}),
  }]
}

export async function runGovernanceRetentionHardeningMigration({ db, dryRun = false } = {}) {
  const plan = buildGovernanceRetentionHardeningMigration({ dryRun })
  if (dryRun) return plan
  if (!db || typeof db.command !== 'function') throw new Error('MongoDB database is required')
  for (const operation of plan) await db.command({ collMod: operation.collection, validator: operation.validator, validationLevel: operation.validationLevel, validationAction: operation.validationAction })
  return plan
}

export { redactedTakedownSchema }
