import { describe, expect, it } from 'vitest'
import { createRssConnector } from '../../../server/connectors/rss/index.js'

const RETRIEVED_AT = new Date('2026-08-27T00:00:00.000Z')

describe('RSS/Atom embedded media metadata', () => {
  it('uses a safe image reference from an official RSS description when explicit media is absent', async () => {
    const connector = createRssConnector({ now: () => RETRIEVED_AT })
    const result = await connector.run({
      source: {
        id: 'source-1',
        sourceKey: 'rss:example',
        connectorType: 'rss',
        connectorConfig: { kind: 'rss', feedUrl: 'https://news.example.com/feed.xml' },
      },
      payload: {
        contentType: 'application/rss+xml',
        url: 'https://news.example.com/feed.xml',
        body: `
          <rss version="2.0"><channel><item>
            <title>Official image metadata</title>
            <link>https://news.example.com/articles/1</link>
            <guid>image-1</guid>
            <pubDate>Wed, 27 Aug 2026 00:00:00 GMT</pubDate>
            <description><![CDATA[<p>Official excerpt.</p><img src="https://cdn.example.com/images/one.jpg" alt="A safe diagram">]]></description>
          </item></channel></rss>`,
      },
      retrievedAt: RETRIEVED_AT,
    })

    expect(result.candidates[0].mediaCandidate).toEqual({
      type: 'image',
      url: 'https://cdn.example.com/images/one.jpg',
      alt: 'A safe diagram',
    })
    expect(JSON.stringify(result)).not.toContain('<img')
  })

  it('does not use an unsafe embedded image URL', async () => {
    const connector = createRssConnector({ now: () => RETRIEVED_AT })
    const result = await connector.run({
      source: {
        id: 'source-1',
        sourceKey: 'rss:example',
        connectorType: 'rss',
        connectorConfig: { kind: 'rss', feedUrl: 'https://news.example.com/feed.xml' },
      },
      payload: {
        contentType: 'application/rss+xml',
        url: 'https://news.example.com/feed.xml',
        body: `
          <rss version="2.0"><channel><item>
            <title>Unsafe image metadata</title>
            <link>https://news.example.com/articles/2</link>
            <guid>image-2</guid>
            <pubDate>Wed, 27 Aug 2026 00:00:00 GMT</pubDate>
            <description><![CDATA[<img src="http://127.0.0.1/private.jpg" alt="Unsafe">]]></description>
          </item></channel></rss>`,
      },
      retrievedAt: RETRIEVED_AT,
    })

    expect(result.candidates[0]).not.toHaveProperty('mediaCandidate')
  })

  it('ignores image-like text inside an RSS script block', async () => {
    const connector = createRssConnector({ now: () => RETRIEVED_AT })
    const result = await connector.run({
      source: {
        id: 'source-1',
        sourceKey: 'rss:example',
        connectorType: 'rss',
        connectorConfig: { kind: 'rss', feedUrl: 'https://news.example.com/feed.xml' },
      },
      payload: {
        contentType: 'application/rss+xml',
        url: 'https://news.example.com/feed.xml',
        body: `
          <rss version="2.0"><channel><item>
            <title>Script image-like text</title>
            <link>https://news.example.com/articles/3</link>
            <guid>image-3</guid>
            <pubDate>Wed, 27 Aug 2026 00:00:00 GMT</pubDate>
            <description><![CDATA[<script>const bait = '<img src="https://cdn.example.com/images/bait.jpg" alt="Bait">'</script><img src="https://cdn.example.com/images/real.jpg" alt="Real">]]></description>
          </item></channel></rss>`,
      },
      retrievedAt: RETRIEVED_AT,
    })

    expect(result.candidates[0].mediaCandidate).toEqual({
      type: 'image',
      url: 'https://cdn.example.com/images/real.jpg',
      alt: 'Real',
    })
  })

  it('uses a safe image reference from official Atom content when summary media is absent', async () => {
    const connector = createRssConnector({ now: () => RETRIEVED_AT })
    const result = await connector.run({
      source: {
        id: 'source-1',
        sourceKey: 'rss:example',
        connectorType: 'rss',
        connectorConfig: { kind: 'rss', feedUrl: 'https://news.example.com/feed.xml' },
      },
      payload: {
        contentType: 'application/atom+xml',
        url: 'https://news.example.com/feed.xml',
        body: `
          <feed xmlns="http://www.w3.org/2005/Atom"><entry>
            <title>Atom image metadata</title>
            <id>atom-image-1</id>
            <updated>2026-08-27T00:00:00Z</updated>
            <link href="https://news.example.com/articles/3" />
            <content type="html"><![CDATA[<p>Official excerpt.</p><img src="https://cdn.example.com/images/atom.jpg" alt="An Atom diagram">]]></content>
          </entry></feed>`,
      },
      retrievedAt: RETRIEVED_AT,
    })

    expect(result.candidates[0].mediaCandidate).toEqual({
      type: 'image',
      url: 'https://cdn.example.com/images/atom.jpg',
      alt: 'An Atom diagram',
    })
    expect(JSON.stringify(result)).not.toContain('<img')
  })

  it('uses a safe image reference from structured Atom XHTML content without retaining markup', async () => {
    const connector = createRssConnector({ now: () => RETRIEVED_AT })
    const result = await connector.run({
      source: {
        id: 'source-1',
        sourceKey: 'rss:example',
        connectorType: 'rss',
        connectorConfig: { kind: 'rss', feedUrl: 'https://news.example.com/feed.xml' },
      },
      payload: {
        contentType: 'application/atom+xml',
        url: 'https://news.example.com/feed.xml',
        body: `
          <feed xmlns="http://www.w3.org/2005/Atom"><entry>
            <title>Structured Atom image metadata</title>
            <id>atom-image-2</id>
            <updated>2026-08-27T00:00:00Z</updated>
            <link href="https://news.example.com/articles/4" />
            <content type="xhtml"><div xmlns="http://www.w3.org/1999/xhtml"><img src="https://cdn.example.com/images/xhtml.jpg" alt="An XHTML diagram" /></div></content>
          </entry></feed>`,
      },
      retrievedAt: RETRIEVED_AT,
    })

    expect(result.candidates[0].mediaCandidate).toEqual({
      type: 'image',
      url: 'https://cdn.example.com/images/xhtml.jpg',
      alt: 'An XHTML diagram',
    })
    expect(JSON.stringify(result)).not.toContain('<div')
    expect(JSON.stringify(result)).not.toContain('<img')
  })

  it('ignores image-like nodes inside structured Atom script and style blocks', async () => {
    const connector = createRssConnector({ now: () => RETRIEVED_AT })
    const result = await connector.run({
      source: {
        id: 'source-1',
        sourceKey: 'rss:example',
        connectorType: 'rss',
        connectorConfig: { kind: 'rss', feedUrl: 'https://news.example.com/feed.xml' },
      },
      payload: {
        contentType: 'application/atom+xml',
        url: 'https://news.example.com/feed.xml',
        body: `
          <feed xmlns="http://www.w3.org/2005/Atom"><entry>
            <title>Structured script image-like nodes</title>
            <id>atom-image-3</id>
            <updated>2026-08-27T00:00:00Z</updated>
            <link href="https://news.example.com/articles/5" />
            <content type="xhtml"><div xmlns="http://www.w3.org/1999/xhtml">
              <script><img src="https://cdn.example.com/images/bait-script.jpg" alt="Bait script" /></script>
              <style>.x { background: url(https://cdn.example.com/images/bait-style.jpg); }</style>
              <img src="https://cdn.example.com/images/real-structured.jpg" alt="Real image" />
            </div></content>
          </entry></feed>`,
      },
      retrievedAt: RETRIEVED_AT,
    })

    expect(result.candidates[0].mediaCandidate).toEqual({
      type: 'image',
      url: 'https://cdn.example.com/images/real-structured.jpg',
      alt: 'Real image',
    })
  })
})
