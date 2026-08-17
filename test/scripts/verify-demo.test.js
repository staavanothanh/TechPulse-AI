import { describe, expect, it } from 'vitest'
import { ObjectId } from 'mongodb'
import { LIVE_DEMO_SOURCE_KEYS, verifyDemoDataset } from '../../scripts/verify-demo.js'

function memoryContext() {
  const sources = LIVE_DEMO_SOURCE_KEYS.map((sourceKey, index) => ({
    _id: new ObjectId((index + 1).toString().padStart(24, '0')),
    sourceKey,
    operationalStatus: 'active',
    licenseStatus: 'metadata-only',
  }))
  return {
    db: {
      collection(name) {
        if (name === 'sources') return { find: () => ({ toArray: async () => sources }) }
        if (name === 'articles') return { countDocuments: async () => 50 }
        return { countDocuments: async () => sources.length }
      },
    },
  }
}

describe('real demo verifier', () => {
  it('reports connector-backed sources, published articles and bootstrap audits without writing', async () => {
    await expect(verifyDemoDataset({ context: memoryContext() })).resolves.toEqual({
      verified: true,
      sources: { expected: 3, found: 3 },
      articles: { expectedMinimum: 20, found: 50 },
      audits: { expected: 3, found: 3 },
      missing: [],
    })
  })

  it('fails closed when the connector source or article minimum is missing', async () => {
    const context = {
      db: {
        collection(name) {
          if (name === 'sources') return { find: () => ({ toArray: async () => [] }) }
          return { countDocuments: async () => 0 }
        },
      },
    }
    const result = await verifyDemoDataset({ context, minimumArticles: 1 })
    expect(result.verified).toBe(false)
    expect(result.missing.map(({ name }) => name)).toEqual(expect.arrayContaining(['source:demo:rss-the-verge', 'source:demo:arxiv-cs-ai', 'source:demo:hn-topstories']))
  })
})
