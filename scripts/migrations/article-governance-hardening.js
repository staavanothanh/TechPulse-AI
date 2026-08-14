import { ARTICLE_COLLECTIONS } from './articles.js'

const objectId = Object.freeze({ bsonType: 'objectId' })
const date = Object.freeze({ bsonType: 'date' })

const removedArticleTombstoneSchema = Object.freeze({
  bsonType: 'object',
  additionalProperties: false,
  required: ['_id', 'sourceId', 'connectorType', 'canonicalUrlHash', 'status', 'evidenceEligible', 'removalPolicyVersion', 'removedAt', 'createdAt', 'updatedAt'],
  properties: {
    _id: objectId,
    sourceId: objectId,
    connectorType: { enum: ['rss', 'arxiv', 'hacker-news'] },
    externalId: { bsonType: 'string', minLength: 1, maxLength: 500 },
    externalIdVersion: { bsonType: 'string', minLength: 1, maxLength: 128 },
    canonicalUrlHash: { bsonType: 'string', pattern: '^[a-f0-9]{64}$' },
    status: { enum: ['removed'] },
    evidenceEligible: { bsonType: 'bool', enum: [false] },
    removalPolicyVersion: { bsonType: 'int', minimum: 1 },
    removedAt: date,
    createdAt: date,
    updatedAt: date,
  },
})

export const ARTICLE_GOVERNANCE_HARDENING_VALIDATOR = Object.freeze({
  $or: [
    { $and: [ARTICLE_COLLECTIONS.articles.validator, { status: { $ne: 'removed' } }] },
    { $jsonSchema: removedArticleTombstoneSchema },
  ],
})

export function buildArticleGovernanceHardeningMigration({ dryRun = false } = {}) {
  return [{
    type: 'collMod',
    collection: 'articles',
    validator: ARTICLE_GOVERNANCE_HARDENING_VALIDATOR,
    validationLevel: 'strict',
    validationAction: 'error',
    ...(dryRun ? { dryRun: true } : {}),
  }]
}

export async function runArticleGovernanceHardeningMigration({ db, dryRun = false } = {}) {
  const plan = buildArticleGovernanceHardeningMigration({ dryRun })
  if (dryRun) return plan
  if (!db || typeof db.command !== 'function') throw new Error('MongoDB database is required')
  for (const operation of plan) await db.command({ collMod: operation.collection, validator: operation.validator, validationLevel: operation.validationLevel, validationAction: operation.validationAction })
  return plan
}

export { removedArticleTombstoneSchema }
