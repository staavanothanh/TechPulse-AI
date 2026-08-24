import { describe, expect, it } from 'vitest'
import { createRssConnector } from '../../../server/connectors/rss/index.js'

const RETRIEVED_AT = new Date('2026-08-20T00:00:00.000Z')

describe('RSS media candidate ranking', () => {
  it('prefers media content image over an earlier thumbnail when both are safe', async () => {
    const body = `
      <rss version="2.0" xmlns:media="http://search.yahoo.com/mrss/">
        <channel><item>
          <title>Media ranking fixture</title>
          <link>https://news.example.com/article</link>
          <guid>media-ranking-1</guid>
          <media:thumbnail url="https://cdn.example.com/thumb.jpg" type="image/jpeg" />
          <media:content url="https://cdn.example.com/content.jpg" type="image/jpeg" medium="image">
            <media:description>Lead image</media:description>
            <media:credit>Example Media</media:credit>
          </media:content>
        </item></channel>
      </rss>`
    const connector = createRssConnector({ now: () => RETRIEVED_AT })

    const result = await connector.run({
      source: {
        id: 'source-1',
        sourceKey: 'rss:example',
        connectorType: 'rss',
        connectorConfig: { kind: 'rss', feedUrl: 'https://news.example.com/feed.xml' },
      },
      payload: { body, contentType: 'application/rss+xml', url: 'https://news.example.com/feed.xml' },
      retrievedAt: RETRIEVED_AT,
    })

    expect(result.candidates[0].mediaCandidate).toMatchObject({
      url: 'https://cdn.example.com/content.jpg',
      type: 'image',
      alt: 'Lead image',
      credit: 'Example Media',
    })
  })
})
