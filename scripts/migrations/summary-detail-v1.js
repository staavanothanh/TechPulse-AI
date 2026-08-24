import { QA_EVIDENCE_FENCE_ARTICLE_VALIDATOR } from './qa-evidence-fence.js'

const articleBranch = QA_EVIDENCE_FENCE_ARTICLE_VALIDATOR.$or[0]
const articleSchema = articleBranch.$and[0].$jsonSchema
const summaryDetailStatuses = Object.freeze(['pending', 'processing', 'ready', 'failed', 'removed'])

const summaryParagraphsVi = Object.freeze({
  oneOf: [
    { bsonType: 'null' },
    {
      bsonType: 'array',
      minItems: 2,
      maxItems: 5,
      items: { bsonType: 'string', minLength: 20, maxLength: 2000 },
    },
  ],
})

const summaryDetailStateRule = Object.freeze({
  $expr: {
    $cond: [
      { $eq: ['$summaryDetailStatus', 'ready'] },
      {
        $and: [
          { $eq: ['$summaryStatus', 'ready'] },
          { $eq: [{ $type: '$summaryParagraphsVi' }, 'array'] },
          { $gte: [{ $size: { $ifNull: ['$summaryParagraphsVi', []] } }, 2] },
          { $lte: [{ $size: { $ifNull: ['$summaryParagraphsVi', []] } }, 5] },
          {
            $lte: [
              {
                $reduce: {
                  input: { $ifNull: ['$summaryParagraphsVi', []] },
                  initialValue: 0,
                  in: { $add: ['$$value', { $strLenCP: '$$this' }] },
                },
              },
              6000,
            ],
          },
        ],
      },
      { $eq: ['$summaryParagraphsVi', null] },
    ],
  },
})

export const SUMMARY_DETAIL_ARTICLE_VALIDATOR = Object.freeze({
  ...QA_EVIDENCE_FENCE_ARTICLE_VALIDATOR,
  $or: Object.freeze([
    {
      ...articleBranch,
      $and: Object.freeze([
        {
          ...articleBranch.$and[0],
          $jsonSchema: {
            ...articleSchema,
            required: [...articleSchema.required, 'summaryParagraphsVi', 'summaryDetailStatus'],
            properties: {
              ...articleSchema.properties,
              summaryParagraphsVi,
              summaryDetailStatus: { enum: summaryDetailStatuses },
              summaryBasis: { enum: ['metadata', 'excerpt', 'fulltext-temporary', 'official-payload', null] },
            },
          },
        },
        ...articleBranch.$and.slice(1),
        summaryDetailStateRule,
      ]),
    },
    ...QA_EVIDENCE_FENCE_ARTICLE_VALIDATOR.$or.slice(1),
  ]),
})

export const SUMMARY_DETAIL_ARTICLE_COMPATIBILITY_VALIDATOR = Object.freeze({
  $or: Object.freeze([
    QA_EVIDENCE_FENCE_ARTICLE_VALIDATOR,
    SUMMARY_DETAIL_ARTICLE_VALIDATOR,
  ]),
})

const LEGACY_DETAIL_FILTER = Object.freeze({
  status: { $ne: 'removed' },
  $or: [
    { summaryDetailStatus: { $exists: false } },
    { summaryParagraphsVi: { $exists: false } },
  ],
})

function legacyDetailStatus(summaryStatus) {
  if (summaryStatus === 'processing') return 'processing'
  if (summaryStatus === 'failed') return 'failed'
  if (summaryStatus === 'removed') return 'removed'
  return 'pending'
}

