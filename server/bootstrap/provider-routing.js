import { PROVIDER_ROUTING_V2_COLLECTIONS, PROVIDER_ROUTING_V2_INDEXES } from '../../scripts/migrations/provider-routing-v2.js'
import { QA_EVIDENCE_FENCE_ARTICLE_VALIDATOR } from '../../scripts/migrations/qa-evidence-fence.js'
import { SUMMARY_DETAIL_ARTICLE_VALIDATOR } from '../../scripts/migrations/summary-detail-v1.js'
import { exactMongoIndex } from '../repositories/mongo/index-contract.js'

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`
  }
  return JSON.stringify(value)
}

function exactProviderRoutingIndex(name, actual, expected) {
  if (name !== 'articles' || expected.name !== 'articles_search_text') return exactMongoIndex(actual, expected)
  if (exactMongoIndex(actual, expected)) return true
  const fields = Object.keys(expected.key).filter((field) => expected.key[field] === 'text').sort()
  return stableJson(actual?.key) === stableJson({ _fts: 'text', _ftsx: 1 })
    && stableJson(actual?.weights) === stableJson(Object.fromEntries(fields.map((field) => [field, 1])))
    && actual?.default_language === expected.options?.default_language
}

export async function assertProviderRoutingReady(context) {
  if (!context?.db) throw new Error('Mongo context is required')
  const collections = await context.db.listCollections({}, { nameOnly: false }).toArray()
  const collectionMap = new Map(collections.map((collection) => [collection.name, collection]))
  for (const [name, definition] of Object.entries(PROVIDER_ROUTING_V2_COLLECTIONS)) {
    const collection = collectionMap.get(name)
    const acceptedValidators = name === 'articles'
      ? [definition.validator, QA_EVIDENCE_FENCE_ARTICLE_VALIDATOR, SUMMARY_DETAIL_ARTICLE_VALIDATOR]
      : [definition.validator]
    const validatorMatches = acceptedValidators.some(
      (validator) => stableJson(collection?.options?.validator) === stableJson(validator),
    )
    if (!collection || collection.options?.validationLevel !== 'strict' || collection.options?.validationAction !== 'error' || !validatorMatches) {
      throw new Error(`provider-routing-v2 validator is not ready for ${name}`)
    }
    const expectedIndexes = PROVIDER_ROUTING_V2_INDEXES[name] ?? []
    if (expectedIndexes.length === 0) continue
    const actualByName = new Map((await context.db.collection(name).indexes()).map((index) => [index.name, index]))
    if (expectedIndexes.some((expected) => !exactProviderRoutingIndex(name, actualByName.get(expected.name), expected))) {
      throw new Error(`provider-routing-v2 index is not ready for ${name}`)
    }
  }
}
