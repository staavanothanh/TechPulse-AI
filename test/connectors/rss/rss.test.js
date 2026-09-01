import { readFile } from 'node:fs/promises'
import { gzipSync } from 'node:zlib'
import { describe, expect, it, vi } from 'vitest'
import {
  RSS_CONTENT_TYPES,
  RssConnectorError,
  createRssConnector,
  parseRssAtom,
} from '../../../server/connectors/rss/index.js'

const FIXTURE_ROOT = new URL('../../fixtures/rss/', import.meta.url)
const RETRIEVED_AT = new Date('2026-08-10T00:00:00.000Z')

async function fixture(name) {
  return readFile(new URL(name, FIXTURE_ROOT))
}

async function hostileFixture(name) {
  const body = (await fixture(name)).toString()
  if (name === 'oversized-field.xml') return Buffer.from(body.replace('FIELD_OVER_LIMIT', 'A'.repeat(20_001)))
  if (name === 'oversized-items.xml') {
    const items = Array.from({ length: 101 }, (_, index) => '<item><title>Item ' + index + '</title><link>https://news.example.test/' + index + '</link></item>').join('')
    return Buffer.from(body.replace('<item><title>ITEM_OVER_LIMIT</title><link>https://news.example.test/one</link></item>', items))
  }
  return Buffer.from(body)
}

function source(overrides = {}) {
  return {
    id: 'source-1',
    sourceKey: 'rss:example',
    name: 'Example Feed',
    connectorType: 'rss',
    accessMethod: 'rss',
    authorityTier: 'editorial',
    connectorConfig: { kind: 'rss', feedUrl: 'https://feeds.example.test/rss.xml' },
    ...overrides,
  }
}

