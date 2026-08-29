import { describe, expect, it } from 'vitest'
import { createRssConnector } from '../../../server/connectors/rss/index.js'

const RETRIEVED_AT = new Date('2026-08-20T00:00:00.000Z')

function feedWithItems(count) {
  const items = Array.from({ length: count }, (_, index) => `
    <item>
      <title>Story ${index + 1}</title>
      <link>https://news.example.com/story-${index + 1}</link>
      <guid>story-${index + 1}</guid>
    </item>`).join('')
  return `<rss version="2.0"><channel><title>Example</title>${items}</channel></rss>`
}

describe('RSS feed item bound', () => {
  it('keeps the first maxItems items and truncates the rest instead of rejecting the feed', async () => {
    const body = feedWithItems(150)
    const connector = createRssConnector({ now: () => RETRIEVED_AT })

    const result = await connector.run({
      source: {
        id: 'source-1',
        sourceKey: 'rss:large-feed',
        connectorType: 'rss',
        connectorConfig: { kind: 'rss', feedUrl: 'https://news.example.com/feed.xml' },
      },
      payload: { body, contentType: 'application/rss+xml', url: 'https://news.example.com/feed.xml' },
      retrievedAt: RETRIEVED_AT,
    })

    expect(result.candidates).toHaveLength(100)
    expect(result.candidates[0].externalId).toBe('story-1')
    expect(result.candidates[99].externalId).toBe('story-100')
    expect(result.candidates.some((candidate) => candidate.externalId === 'story-101')).toBe(false)
  })

  it('keeps all items when the feed has at most maxItems', async () => {
    const body = feedWithItems(100)
    const connector = createRssConnector({ now: () => RETRIEVED_AT })

    const result = await connector.run({
      source: {
        id: 'source-1',
        sourceKey: 'rss:small-feed',
        connectorType: 'rss',
        connectorConfig: { kind: 'rss', feedUrl: 'https://news.example.com/small.xml' },
      },
      payload: { body, contentType: 'application/rss+xml', url: 'https://news.example.com/small.xml' },
      retrievedAt: RETRIEVED_AT,
    })

    expect(result.candidates).toHaveLength(100)
    expect(result.candidates[0].externalId).toBe('story-1')
    expect(result.candidates[99].externalId).toBe('story-100')
  })
})
