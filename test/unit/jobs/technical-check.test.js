import { describe, expect, it, vi } from 'vitest'
import { SafeFetchError } from '../../../server/infrastructure/http/safe-fetch.js'
import { createSourceTechnicalCheckAdapter } from '../../../server/infrastructure/http/source-technical-check.js'

describe('source technical-check adapter', () => {
  it('checks RSS through safe fetch and returns bounded evidence only', async () => {
    const safeFetch = vi.fn(async () => ({ contentType: 'application/rss+xml', resolvedHost: 'example.com', body: Buffer.from('<rss/>') }))
    const adapter = createSourceTechnicalCheckAdapter({ safeFetch, now: () => new Date('2026-08-10T00:00:00.000Z') })
    const result = await adapter.run({ source: { connectorType: 'rss', connectorConfig: { kind: 'rss', feedUrl: 'https://example.com/feed.xml' } } })
    expect(safeFetch).toHaveBeenCalledWith('https://example.com/feed.xml', expect.objectContaining({ allowedContentTypes: expect.arrayContaining(['application/rss+xml', 'application/atom+xml']) }))
    expect(result).toEqual({ status: 'passed', checkedAt: new Date('2026-08-10T00:00:00.000Z'), contentType: 'application/rss+xml', resolvedHost: 'example.com', sampleCount: 1 })
    expect(result).not.toHaveProperty('body')
  })

  it('maps safe-fetch rejection to redacted failed evidence', async () => {
    const safeFetch = vi.fn(async () => { throw new SafeFetchError('source_address_blocked', 'Unsafe address', { retryable: false }) })
    const adapter = createSourceTechnicalCheckAdapter({ safeFetch, now: () => new Date('2026-08-10T00:00:00.000Z') })
    const result = await adapter.run({ source: { connectorType: 'rss', connectorConfig: { kind: 'rss', feedUrl: 'https://example.com/feed.xml' } } })
    expect(result.status).toBe('failed')
    expect(result.error).toEqual(expect.objectContaining({ code: 'source_address_blocked', retryable: false }))
    expect(JSON.stringify(result)).not.toContain('https://')
  })

  it.each([
    [{ connectorType: 'arxiv', connectorConfig: { kind: 'arxiv', arxivQuery: 'cat:cs.AI' } }, /export\.arxiv\.org\/api\/query/, 'application/xml'],
    [{ connectorType: 'hacker-news', connectorConfig: { kind: 'hacker-news', hackerNewsStream: 'topstories' } }, /hacker-news\.firebaseio\.com\/v0\/topstories\.json/, 'application/json'],
  ])('derives the closed endpoint and content-type allowlist', async (source, expectedUrl, expectedType) => {
    const safeFetch = vi.fn(async () => ({ contentType: expectedType, resolvedHost: 'public.example', body: Buffer.from('payload') }))
    const adapter = createSourceTechnicalCheckAdapter({ safeFetch })
    await expect(adapter.run({ source })).resolves.toEqual(expect.objectContaining({ status: 'passed', sampleCount: 1 }))
    expect(safeFetch.mock.calls[0][0]).toMatch(expectedUrl)
    expect(safeFetch.mock.calls[0][1].allowedContentTypes).toContain(expectedType)
  })

  it('fails safely for empty payloads, invalid connectors and bounded upstream status evidence', async () => {
    const whenEmpty = createSourceTechnicalCheckAdapter({ safeFetch: async () => ({ contentType: 'application/rss+xml', resolvedHost: 'example.com', body: Buffer.alloc(0) }) })
    await expect(whenEmpty.run({ source: { connectorType: 'rss', connectorConfig: { kind: 'rss', feedUrl: 'https://example.com/feed' } } })).resolves.toEqual(expect.objectContaining({ status: 'failed', error: expect.objectContaining({ code: 'source_empty_payload' }) }))
    const invalid = createSourceTechnicalCheckAdapter({ safeFetch: vi.fn() })
    await expect(invalid.run({ source: { connectorType: 'unknown' } })).resolves.toEqual(expect.objectContaining({ status: 'failed', error: expect.objectContaining({ code: 'source_check_failed' }) }))
    const upstream = createSourceTechnicalCheckAdapter({ safeFetch: async () => { throw new SafeFetchError('source_upstream_status', 'raw upstream detail', { retryable: true, upstreamStatus: 503 }) } })
    const result = await upstream.run({ source: { connectorType: 'rss', connectorConfig: { kind: 'rss', feedUrl: 'https://example.com/feed' } } })
    expect(result.error).toEqual(expect.objectContaining({ upstreamStatus: 503, message: 'Source technical check failed safely' }))
  })
})
