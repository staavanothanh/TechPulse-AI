import { AUTH_CORE_COLLECTIONS } from './auth-core.js'
import { GOOGLE_OAUTH_USERS_VALIDATOR } from './google-oauth.js'
import { SUMMARY_DETAIL_ARTICLE_VALIDATOR } from './summary-detail-v1.js'
import {
  classifyTopicIds,
  canonicalPreferenceIds,
  resolveTopic,
  TOPIC_TAXONOMY_VERSION,
} from '../../shared/topic-catalog.js'

function clone(value) {
  return structuredClone(value)
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`
  }
  return JSON.stringify(value)
}

const topicIdsSchema = Object.freeze({
  bsonType: 'array',
  uniqueItems: true,
  maxItems: 50,
  items: { bsonType: 'string', minLength: 1, maxLength: 64 },
})

const topicTaxonomyVersionSchema = Object.freeze({
  bsonType: 'int',
  minimum: 1,
  maximum: 10,
})

const topicPreferenceIdsSchema = Object.freeze({
  bsonType: 'array',
  uniqueItems: true,
  maxItems: 20,
  items: { bsonType: 'string', minLength: 1, maxLength: 64 },
})

const topicPreferenceTaxonomyVersionSchema = Object.freeze({
  bsonType: 'int',
  minimum: 1,
  maximum: 10,
})

// Build Article Validator
const articleBranch = clone(SUMMARY_DETAIL_ARTICLE_VALIDATOR.$or[0])
const articleSchema = articleBranch.$and[0].$jsonSchema
articleSchema.properties.topicIds = topicIdsSchema
articleSchema.properties.topicTaxonomyVersion = topicTaxonomyVersionSchema
articleSchema.required = [...(articleSchema.required ?? []), 'topicIds', 'topicTaxonomyVersion']
export const TOPIC_TAXONOMY_ARTICLE_VALIDATOR = Object.freeze({
  ...SUMMARY_DETAIL_ARTICLE_VALIDATOR,
  $or: Object.freeze([
    articleBranch,
    clone(SUMMARY_DETAIL_ARTICLE_VALIDATOR.$or[1]), // Removed article tombstone schema untouched
  ]),
})

export const TOPIC_TAXONOMY_ARTICLE_COMPATIBILITY_VALIDATOR = Object.freeze({
  $or: Object.freeze([
    SUMMARY_DETAIL_ARTICLE_VALIDATOR,
    TOPIC_TAXONOMY_ARTICLE_VALIDATOR,
  ]),
})

// Build Users Validator from auth-core; googleSub remains optional so OAuth users survive.
const authCoreUsersValidator = AUTH_CORE_COLLECTIONS.users.validator
const activeUserSchema = clone(authCoreUsersValidator.$or[0].$jsonSchema)
const deletedUserSchema = clone(authCoreUsersValidator.$or[1].$jsonSchema)
activeUserSchema.properties.googleSub = clone(GOOGLE_OAUTH_USERS_VALIDATOR.$or[0].$jsonSchema.properties.googleSub)
activeUserSchema.properties.topicPreferenceIds = topicPreferenceIdsSchema
activeUserSchema.properties.topicPreferenceTaxonomyVersion = topicPreferenceTaxonomyVersionSchema
activeUserSchema.required = [...(activeUserSchema.required ?? []), 'topicPreferenceIds', 'topicPreferenceTaxonomyVersion']
export const TOPIC_TAXONOMY_USERS_VALIDATOR = Object.freeze({
  $or: Object.freeze([
    { $jsonSchema: activeUserSchema },
    { $jsonSchema: deletedUserSchema },
  ]),
})

export const TOPIC_TAXONOMY_USERS_COMPATIBILITY_VALIDATOR = Object.freeze({
  $or: Object.freeze([
    authCoreUsersValidator,
    GOOGLE_OAUTH_USERS_VALIDATOR,
    TOPIC_TAXONOMY_USERS_VALIDATOR,
  ]),
})

export const TOPIC_TAXONOMY_ARTICLE_INDEXES = Object.freeze([
  Object.freeze({
    name: 'articles_status_topic_ids_published_at',
    key: { status: 1, topicIds: 1, publishedAt: -1, _id: -1 },
    options: { background: true },
  }),
])

export function buildTopicTaxonomyMigration({ dryRun = false } = {}) {
  return [
    {
      type: 'collMod',
      collection: 'articles',
      validator: TOPIC_TAXONOMY_ARTICLE_COMPATIBILITY_VALIDATOR,
      validationLevel: 'strict',
      validationAction: 'error',
      ...(dryRun ? { dryRun: true } : {}),
    },
    {
      type: 'collMod',
      collection: 'users',
      validator: TOPIC_TAXONOMY_USERS_COMPATIBILITY_VALIDATOR,
      validationLevel: 'strict',
      validationAction: 'error',
      ...(dryRun ? { dryRun: true } : {}),
    },
    ...TOPIC_TAXONOMY_ARTICLE_INDEXES.map((index) => ({
      type: 'createIndex',
      collection: 'articles',
      key: index.key,
      options: { name: index.name, ...(index.options ?? {}) },
      ...(dryRun ? { dryRun: true } : {}),
    })),
    {
      type: 'backfillTopicTaxonomy',
      collection: 'articles',
      target: 'articles and users topic shadows',
      ...(dryRun ? { dryRun: true } : {}),
    },
    {
      type: 'collMod',
      collection: 'articles',
      validator: TOPIC_TAXONOMY_ARTICLE_VALIDATOR,
      validationLevel: 'strict',
      validationAction: 'error',
      ...(dryRun ? { dryRun: true } : {}),
    },
    {
      type: 'collMod',
      collection: 'users',
      validator: TOPIC_TAXONOMY_USERS_VALIDATOR,
      validationLevel: 'strict',
      validationAction: 'error',
      ...(dryRun ? { dryRun: true } : {}),
    },
  ]
}

export async function runTopicTaxonomyBackfill({
  db,
  batchSize = 100,
  articleCursor = null,
  userCursor = null,
} = {}) {
  const boundedBatch = Math.max(1, Math.min(100, Number(batchSize) || 100))

  const stats = {
    articles: { scanned: 0, migrated: 0, unmapped: 0, conflict: 0, nextCursor: null },
    users: { scanned: 0, migrated: 0, unmapped: 0, conflict: 0, nextCursor: null },
  }

  if (!db || typeof db.collection !== 'function') return stats

  const articlesCollection = db.collection('articles')
  const usersCollection = db.collection('users')

  // 1. Backfill articles
  const articleQuery = {
    status: { $ne: 'removed' },
    ...(articleCursor ? { _id: { $gt: articleCursor } } : {}),
  }

  const articles = await articlesCollection
    .find(articleQuery)
    .sort({ _id: 1 })
    .limit(boundedBatch)
    .toArray()

  for (const doc of articles) {
    stats.articles.scanned++
    stats.articles.nextCursor = doc._id

    // Check if already migrated
    if (
      Array.isArray(doc.topicIds) &&
      doc.topicTaxonomyVersion === TOPIC_TAXONOMY_VERSION
    ) {
      continue
    }

    const topicIds = classifyTopicIds({
      values: doc.topics ?? [],
      titleOriginal: doc.titleOriginal ?? '',
      excerptOriginal: doc.excerptOriginal ?? '',
    })

    // Check unmapped legacy topics
    let hasUnmapped = false
    for (const top of doc.topics ?? []) {
      const resolved = resolveTopic(top)
      if (!resolved.canonicalId) hasUnmapped = true
    }
    if (hasUnmapped) stats.articles.unmapped++

    const updateFilter = {
      _id: doc._id,
      updatedAt: doc.updatedAt,
      status: { $ne: 'removed' },
    }

    const updateSet = {
      $set: {
        topicIds: [...topicIds],
        topicTaxonomyVersion: TOPIC_TAXONOMY_VERSION,
      },
    }

    const result = await articlesCollection.updateOne(updateFilter, updateSet)
    if (result.matchedCount === 1) {
      stats.articles.migrated++
    } else {
      stats.articles.conflict++
    }
  }

  // 2. Backfill users
  const userQuery = {
    status: { $ne: 'deleted' },
    ...(userCursor ? { _id: { $gt: userCursor } } : {}),
  }

  const users = await usersCollection
    .find(userQuery)
    .sort({ _id: 1 })
    .limit(boundedBatch)
    .toArray()

  for (const user of users) {
    stats.users.scanned++
    stats.users.nextCursor = user._id

    if (
      Array.isArray(user.topicPreferenceIds) &&
      user.topicPreferenceTaxonomyVersion === TOPIC_TAXONOMY_VERSION
    ) {
      continue
    }

    const topicPreferenceIds = canonicalPreferenceIds(user.topicPreferences ?? [], { max: 20 })

    const updateFilter = {
      _id: user._id,
      updatedAt: user.updatedAt,
      status: { $ne: 'deleted' },
    }

    const updateSet = {
      $set: {
        topicPreferenceIds: [...topicPreferenceIds],
        topicPreferenceTaxonomyVersion: TOPIC_TAXONOMY_VERSION,
      },
    }

    const result = await usersCollection.updateOne(updateFilter, updateSet)
    if (result.matchedCount === 1) {
      stats.users.migrated++
    } else {
      stats.users.conflict++
    }
  }

  return stats
}

async function assertPredecessor(db) {
  const collections = await db.listCollections({}, { nameOnly: false }).toArray()
  const map = new Map(collections.map((col) => [col.name, col]))

  const articles = map.get('articles')
  if (!articles) throw new Error('articles collection must exist before topic-taxonomy-v1 migration')

  const acceptedArticleValidators = [
    stableJson(SUMMARY_DETAIL_ARTICLE_VALIDATOR),
    stableJson(TOPIC_TAXONOMY_ARTICLE_COMPATIBILITY_VALIDATOR),
    stableJson(TOPIC_TAXONOMY_ARTICLE_VALIDATOR),
  ]
  const currentArticleValidator = stableJson(articles.options?.validator)
  if (!acceptedArticleValidators.includes(currentArticleValidator)) {
    throw new Error('articles predecessor validator must be summary-detail-v1 before topic-taxonomy-v1')
  }

  const users = map.get('users')
  if (users) {
    const acceptedUserValidators = [
      stableJson(AUTH_CORE_COLLECTIONS.users.validator),
      stableJson(GOOGLE_OAUTH_USERS_VALIDATOR),
      stableJson(TOPIC_TAXONOMY_USERS_COMPATIBILITY_VALIDATOR),
      stableJson(TOPIC_TAXONOMY_USERS_VALIDATOR),
    ]
    const currentUserValidator = stableJson(users.options?.validator)
    if (!acceptedUserValidators.includes(currentUserValidator)) {
      throw new Error('users predecessor validator must be auth-core or google-oauth before topic-taxonomy-v1')
    }
  }
}

function assertWriterMode(writerMode) {
  if (writerMode !== 'paused') throw new Error('topic-taxonomy-v1 requires writers-paused before strict validator')
}

async function assertNoTopicTaxonomyResidue(db) {
  const [articleResidue, userResidue] = await Promise.all([
    db.collection('articles').find({
      status: { $ne: 'removed' },
      $or: [{ topicIds: { $not: { $type: 'array' } } }, { topicTaxonomyVersion: { $ne: TOPIC_TAXONOMY_VERSION } }],
    }).sort({ _id: 1 }).limit(1).toArray(),
    db.collection('users').find({
      status: { $ne: 'deleted' },
      $or: [{ topicPreferenceIds: { $not: { $type: 'array' } } }, { topicPreferenceTaxonomyVersion: { $ne: TOPIC_TAXONOMY_VERSION } }],
    }).sort({ _id: 1 }).limit(1).toArray(),
  ])
  if (articleResidue.length > 0 || userResidue.length > 0) throw new Error('topic taxonomy residue remains before strict cutover')
}

export async function runTopicTaxonomyMigration({ db, dryRun = false, batchSize = 100, writerMode } = {}) {
  const plan = buildTopicTaxonomyMigration({ dryRun })
  if (dryRun) return plan
  if (!db || typeof db.command !== 'function') throw new Error('MongoDB database is required')
  assertWriterMode(writerMode)

  await assertPredecessor(db)

  // Step 1: Install compatibility validators
  await db.command({ collMod: 'articles', validator: TOPIC_TAXONOMY_ARTICLE_COMPATIBILITY_VALIDATOR, validationLevel: 'strict', validationAction: 'error' })
  await db.command({ collMod: 'users', validator: TOPIC_TAXONOMY_USERS_COMPATIBILITY_VALIDATOR, validationLevel: 'strict', validationAction: 'error' })

  // Step 2: Create additive indexes
  const articlesCollection = db.collection('articles')
  for (const index of TOPIC_TAXONOMY_ARTICLE_INDEXES) {
    await articlesCollection.createIndex(index.key, { name: index.name, ...(index.options ?? {}) })
  }

  // Step 3: Drain both bounded cursors before the strict cutover.
  let articleCursor = null
  let userCursor = null
  let conflicts = 0
  do {
    const batch = await runTopicTaxonomyBackfill({ db, batchSize, articleCursor, userCursor })
    articleCursor = batch.articles.nextCursor
    userCursor = batch.users.nextCursor
    conflicts += batch.articles.conflict + batch.users.conflict
  } while (articleCursor || userCursor)
  if (conflicts > 0) throw new Error('topic taxonomy backfill conflicted; retry before strict cutover')
  await assertNoTopicTaxonomyResidue(db)

  // Step 4: Install final strict validators
  await db.command({ collMod: 'articles', validator: TOPIC_TAXONOMY_ARTICLE_VALIDATOR, validationLevel: 'strict', validationAction: 'error' })
  await db.command({ collMod: 'users', validator: TOPIC_TAXONOMY_USERS_VALIDATOR, validationLevel: 'strict', validationAction: 'error' })

  return plan
}
