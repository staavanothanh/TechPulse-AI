import { describe, expect, it } from 'vitest'
import { assertArticlesReady, createConfiguredContentServices } from '../../../server/bootstrap/content.js'
import { ARTICLE_GOVERNANCE_HARDENING_VALIDATOR } from '../../../scripts/migrations/article-governance-hardening.js'
import { ARTICLE_COLLECTIONS, ARTICLE_INDEXES } from '../../../scripts/migrations/articles.js'
import { PROVIDER_ROUTING_ARTICLE_VALIDATOR } from '../../../scripts/migrations/provider-routing-v2.js'

function readyContext({ validator = ARTICLE_COLLECTIONS.articles.validator, indexes, sources = [] } = {}) {
  const actualIndexes = indexes ?? ARTICLE_INDEXES.articles.map((index) => index.name === 'articles_search_text'
    ? {
        name: index.name,
        key: { _fts: 'text', _ftsx: 1 },
        weights: Object.fromEntries(Object.keys(index.key).map((name) => [name, 1])),
        default_language: 'none',
        language_override: 'language',
        textIndexVersion: 3,
      }
    : { name: index.name, key: index.key, ...(index.options ?? {}) })
  return {
    client: {},
    db: {
      listCollections: () => ({ toArray: async () => [{ name: 'articles', options: { validator, validationLevel: 'strict', validationAction: 'error' } }] }),
      collection: (name) => name === 'articles'
        ? { indexes: async () => actualIndexes }
        : { find: () => ({ toArray: async () => sources }) },
    },
  }
}

describe('Step 8 content bootstrap readiness', () => {
  it('constructs content services only after the exact article validator and indexes are ready', async () => {
    const context = readyContext({ sources: [
      { mediaPolicy: { allowedHosts: ['media.example.com', 'cdn.example.com'] } },
      { mediaPolicy: { allowedHosts: ['media.example.com'] } },
    ] })

    await expect(assertArticlesReady(context)).resolves.toBeUndefined()
    const configured = await createConfiguredContentServices({ context })

    expect(configured.articleService).toEqual(expect.objectContaining({ list: expect.any(Function), get: expect.any(Function) }))
    expect(configured.savedService).toEqual(expect.objectContaining({ save: expect.any(Function) }))
    expect(configured.imageCspHosts).toEqual(['cdn.example.com', 'media.example.com'])
  })

  it('accepts the current governance-hardened article validator', async () => {
    await expect(assertArticlesReady(readyContext({
      validator: ARTICLE_GOVERNANCE_HARDENING_VALIDATOR,
    }))).resolves.toBeUndefined()
  })

  it('accepts the exact provider-routing-v2 article validator', async () => {
    await expect(assertArticlesReady(readyContext({ validator: PROVIDER_ROUTING_ARTICLE_VALIDATOR }))).resolves.toBeUndefined()
  })

  it('fails closed when the article validator or any exact index is not ready', async () => {
    await expect(assertArticlesReady(readyContext({ validator: {} }))).rejects.toThrow(/article validator/i)
    await expect(assertArticlesReady(readyContext({ indexes: ARTICLE_INDEXES.articles.slice(0, -1).map((index) => ({ name: index.name, key: index.key, ...(index.options ?? {}) })) }))).rejects.toThrow(/article indexes/i)
    const wrongTextIndex = readyContext().db.collection('articles').indexes().then((actual) => actual.map((index) => index.name === 'articles_search_text' ? { ...index, weights: { ...index.weights, titleVi: 2 } } : index))
    await expect(assertArticlesReady(readyContext({ indexes: await wrongTextIndex }))).rejects.toThrow(/article indexes/i)
    await expect(createConfiguredContentServices({ context: readyContext({ indexes: [] }) })).rejects.toThrow(/article indexes/i)
  })
})
