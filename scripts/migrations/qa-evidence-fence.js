import { PROVIDER_ROUTING_ARTICLE_VALIDATOR } from './provider-routing-v2.js'
import { SOURCE_COLLECTIONS } from './sources.js'

const qnaFenceToken = Object.freeze({ bsonType: 'objectId' })

const articleBranch = PROVIDER_ROUTING_ARTICLE_VALIDATOR.$or[0]
const articleSchema = articleBranch.$and[0].$jsonSchema

export const QA_EVIDENCE_FENCE_ARTICLE_VALIDATOR = Object.freeze({
  ...PROVIDER_ROUTING_ARTICLE_VALIDATOR,
  $or: Object.freeze([
    {
      ...articleBranch,
      $and: Object.freeze([
        {
          ...articleBranch.$and[0],
          $jsonSchema: {
            ...articleSchema,
            properties: {
              ...articleSchema.properties,
              qnaFenceToken,
            },
          },
        },
        ...articleBranch.$and.slice(1),
      ]),
    },
    ...PROVIDER_ROUTING_ARTICLE_VALIDATOR.$or.slice(1),
  ]),
})

const sourceValidator = SOURCE_COLLECTIONS.sources.validator
const sourceSchema = sourceValidator.$and[0].$jsonSchema

export const QA_EVIDENCE_FENCE_SOURCE_VALIDATOR = Object.freeze({
  ...sourceValidator,
  $and: Object.freeze([
    {
      ...sourceValidator.$and[0],
      $jsonSchema: {
        ...sourceSchema,
        properties: {
          ...sourceSchema.properties,
          qnaFenceToken,
        },
      },
    },
    ...sourceValidator.$and.slice(1),
  ]),
})

export function buildQaEvidenceFenceMigration({ dryRun = false } = {}) {
  const operations = [
    {
      type: 'collMod',
      collection: 'articles',
      options: {
        validator: QA_EVIDENCE_FENCE_ARTICLE_VALIDATOR,
        validationLevel: 'strict',
        validationAction: 'error',
      },
    },
    {
      type: 'collMod',
      collection: 'sources',
      options: {
        validator: QA_EVIDENCE_FENCE_SOURCE_VALIDATOR,
        validationLevel: 'strict',
        validationAction: 'error',
      },
    },
  ]
  return dryRun ? operations.map((operation) => ({ ...operation, dryRun: true })) : operations
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`
  }
  return JSON.stringify(value)
}

async function assertPredecessors(db) {
  if (typeof db.listCollections !== 'function') throw new Error('MongoDB database is required')
  const collections = await db.listCollections({}, { nameOnly: false }).toArray()
  const byName = new Map(collections.map((collection) => [collection.name, collection]))
  const installedArticle = byName.get('articles')?.options?.validator
  const installedSource = byName.get('sources')?.options?.validator
  const acceptedArticles = [PROVIDER_ROUTING_ARTICLE_VALIDATOR, QA_EVIDENCE_FENCE_ARTICLE_VALIDATOR]
  const acceptedSources = [SOURCE_COLLECTIONS.sources.validator, QA_EVIDENCE_FENCE_SOURCE_VALIDATOR]
  if (!acceptedArticles.some((validator) => stableJson(installedArticle) === stableJson(validator))) {
    throw new Error('provider-routing-v2 migration must be applied before qa-evidence-fence')
  }
  if (!acceptedSources.some((validator) => stableJson(installedSource) === stableJson(validator))) {
    throw new Error('sources migration must be applied before qa-evidence-fence')
  }
}

export async function runQaEvidenceFenceMigration({ db, dryRun = false } = {}) {
  const plan = buildQaEvidenceFenceMigration({ dryRun })
  if (dryRun) return plan
  if (!db || typeof db.command !== 'function') throw new Error('MongoDB database is required')
  await assertPredecessors(db)
  for (const operation of plan) await db.command({ collMod: operation.collection, ...operation.options })
  return plan
}