export async function backfillLegacySummaryDetail({ db, batchSize = 100 } = {}) {
  if (!db?.collection || !Number.isInteger(batchSize) || batchSize < 1 || batchSize > 100) {
    throw new Error('Bounded summary detail backfill requires MongoDB and batchSize 1..100')
  }
  const articles = db.collection('articles')
  let updated = 0
  while (true) {
    const candidates = await articles.find(LEGACY_DETAIL_FILTER)
      .sort({ _id: 1 })
      .limit(batchSize)
      .project({ _id: 1, summaryStatus: 1 })
      .toArray()
    if (candidates.length === 0) return updated
    let batchUpdated = 0
    for (const candidate of candidates) {
      const result = await articles.updateOne(
        { _id: candidate._id, ...LEGACY_DETAIL_FILTER },
        {
          $set: {
            summaryDetailStatus: legacyDetailStatus(candidate.summaryStatus),
            summaryParagraphsVi: null,
          },
        },
      )
      const matched = Number(result?.matchedCount ?? result?.modifiedCount ?? 0)
      updated += matched
      batchUpdated += matched
    }
    if (batchUpdated === 0) return updated
  }
}

export function buildSummaryDetailV1Migration({ dryRun = false } = {}) {
  const operations = [
    {
      type: 'collMod',
      collection: 'articles',
      options: {
        validator: SUMMARY_DETAIL_ARTICLE_COMPATIBILITY_VALIDATOR,
        validationLevel: 'strict',
        validationAction: 'error',
      },
    },
    {
      type: 'backfillLegacySummaryDetail',
      collection: 'articles',
      batchSize: 100,
    },
    {
      type: 'collMod',
      collection: 'articles',
      options: {
        validator: SUMMARY_DETAIL_ARTICLE_VALIDATOR,
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

async function assertPredecessor(db) {
  if (typeof db?.listCollections !== 'function') throw new Error('MongoDB database is required')
  const collections = await db.listCollections({ name: 'articles' }, { nameOnly: false }).toArray()
  const installed = collections.find((collection) => collection.name === 'articles')?.options?.validator
  const accepted = [
    QA_EVIDENCE_FENCE_ARTICLE_VALIDATOR,
    SUMMARY_DETAIL_ARTICLE_COMPATIBILITY_VALIDATOR,
    SUMMARY_DETAIL_ARTICLE_VALIDATOR,
  ]
  const phase = accepted.findIndex((validator) => stableJson(installed) === stableJson(validator))
  if (phase === -1) {
    throw new Error('qa-evidence-fence migration must be applied before summary-detail-v1')
  }
  return phase === 2 ? 'strict' : 'transitional'
}

function assertWriterMode(writerMode) {
  if (writerMode !== 'paused') {
    throw new Error('summary-detail-v1 requires writers-paused before strict validator')
  }
}

async function assertNoLegacyDetailResidue(db) {
  const remaining = await db.collection('articles').countDocuments(LEGACY_DETAIL_FILTER, { limit: 1 })
  if (remaining !== 0) throw new Error('summary-detail-v1 legacy detail backfill is incomplete')
}

export async function runSummaryDetailV1Migration({ db, dryRun = false, batchSize = 100, writerMode } = {}) {
  const plan = buildSummaryDetailV1Migration({ dryRun })
  if (dryRun) return plan
  if (!db || typeof db.command !== 'function') throw new Error('MongoDB database is required')
  const phase = await assertPredecessor(db)
  if (phase === 'strict') {
    const legacyUpdated = await backfillLegacySummaryDetail({ db, batchSize })
    await assertNoLegacyDetailResidue(db)
    return Object.assign([], { legacyUpdated })
  }
  assertWriterMode(writerMode)
  let legacyUpdated = 0
  for (const operation of plan) {
    if (operation.type === 'collMod') {
      if (operation.options.validator === SUMMARY_DETAIL_ARTICLE_VALIDATOR) {
        // Legacy writers can recreate the old shape after the bounded scan.
        // The caller must pause writers for this final fence.
        await assertNoLegacyDetailResidue(db)
      }
      await db.command({ collMod: operation.collection, ...operation.options })
    } else if (operation.type === 'backfillLegacySummaryDetail') {
      legacyUpdated = await backfillLegacySummaryDetail({ db, batchSize: batchSize ?? operation.batchSize })
    }
  }
  return Object.assign(plan, { legacyUpdated })
}
