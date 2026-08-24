import { createArticleService } from '../application/articles/service.js'
import { createSavedService } from '../application/saved/service.js'
import { createSearchService } from '../application/search/service.js'
import { MongoArticleRepository } from '../repositories/mongo/article-repository.js'
import { exactMongoIndex } from '../repositories/mongo/index-contract.js'
import { normalizeReviewedHostname } from '../domain/source/validation.js'
import { ARTICLE_GOVERNANCE_HARDENING_VALIDATOR } from '../../scripts/migrations/article-governance-hardening.js'
import { ARTICLE_COLLECTIONS, ARTICLE_INDEXES } from '../../scripts/migrations/articles.js'
import { PROVIDER_ROUTING_ARTICLE_VALIDATOR } from '../../scripts/migrations/provider-routing-v2.js'
import { QA_EVIDENCE_FENCE_ARTICLE_VALIDATOR } from '../../scripts/migrations/qa-evidence-fence.js'

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`
  return JSON.stringify(value)
}

const ARTICLE_VALIDATOR_FINGERPRINTS = Object.freeze([
  ARTICLE_COLLECTIONS.articles.validator,
  ARTICLE_GOVERNANCE_HARDENING_VALIDATOR,
  PROVIDER_ROUTING_ARTICLE_VALIDATOR,
  QA_EVIDENCE_FENCE_ARTICLE_VALIDATOR,
].map(stableJson))

export async function assertArticlesReady(context) {
  if (!context?.db) throw new Error('Mongo context is required')
  const collection = (await context.db.listCollections({ name: 'articles' }, { nameOnly: false }).toArray())[0]
  if (!collection || collection.options?.validationLevel !== 'strict' || collection.options?.validationAction !== 'error' || !ARTICLE_VALIDATOR_FINGERPRINTS.includes(stableJson(collection.options?.validator))) throw new Error('article validator is not ready')
  const actualByName = new Map((await context.db.collection('articles').indexes()).map((index) => [index.name, index]))
  if (ARTICLE_INDEXES.articles.some((expected) => !exactMongoIndex(actualByName.get(expected.name), expected))) throw new Error('article indexes are not ready')
}

async function deployedImageCspHosts(context) {
  const sources = await context.db.collection('sources').find({
    operationalStatus: 'active',
    licenseStatus: { $in: ['permitted', 'metadata-only'] },
    'mediaPolicy.imageMode': 'remote-preview',
  }, { projection: { _id: 0, 'mediaPolicy.allowedHosts': 1 } }).toArray()
  return [...new Set(sources.flatMap((source) => source.mediaPolicy?.allowedHosts ?? []).map(normalizeReviewedHostname))].sort()
}

export async function createConfiguredContentServices({ context, queryEmbedding, verifySchema = assertArticlesReady } = {}) {
  if (!context) throw new Error('Mongo context is required')
  await verifySchema(context)
  const repository = new MongoArticleRepository(context)
  return Object.freeze({
    articleService: createArticleService({ repository }),
    searchService: createSearchService({ repository, embeddingAvailable: () => false, queryEmbedding }),
    savedService: createSavedService({ repository }),
    imageCspHosts: await deployedImageCspHosts(context),
  })
}
