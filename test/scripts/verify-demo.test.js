import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'
import { ObjectId } from 'mongodb'
import { buildSourceManifest } from '../../scripts/seed-demo.js'
import { LIVE_DEMO_SOURCE_KEYS, verifyDemoDataset } from '../../scripts/verify-demo.js'

const RUN_AT = new Date('2026-08-17T00:00:00.000Z')

function memoryContext({
  articlesPerSource = 10,
  omitFirstAudit = false,
  staleFirstArticle = false,
} = {}) {
  const sources = LIVE_DEMO_SOURCE_KEYS.map((sourceKey, index) => ({
    _id: new ObjectId((index + 1).toString().padStart(24, '0')),
    sourceKey,
    operationalStatus: 'active',
    licenseStatus: 'metadata-only',
  }))
  const articles = sources.flatMap((source, sourceIndex) =>
    Array.from({ length: articlesPerSource }, (_, articleIndex) => ({
      _id: new ObjectId((sourceIndex * 100 + articleIndex + 100).toString(16).padStart(24, '0')),
      sourceId: source._id,
      externalId: `${source.sourceKey}:${articleIndex}`,
      canonicalUrlHash: createHash('sha256')
        .update(`${source.sourceKey}:${articleIndex}`)
        .digest('hex'),
      retrievedAt:
        staleFirstArticle && sourceIndex === 0 && articleIndex === 0
          ? new Date(RUN_AT.getTime() - 1)
          : RUN_AT,
    })),
  )
  let audits = sources.flatMap((source) => {
    const manifest = buildSourceManifest({ source, articles, runAt: RUN_AT })
    const requestId = (suffix) =>
      `seed:real-demo:${source.sourceKey}:${suffix}:${manifest.manifestId}`
    return [
      {
        targetId: source._id,
        action: 'source_created',
        requestId: requestId('created'),
        createdAt: new Date(RUN_AT.getTime() - 4),
      },
      {
        targetId: source._id,
        action: 'source_policy_reviewed',
        requestId: requestId('policy-review'),
        createdAt: new Date(RUN_AT.getTime() - 3),
      },
      {
        targetId: source._id,
        action: 'source_technical_check_recorded',
        requestId: requestId('technical-check'),
        createdAt: new Date(RUN_AT.getTime() - 2),
      },
      {
        targetId: source._id,
        action: 'source_status_updated',
        stateTransition: { from: 'draft', to: 'testing' },
        requestId: requestId('draft-testing'),
        createdAt: new Date(RUN_AT.getTime() - 1),
      },
      {
        targetId: source._id,
        action: 'source_status_updated',
        stateTransition: { from: 'testing', to: 'active' },
        requestId: requestId('testing-active'),
        createdAt: RUN_AT,
      },
    ]
  })
  if (omitFirstAudit) audits = audits.slice(1)
  return {
    db: {
      collection(name) {
        if (name === 'sources') return { find: () => ({ toArray: async () => sources }) }
        if (name === 'articles') return { find: () => ({ toArray: async () => articles }) }
        return { find: () => ({ toArray: async () => audits }) }
      },
    },
  }
}

describe('real demo verifier', () => {
  it('reports connector-backed sources, published articles and bootstrap audits without writing', async () => {
    await expect(verifyDemoDataset({ context: memoryContext() })).resolves.toEqual({
      verified: true,
      sources: { expected: 3, found: 3 },
      articles: { expectedMinimum: 20, expectedMinimumPerSource: 5, found: 30 },
      audits: { expected: 15, found: 15 },
      manifests: { expected: 3, found: 3 },
      missing: [],
    })
  })

  it('fails closed when the connector source or article minimum is missing', async () => {
    const context = {
      db: {
        collection(name) {
          if (name === 'sources') return { find: () => ({ toArray: async () => [] }) }
          if (name === 'articles') return { find: () => ({ toArray: async () => [] }) }
          return { find: () => ({ toArray: async () => [] }) }
        },
      },
    }
    const result = await verifyDemoDataset({ context, minimumArticles: 1 })
    expect(result.verified).toBe(false)
    expect(result.missing.map(({ name }) => name)).toEqual(
      expect.arrayContaining([
        'source:demo:rss-the-verge',
        'source:demo:arxiv-cs-ai',
        'source:demo:hn-topstories',
      ]),
    )
  })

  it('fails closed when a source lifecycle audit is incomplete', async () => {
    const context = memoryContext({ omitFirstAudit: true })
    const result = await verifyDemoDataset({ context })
    expect(result.verified).toBe(false)
    expect(result.missing).toContainEqual(expect.objectContaining({ name: 'source-audits' }))
  })

  it('fails closed when a per-source minimum or manifest run timestamp does not match', async () => {
    const sparse = await verifyDemoDataset({ context: memoryContext({ articlesPerSource: 4 }) })
    expect(sparse.verified).toBe(false)
    expect(sparse.missing.map(({ name }) => name)).toEqual(
      expect.arrayContaining(LIVE_DEMO_SOURCE_KEYS.map((sourceKey) => `articles:${sourceKey}`)),
    )

    const stale = await verifyDemoDataset({ context: memoryContext({ staleFirstArticle: true }) })
    expect(stale.verified).toBe(false)
    expect(stale.missing).toContainEqual(expect.objectContaining({ name: 'source-manifests' }))
  })

  it('uses the runtime Mongo context for read-only verification', async () => {
    const source = await readFile(new URL('../../scripts/verify-demo.js', import.meta.url), 'utf8')
    expect(source).toContain('validateRuntimeConfiguration(process.env)')
    expect(source).not.toContain('MONGODB_OPERATOR_URI_ENV')
  })
})
