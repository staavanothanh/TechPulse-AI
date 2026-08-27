import {
  GOVERNANCE_COLLECTIONS,
  GOVERNANCE_DATABASE_COLLECTIONS,
  GOVERNANCE_DATABASE_INDEXES,
  GOVERNANCE_INDEXES,
} from '../../scripts/migrations/governance.js'
import { GOVERNANCE_AUDIT_INDEXES, GOVERNANCE_AUDIT_VALIDATOR } from '../../scripts/migrations/governance-audit.js'
import { GOOGLE_OAUTH_AUDIT_VALIDATOR } from '../../scripts/migrations/google-oauth.js'
import { GOVERNANCE_HARDENING_INDEXES } from '../../scripts/migrations/governance-hardening.js'
import { GOVERNANCE_RETENTION_TAKEDOWN_VALIDATOR } from '../../scripts/migrations/governance-retention-hardening.js'
import { ARTICLE_GOVERNANCE_HARDENING_VALIDATOR } from '../../scripts/migrations/article-governance-hardening.js'
import { PROVIDER_ROUTING_ARTICLE_VALIDATOR } from '../../scripts/migrations/provider-routing-v2.js'
import { QA_EVIDENCE_FENCE_ARTICLE_VALIDATOR } from '../../scripts/migrations/qa-evidence-fence.js'
import { SUMMARY_DETAIL_ARTICLE_VALIDATOR } from '../../scripts/migrations/summary-detail-v1.js'
import { TOPIC_TAXONOMY_ARTICLE_INDEXES, TOPIC_TAXONOMY_ARTICLE_VALIDATOR } from '../../scripts/migrations/topic-taxonomy-v1.js'
import { exactMongoIndex } from '../repositories/mongo/index-contract.js'

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`
  return JSON.stringify(value)
}

function collectionMap(db) {
  if (!db || typeof db.listCollections !== 'function') throw new Error('governance database is unavailable')
  return db.listCollections({}, { nameOnly: false }).toArray().then((collections) => new Map(collections.map((collection) => [collection.name, collection])))
}

async function assertCollectionsAndIndexes(db, definitions, indexes, label) {
  const collections = await collectionMap(db)
  for (const [name, definition] of Object.entries(definitions)) {
    const collection = collections.get(name)
    if (!collection || collection.options?.validationLevel !== 'strict' || collection.options?.validationAction !== 'error' || stableJson(collection.options?.validator) !== stableJson(definition.validator)) {
      throw new Error(`${label} validator is not ready`)
    }
    if (typeof db.collection !== 'function') throw new Error(`${label} database is unavailable`)
    const actual = new Map((await db.collection(name).indexes()).map((index) => [index.name, index]))
    for (const expected of indexes[name] ?? []) {
      if (!exactMongoIndex(actual.get(expected.name), expected)) throw new Error(`${label} indexes are not ready`)
    }
  }
}

/**
 * Admin governance and durable deletion workers must not start against a
 * partially applied migration.  This check is read-only: it only inspects
 * validators/indexes in the app and governance databases.
 */
export async function assertGovernanceReady(context, { governanceDb } = {}) {
  if (!context?.db) throw new Error('Mongo context is required')
  await assertCollectionsAndIndexes(context.db, {
    ...GOVERNANCE_COLLECTIONS,
    takedownRequests: { ...GOVERNANCE_COLLECTIONS.takedownRequests, validator: GOVERNANCE_RETENTION_TAKEDOWN_VALIDATOR },
  }, {
    ...GOVERNANCE_INDEXES,
    takedownRequests: [...GOVERNANCE_INDEXES.takedownRequests, ...GOVERNANCE_HARDENING_INDEXES.takedownRequests],
  }, 'governance')
  const appCollections = await collectionMap(context.db)
  const articles = appCollections.get('articles')
  const acceptedArticleValidators = [ARTICLE_GOVERNANCE_HARDENING_VALIDATOR, PROVIDER_ROUTING_ARTICLE_VALIDATOR, QA_EVIDENCE_FENCE_ARTICLE_VALIDATOR, SUMMARY_DETAIL_ARTICLE_VALIDATOR, TOPIC_TAXONOMY_ARTICLE_VALIDATOR]
  if (!articles || articles.options?.validationLevel !== 'strict' || articles.options?.validationAction !== 'error' || !acceptedArticleValidators.some((validator) => stableJson(articles.options?.validator) === stableJson(validator))) {
    throw new Error('governance article tombstone validator is not ready')
  }
  if (stableJson(articles.options?.validator) === stableJson(TOPIC_TAXONOMY_ARTICLE_VALIDATOR)) {
    const articleIndexes = new Map((await context.db.collection('articles').indexes()).map((index) => [index.name, index]))
    if (TOPIC_TAXONOMY_ARTICLE_INDEXES.some((expected) => !exactMongoIndex(articleIndexes.get(expected.name), expected))) throw new Error('governance taxonomy article indexes are not ready')
  }
  const auditCollections = await collectionMap(context.db)
  const audit = auditCollections.get('adminAuditLogs')
  if (!audit || audit.options?.validationLevel !== 'strict' || audit.options?.validationAction !== 'error' || ![GOVERNANCE_AUDIT_VALIDATOR, GOOGLE_OAUTH_AUDIT_VALIDATOR].some((validator) => stableJson(audit.options?.validator) === stableJson(validator))) {
    throw new Error('governance audit validator is not ready')
  }
  if (typeof context.db.collection !== 'function') throw new Error('governance database is unavailable')
  const auditIndexes = new Map((await context.db.collection('adminAuditLogs').indexes()).map((index) => [index.name, index]))
  for (const expected of GOVERNANCE_AUDIT_INDEXES) {
    if (!exactMongoIndex(auditIndexes.get(expected.name), expected)) throw new Error('governance audit indexes are not ready')
  }
  const targetDb = governanceDb ?? context.governanceDb ?? context.client?.db?.('techpulse_governance')
  await assertCollectionsAndIndexes(targetDb, GOVERNANCE_DATABASE_COLLECTIONS, GOVERNANCE_DATABASE_INDEXES, 'governance database')
  return { ready: true }
}