describe('RSS/Atom connector', () => {
  it('normalizes RSS 2.0 into the common candidate schema without raw content', async () => {
    const connector = createRssConnector({ now: () => RETRIEVED_AT })
    const result = await connector.run({
      source: source(),
      payload: { body: await fixture('valid-rss.xml'), contentType: 'application/rss+xml', url: 'https://feeds.example.test/rss.xml' },
      retrievedAt: RETRIEVED_AT,
    })

    expect(result.candidates).toHaveLength(1)
    expect(result.candidates[0]).toMatchObject({
      sourceId: 'source-1',
      connectorType: 'rss',
      externalId: 'guid-1',
      titleOriginal: 'AI systems ship a bounded parser',
      originalUrl: 'https://news.example.test/articles/1',
      author: 'Ada Example',
      sourceLanguage: 'en',
      excerptOriginal: 'A short official excerpt.',
      retrievedAt: RETRIEVED_AT,
      mediaCandidate: { url: 'https://cdn.example.test/images/one.jpg', type: 'image', alt: 'A safe image', credit: 'Example Media' },
      provenance: {
        sourceId: 'source-1',
        sourceKey: 'rss:example',
        connectorType: 'rss',
        externalId: 'guid-1',
        originalUrl: 'https://news.example.test/articles/1',
        feedUrl: 'https://feeds.example.test/rss.xml',
        observedAt: RETRIEVED_AT,
      },
    })
    expect(JSON.stringify(result.candidates[0])).not.toMatch(/<[^>]+>|rawHtml|fullText|body|binary|base64|gridfs/i)
  })

  it('accepts a bounded set of safe HTML entities used by real RSS feeds', async () => {
    const body = '<rss version="2.0"><channel><item><title>Cloud cost &euro;100 &mdash; now</title><link>https://news.example.test/entities</link><guid>entities</guid><description>Use &ldquo;metadata-only&rdquo; &hellip;</description></item></channel></rss>'
    const [candidate] = (await createRssConnector({ now: () => RETRIEVED_AT }).run({
      source: source(),
      payload: { body, contentType: 'application/rss+xml', url: 'https://feeds.example.test/rss.xml' },
    })).candidates
    expect(candidate).toMatchObject({
      titleOriginal: 'Cloud cost €100 — now',
      excerptOriginal: 'Use “metadata-only” …',
    })
  })

  it('normalizes Atom and namespace-prefixed fields through the same interface', async () => {
    const connector = createRssConnector({ now: () => RETRIEVED_AT })
    const result = await connector.run({
      source: source({ accessMethod: 'atom', connectorConfig: { kind: 'rss', feedUrl: 'https://feeds.example.test/atom.xml' } }),
      payload: { body: await fixture('valid-atom.xml'), contentType: 'application/atom+xml', url: 'https://feeds.example.test/atom.xml' },
    })

    expect(result.candidates).toHaveLength(1)
    expect(result.candidates[0]).toMatchObject({
      externalId: 'urn:uuid:entry-1',
      titleOriginal: 'Atom entry with safe metadata',
      originalUrl: 'https://research.example.test/papers/1',
      author: 'Dr. Lin',
      sourceLanguage: 'vi',
      excerptOriginal: 'Atom summary only.',
      mediaCandidate: { url: 'https://media.example.test/video.mp4', type: 'video', alt: 'A video', credit: 'Research Lab' },
    })
    expect(result.candidates[0]).not.toHaveProperty('content')
  })

  it('preserves explicit empty fields while omitting missing optional fields', async () => {
    const connector = createRssConnector({ now: () => RETRIEVED_AT })
    const result = await connector.run({
      source: source(),
      payload: { body: await fixture('missing-date.xml'), contentType: 'text/xml', url: 'https://feeds.example.test/rss.xml' },
    })
    const [candidate] = result.candidates
    expect(candidate).toHaveProperty('author', '')
    expect(candidate).not.toHaveProperty('publishedAt')
    expect(candidate).not.toHaveProperty('sourceLanguage')
    expect(candidate).not.toHaveProperty('excerptOriginal')
  })

  it('keeps explicit empty date/language/excerpt values distinct from missing fields', async () => {
    const body = '<rss version="2.0"><channel><item><title>Empty metadata</title><link>https://news.example.test/empty</link><guid>empty</guid><pubDate></pubDate><language></language><description></description></item></channel></rss>'
    const [candidate] = (await createRssConnector({ now: () => RETRIEVED_AT }).run({
      source: source(),
      payload: { body, contentType: 'application/rss+xml', url: 'https://feeds.example.test/rss.xml' },
    })).candidates
    expect(candidate).toHaveProperty('publishedAt', null)
    expect(candidate).toHaveProperty('sourceLanguage', '')
    expect(candidate).toHaveProperty('excerptOriginal', '')
  })

  it('retains duplicate external IDs for Step 7 deduplication while keeping provenance separate', async () => {
    const result = await createRssConnector({ now: () => RETRIEVED_AT }).run({
      source: source(),
      payload: { body: await fixture('duplicate-ids.xml'), contentType: 'application/rss+xml', url: 'https://feeds.example.test/rss.xml' },
    })
    expect(result.candidates).toHaveLength(2)
    expect(result.candidates.map(({ externalId }) => externalId)).toEqual(['same-id', 'same-id'])
    expect(result.candidates[0].provenance.observedAt).toEqual(RETRIEVED_AT)
    expect(result.candidates[1].provenance.observedAt).toEqual(RETRIEVED_AT)
  })

  it('drops unsafe article and media URLs without making a secondary request', async () => {
    const request = vi.fn()
    const result = await createRssConnector({ request }).run({
      source: source(),
      payload: { body: await fixture('unsafe-urls.xml'), contentType: 'application/rss+xml', url: 'https://feeds.example.test/rss.xml' },
    })
    expect(result.candidates).toHaveLength(1)
    expect(result.candidates[0]).not.toHaveProperty('originalUrl')
    expect(result.candidates[0]).not.toHaveProperty('mediaCandidate')
    expect(request).not.toHaveBeenCalled()
  })

  it.each([
    ['malformed.xml', 'source_payload_rejected'],
    ['xxe.xml', 'source_payload_rejected'],
    ['parameter-entity.xml', 'source_payload_rejected'],
    ['xinclude.xml', 'source_payload_rejected'],
    ['recursive-expansion.xml', 'source_payload_rejected'],
    ['extreme-nesting.xml', 'source_payload_rejected'],
    ['oversized-field.xml', 'source_payload_rejected'],
  ])('fails closed for hostile fixture %s', async (name, code) => {
    await expect(createRssConnector().run({
      source: source(),
      payload: { body: await hostileFixture(name), contentType: 'application/rss+xml', url: 'https://feeds.example.test/rss.xml' },
    })).rejects.toMatchObject({ code, retryable: false })
  })

  it('truncates oversized feeds to the newest maxItems instead of rejecting', async () => {
    const oversized = (await hostileFixture('oversized-items.xml')).toString()
    const truncated = await createRssConnector().run({
      source: source(),
      payload: { body: oversized, contentType: 'application/rss+xml', url: 'https://feeds.example.test/rss.xml' },
    })
    expect(truncated.candidates).toHaveLength(100)
    expect(truncated.candidates[0].titleOriginal).toBe('Item 0')
    expect(truncated.candidates.some((candidate) => candidate.titleOriginal === 'Item 100')).toBe(false)
  })

  it('rejects a normalized field whose descendants exceed maxFieldChars after joining and decoding', async () => {
    const body = (await fixture('normalized-field-over-limit.xml')).toString()
      .replace('DESC_PART_A', 'A'.repeat(11_000))
      .replace('DESC_PART_B', 'B'.repeat(11_000))
    await expect(createRssConnector().run({
      source: source(),
      payload: { body, contentType: 'application/rss+xml', url: 'https://feeds.example.test/rss.xml' },
    })).rejects.toMatchObject({ code: 'source_payload_rejected', retryable: false })
  })
  it('rejects non-allowlisted content types before parsing', async () => {
    await expect(createRssConnector().run({
      source: source(),
      payload: { body: await fixture('valid-rss.xml'), contentType: 'text/html', url: 'https://feeds.example.test/rss.xml' },
    })).rejects.toMatchObject({ code: 'source_payload_rejected', retryable: false })
    expect(RSS_CONTENT_TYPES).toEqual(expect.arrayContaining(['application/rss+xml', 'application/atom+xml']))
  })

  it('rejects compressed payloads instead of decompressing inside the connector', async () => {
    const body = await fixture('valid-rss.xml')
    await expect(createRssConnector().run({
      source: source(),
      payload: { body: gzipSync(body), contentType: 'application/rss+xml', contentEncoding: 'gzip', url: 'https://feeds.example.test/rss.xml' },
    })).rejects.toMatchObject({ code: 'source_payload_rejected', retryable: false })
  })

  it('accepts an already decoded string payload and derives feed provenance from the payload URL', async () => {
    const body = (await fixture('valid-rss.xml')).toString()
    const [candidate] = (await createRssConnector({ now: () => RETRIEVED_AT }).run({
      source: { id: 'source-2' },
      payload: { body, contentType: 'application/rss+xml; charset=utf-8', url: 'https://payload.example.test/feed.xml' },
    })).candidates
    expect(candidate.provenance.feedUrl).toBe('https://payload.example.test/feed.xml')
  })

  it('rejects invalid retrieval dates and malformed batch arguments safely', async () => {
    const connector = createRssConnector()
    await expect(connector.run({ source: source(), retrievedAt: 'not-a-date', payload: { body: '<rss/>', contentType: 'application/rss+xml' } })).rejects.toMatchObject({ code: 'source_config_rejected' })
    await expect(connector.runBatch({ source: source(), payloads: 'not-an-array' })).rejects.toMatchObject({ code: 'source_payload_rejected' })
  })

  it('normalizes Atom fallback fields and an enclosure without treating content as article text', async () => {
    const body = '<atom:feed xmlns:atom="http://www.w3.org/2005/Atom" xml:lang="en"><atom:entry xml:lang="fr"><atom:id></atom:id><atom:title></atom:title><atom:link rel="alternate">https://research.example.test/entry</atom:link><atom:author>Direct author</atom:author><atom:updated>2026-08-10T00:00:00Z</atom:updated><atom:summary></atom:summary><atom:link rel="enclosure" href="https://media.example.test/entry.mp4" type="video/mp4" alt="Video alt" credit="Video credit" /></atom:entry></atom:feed>'
    const [candidate] = (await createRssConnector({ now: () => RETRIEVED_AT }).run({
      source: { id: 'source-3', connectorConfig: { kind: 'rss', feedUrl: 'https://feeds.example.test/atom.xml' } },
      payload: { body, contentType: 'application/atom+xml', url: 'https://feeds.example.test/atom.xml' },
    })).candidates
    expect(candidate).toMatchObject({ externalId: '', titleOriginal: '', author: 'Direct author', sourceLanguage: 'fr', excerptOriginal: '', mediaCandidate: { type: 'video', alt: 'Video alt', credit: 'Video credit' } })
    expect(candidate.publishedAt).toEqual(new Date('2026-08-10T00:00:00.000Z'))
  })

  it('terminates isolated parse work at the hard deadline instead of waiting for a blocking workload', async () => {
    const body = await fixture('valid-rss.xml')
    const startedAt = Date.now()
    await expect(createRssConnector({ workerDelayMs: 250, limits: { parseDeadlineMs: 100 } }).run({
      source: source(),
      payload: { body, contentType: 'application/rss+xml', url: 'https://feeds.example.test/rss.xml' },
    })).rejects.toMatchObject({ code: 'source_payload_rejected', retryable: false })
    expect(Date.now() - startedAt).toBeLessThan(220)
  })
  it('keeps parser-local cap separate from an outer ingestion deadline', async () => {
    const body = await fixture('valid-rss.xml')
    await expect(createRssConnector({ workerDelayMs: 250, limits: { parseDeadlineMs: 100 } }).run({
      source: source(),
      payload: { body, contentType: 'application/rss+xml', url: 'https://feeds.example.test/rss.xml' },
      deadline: new Date(Date.now() + 5_000),
    })).rejects.toMatchObject({ code: 'source_payload_rejected', retryable: false })
    await expect(createRssConnector({ workerDelayMs: 250, limits: { parseDeadlineMs: 1_000 } }).run({
      source: source(),
      payload: { body, contentType: 'application/rss+xml', url: 'https://feeds.example.test/rss.xml' },
      deadline: new Date(Date.now() + 50),
    })).rejects.toMatchObject({ code: 'ingestion_deadline_exceeded', retryable: false })
  })

  it('maps a batch rejection to a redacted result and does not crash the batch', async () => {
    const connector = createRssConnector({ now: () => RETRIEVED_AT })
    const result = await connector.runBatch({
      source: source(),
      payloads: [
        { body: await fixture('valid-rss.xml'), contentType: 'application/rss+xml', url: 'https://feeds.example.test/rss.xml' },
        { body: await fixture('malformed.xml'), contentType: 'application/rss+xml', url: 'https://feeds.example.test/rss.xml' },
      ],
    })
    expect(result.candidates).toHaveLength(1)
    expect(result.errors).toEqual([expect.objectContaining({ code: 'source_payload_rejected', retryable: false })])
    expect(JSON.stringify(result.errors)).not.toMatch(/<!DOCTYPE|ENTITY|https?:\/\//i)
  })

  it('exposes a typed redacted error for invalid direct payloads', () => {
    expect(() => parseRssAtom({ body: Buffer.alloc(0), contentType: 'application/rss+xml' })).toThrow(RssConnectorError)
    try {
      parseRssAtom({ body: Buffer.alloc(0), contentType: 'application/rss+xml' })
    } catch (error) {
      expect(error).toMatchObject({ code: 'source_payload_rejected', retryable: false })
      expect(error.message).not.toContain('Buffer')
    }
  })
})
