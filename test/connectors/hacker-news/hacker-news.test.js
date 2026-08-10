import { readFile } from 'node:fs/promises'
import { describe, expect, it, vi } from 'vitest'
import {
  HackerNewsConnectorError,
  createHackerNewsConnector,
  parseHn,
} from '../../../server/connectors/hacker-news/index.js'

const FIXTURE_ROOT = new URL('../../fixtures/hacker-news/', import.meta.url)
const RETRIEVED_AT = new Date('2026-08-11T00:00:00.000Z')

async function fixture(name) {
  return readFile(new URL(name, FIXTURE_ROOT))
}

function source(stream = 'topstories', overrides = {}) {
  return {
    id: `source-hn-${stream}`,
    sourceKey: `hacker-news:${stream}`,
    connectorType: 'hacker-news',
    accessMethod: 'api',
    authorityTier: 'community-signal',
    connectorConfig: { kind: 'hacker-news', hackerNewsStream: stream, batchSize: 4 },
    ...overrides,
  }
}

describe('Hacker News connector', () => {
  it.each(['topstories', 'newstories', 'beststories'])('loads %s IDs/items with bounded concurrency and no linked-page fetch', async (stream) => {
    const ids = JSON.parse((await fixture(`${stream}.json`)).toString())
    const items = JSON.parse((await fixture('items.json')).toString())
    const expected = {
      topstories: { id: 101, url: 'https://linked.example.test/article', title: 'A safe HN story', author: 'alice', excerpt: 'Official HN text.' },
      newstories: { id: 201, url: 'https://linked.example.test/new', title: 'New stream story', author: 'new-user' },
      beststories: { id: 301, url: 'https://linked.example.test/best', title: 'Best stream story', author: 'best-user' },
    }[stream]
    let active = 0
    let maxActive = 0
    const request = vi.fn(async ({ kind, id, url }) => {
      expect(url).toMatch(/^https:\/\/hacker-news\.firebaseio\.com\/v0\//)
      if (kind === 'stream') return { statusCode: 200, body: Buffer.from(JSON.stringify(ids)) }
      active += 1
      maxActive = Math.max(maxActive, active)
      await new Promise((resolve) => setTimeout(resolve, 2))
      active -= 1
      return { statusCode: 200, body: Buffer.from(JSON.stringify(items[String(id)] ?? null)) }
    })
    const connector = createHackerNewsConnector({ now: () => RETRIEVED_AT, request, concurrency: 2 })
    const result = await connector.run({ source: source(stream) })

    expect(maxActive).toBeLessThanOrEqual(2)
    expect(result.candidates.every((candidate) => candidate.authorityTier === 'community-signal')).toBe(true)
    expect(result.candidates[0]).toMatchObject({
      connectorType: 'hacker-news',
      externalId: String(expected.id),
      originalUrl: expected.url,
      titleOriginal: expected.title,
      author: expected.author,
      sourceLanguage: 'en',
      communitySignal: true,
      provenance: { connectorType: 'hacker-news', sourceKey: `hacker-news:${stream}`, externalId: String(ids[0]), observedAt: RETRIEVED_AT },
    })
    if (expected.excerpt) expect(result.candidates[0]).toHaveProperty('excerptOriginal', expected.excerpt)
    if (stream === 'topstories') expect(result.candidates.find(({ externalId }) => externalId === '104').originalUrl).toBe('https://news.ycombinator.com/item?id=104')
    expect(result.metrics).toMatchObject({
      streamRequests: 1,
      itemRequests: ids.length,
      deletedItems: stream === 'topstories' ? 1 : 0,
      missingItems: stream === 'topstories' ? 1 : 0,
      maxConcurrent: Math.min(2, ids.length),
    })
    expect(JSON.stringify(result)).not.toMatch(/raw|body|response|linked-page|comments/i)
    expect(request).not.toHaveBeenCalledWith(expect.objectContaining({ url: 'https://linked.example.test/article' }))
  })

  it('maps HN timeout and upstream status failures without retrying permanent missing items', async () => {
    const request = vi.fn(async ({ kind, id }) => {
      if (kind === 'stream') return { statusCode: 200, body: Buffer.from('[401,402,403]') }
      if (id === 401) throw Object.assign(new Error('socket timeout'), { code: 'ETIMEDOUT' })
      if (id === 402) return { statusCode: 503, body: Buffer.from('secret provider body') }
      return { statusCode: 404, body: Buffer.from('missing') }
    })
    const result = await createHackerNewsConnector({ request, concurrency: 2 }).run({ source: source('topstories') }).catch((error) => error)
    expect(result).toBeInstanceOf(HackerNewsConnectorError)
    expect(result).toMatchObject({ code: 'source_fetch_timeout', retryable: true })
    expect(result.message).not.toMatch(/socket|provider|secret|missing/)
  })

  it('returns safe counters for invalid item payloads without persisting response content', async () => {
    const request = vi.fn(async ({ kind }) => kind === 'stream'
      ? { statusCode: 200, body: Buffer.from('[501]') }
      : { statusCode: 200, body: Buffer.from('{"id":501,"type":"comment","text":"not a story"}') })
    const result = await createHackerNewsConnector({ request }).run({ source: source() })
    expect(result.candidates).toEqual([])
    expect(result.metrics).toMatchObject({ invalidItems: 1, candidatesAccepted: 0 })
    expect(JSON.stringify(result)).not.toContain('not a story')
  })

  it('supports provider-free inline IDs/items and preserves explicit empty text', async () => {
    const result = await createHackerNewsConnector().run({
      source: source(),
      payload: {
        ids: [601],
        items: { 601: { id: 601, type: 'story', time: 1781006600, title: 'Inline story', text: '' } },
      },
    })
    expect(result.candidates[0]).toMatchObject({ externalId: '601', excerptOriginal: '', originalUrl: 'https://news.ycombinator.com/item?id=601' })
    expect(result.metrics).toMatchObject({ streamRequests: 0, itemRequests: 1, candidatesAccepted: 1 })
  })

  it('rejects invalid streams, IDs and malformed JSON as safe non-retryable errors', async () => {
    await expect(createHackerNewsConnector().run({ source: source('invalid') })).rejects.toMatchObject({ code: 'source_config_rejected', retryable: false })
    expect(() => parseHn(Buffer.from('{bad'))).toThrow(expect.objectContaining({ code: 'source_payload_rejected', retryable: false }))
    await expect(createHackerNewsConnector().run({ source: source(), ids: [0], itemPayloads: [] })).rejects.toMatchObject({ code: 'source_payload_rejected', retryable: false })
    await expect(createHackerNewsConnector().run({ source: source(), ids: Array.from({ length: 501 }, (_, index) => index + 1) })).rejects.toMatchObject({ code: 'source_payload_rejected', retryable: false })
    await expect(createHackerNewsConnector().run({ source: source('topstories', { connectorConfig: { kind: 'hacker-news', hackerNewsStream: 'topstories', batchSize: 101 } }), ids: [1] })).rejects.toMatchObject({ code: 'source_config_rejected', retryable: false })
    expect(() => parseHn(Buffer.from('[1,"2"]'))).toThrow(expect.objectContaining({ code: 'source_payload_rejected', retryable: false }))
    expect(() => createHackerNewsConnector({ concurrency: 0 })).toThrow(HackerNewsConnectorError)
  })

  it('handles a permanent missing item without retry and redacts retryable item failures', async () => {
    const request = vi.fn(async ({ kind, id }) => {
      if (kind === 'stream') return { statusCode: 200, body: Buffer.from('[701,702]') }
      if (id === 701) return { statusCode: 404, body: Buffer.from('not found') }
      return { statusCode: 429, body: Buffer.from('provider body') }
    })
    await expect(createHackerNewsConnector({ request, concurrency: 1 }).run({ source: source() })).rejects.toMatchObject({ code: 'source_upstream_status', retryable: true, upstreamStatus: 429 })
    expect(request).toHaveBeenCalledTimes(3)
  })

  it('maps an unknown official API failure to a retryable safe error', async () => {
    const request = vi.fn(async ({ kind }) => {
      if (kind === 'stream') return { statusCode: 200, body: Buffer.from('[801]') }
      throw new Error('socket details must not escape')
    })
    await expect(createHackerNewsConnector({ request }).run({ source: source() })).rejects.toMatchObject({ code: 'source_fetch_failed', retryable: true })
  })

  it('accepts the official 500-ID stream shape but requests only the configured batch', async () => {
    const ids = Array.from({ length: 500 }, (_, index) => 100_000 + index)
    const request = vi.fn(async ({ kind, id }) => {
      if (kind === 'stream') return { statusCode: 200, body: Buffer.from(JSON.stringify(ids)) }
      expect(id).toBeLessThan(100_010)
      return { statusCode: 200, body: Buffer.from(JSON.stringify({ id, type: 'story', time: 1781006600, title: `Story ${id}` })) }
    })
    const result = await createHackerNewsConnector({ request, concurrency: 2 }).run({
      source: source('topstories', { connectorConfig: { kind: 'hacker-news', hackerNewsStream: 'topstories', batchSize: 10 } }),
    })
    expect(request).toHaveBeenCalledTimes(11)
    expect(result.candidates).toHaveLength(10)
    expect(result.metrics.itemRequests).toBe(10)
  })
})
