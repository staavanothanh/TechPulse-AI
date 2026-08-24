import { describe, expect, it } from 'vitest'
import { assertProviderRoutingReady } from '../../../server/bootstrap/provider-routing.js'
import { PROVIDER_ROUTING_V2_COLLECTIONS, PROVIDER_ROUTING_V2_INDEXES } from '../../../scripts/migrations/provider-routing-v2.js'
import { ARTICLE_INDEXES } from '../../../scripts/migrations/articles.js'
import { INDEXING_ARTICLE_INDEXES } from '../../../scripts/migrations/indexing-jobs.js'
import { CHAT_SESSION_INDEXES } from '../../../scripts/migrations/chat-sessions.js'
import { QA_EVIDENCE_FENCE_ARTICLE_VALIDATOR } from '../../../scripts/migrations/qa-evidence-fence.js'
import { SUMMARY_DETAIL_ARTICLE_VALIDATOR } from '../../../scripts/migrations/summary-detail-v1.js'

function context({ validatorOverride = {}, indexOverride = {} } = {}) {
  const collections = Object.entries(PROVIDER_ROUTING_V2_COLLECTIONS).map(([name, definition]) => ({
    name,
    options: {
      validator: validatorOverride[name] ?? definition.validator,
      validationLevel: 'strict',
      validationAction: 'error',
    },
  }))
  return {
    db: {
      listCollections: () => ({ toArray: async () => collections }),
      collection: (name) => ({
        indexes: async () => indexOverride[name] ?? (PROVIDER_ROUTING_V2_INDEXES[name] ?? []).map((index) => index.name === 'articles_search_text'
          ? {
              name: index.name,
              key: { _fts: 'text', _ftsx: 1 },
              weights: Object.fromEntries(Object.keys(index.key).map((field) => [field, 1])),
              default_language: 'none',
              language_override: 'language',
              textIndexVersion: 3,
            }
          : { name: index.name, key: index.key, ...(index.options ?? {}) }),
      }),
    },
  }
}

describe('ADR-0013 provider-routing startup readiness', () => {
  it('accepts only the exact v2 validators and indexes', async () => {
    await expect(assertProviderRoutingReady(context())).resolves.toBeUndefined()
    await expect(assertProviderRoutingReady(context({ validatorOverride: { providerFailureDomainStates: {} } }))).rejects.toThrow(/validator/i)
    await expect(assertProviderRoutingReady(context({ indexOverride: { articles: [] } }))).rejects.toThrow(/index/i)
  })

  it('fails before provider work when a required collection is missing', async () => {
    const missing = context()
    missing.db.listCollections = () => ({ toArray: async () => [] })
    await expect(assertProviderRoutingReady(missing)).rejects.toThrow(/provider-routing-v2/i)
  })

  it('accepts the fenced article validator while keeping other provider validators exact', async () => {
    await expect(assertProviderRoutingReady(context({ validatorOverride: { articles: QA_EVIDENCE_FENCE_ARTICLE_VALIDATOR } }))).resolves.toBeUndefined()
    await expect(assertProviderRoutingReady(context({ validatorOverride: { articles: SUMMARY_DETAIL_ARTICLE_VALIDATOR } }))).resolves.toBeUndefined()
  })

  it('requires inherited article, reconciliation, and answer-attempt indexes', async () => {
    expect(PROVIDER_ROUTING_V2_INDEXES.articles.map(({ name }) => name)).toEqual(expect.arrayContaining([
      ...ARTICLE_INDEXES.articles.map(({ name }) => name),
      ...INDEXING_ARTICLE_INDEXES.map(({ name }) => name),
      'articles_embedding_compatibility',
    ]))
    expect(PROVIDER_ROUTING_V2_INDEXES.answerAttempts.map(({ name }) => name)).toEqual(CHAT_SESSION_INDEXES.answerAttempts.map(({ name }) => name))
    expect(PROVIDER_ROUTING_V2_INDEXES.indexingJobs.map(({ name }) => name)).toEqual(expect.arrayContaining(['indexing_due_normal', 'indexing_due_aged', 'indexing_purge_deadline']))
    await expect(assertProviderRoutingReady(context({ indexOverride: { answerAttempts: [] } }))).rejects.toThrow(/index/i)
  })
})
