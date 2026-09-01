import { brotliCompressSync, deflateSync, gzipSync } from 'node:zlib'
import { describe, expect, it, vi } from 'vitest'
import { Readable } from 'node:stream'
import {
  SafeFetchError,
  assertPublicAddressSet,
  canonicalSourceUrl,
  createSafeFetch,
} from '../../../server/infrastructure/http/safe-fetch.js'

function response({ statusCode = 200, headers = { 'content-type': 'application/rss+xml' }, chunks = ['<rss/>'] } = {}) {
  return { statusCode, headers, body: Readable.from(chunks.map((chunk) => Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))) }
}

describe('SSRF-safe pinned source fetch', () => {
  it.each([
    'http://example.com/feed.xml',
    'https://user:password@example.com/feed.xml',
    'file:///etc/passwd',
    'data:text/plain,test',
  ])('rejects non-canonical source URL %s', (value) => {
    expect(() => canonicalSourceUrl(value)).toThrow(SafeFetchError)
  })

  it.each([
    [['127.0.0.1']],
    [['169.254.169.254']],
    [['10.0.0.1']],
    [['::1']],
    [['::ffff:127.0.0.1']],
    [['2001:db8::1']],
    [['93.184.216.34', '10.0.0.1']],
  ])('rejects private, mapped, reserved or mixed DNS answers', (answers) => {
    expect(() => assertPublicAddressSet(answers.map((address) => ({ address })))).toThrow(/public/i)
  })

  it('pins the validated IP while retaining original Host/SNI and performs no second DNS lookup', async () => {
    const lookup = vi.fn(async () => [{ address: '93.184.216.34', family: 4 }])
    const request = vi.fn(async (options) => {
      expect(options.address).toBe('93.184.216.34')
      expect(options.hostname).toBe('example.com')
      expect(options.servername).toBe('example.com')
      return response()
    })
    const safeFetch = createSafeFetch({ lookup, request })
    const result = await safeFetch('https://example.com/feed.xml', { allowedContentTypes: ['application/rss+xml'] })
    expect(result.body.toString()).toBe('<rss/>')
    expect(lookup).toHaveBeenCalledTimes(1)
    expect(request).toHaveBeenCalledTimes(1)
  })

  it('revalidates redirects and blocks a private redirect before another request', async () => {
    const lookup = vi.fn(async () => [{ address: '93.184.216.34', family: 4 }])
    const request = vi.fn(async () => response({ statusCode: 302, headers: { location: 'https://127.0.0.1/private' }, chunks: [] }))
    const safeFetch = createSafeFetch({ lookup, request })
    await expect(safeFetch('https://example.com/feed.xml', { allowedContentTypes: ['application/rss+xml'] })).rejects.toMatchObject({ code: 'source_address_blocked' })
    expect(request).toHaveBeenCalledTimes(1)
  })

  it('rejects content type before consuming a response body', async () => {
    let consumed = false
    const body = { async *[Symbol.asyncIterator]() { consumed = true; yield Buffer.from('secret') } }
    const safeFetch = createSafeFetch({ lookup: async () => [{ address: '93.184.216.34', family: 4 }], request: async () => ({ statusCode: 200, headers: { 'content-type': 'text/html' }, body }) })
    await expect(safeFetch('https://example.com/feed.xml', { allowedContentTypes: ['application/rss+xml'] })).rejects.toMatchObject({ code: 'source_content_type_rejected' })
    expect(consumed).toBe(false)
  })

  it('destroys real response streams on early redirect, status and declared-size rejection', async () => {
    for (const responseOptions of [
      { statusCode: 302, headers: { location: '/next' } },
      { statusCode: 503 },
      { headers: { 'content-type': 'application/rss+xml', 'content-length': '99' } },
    ]) {
      const body = Readable.from([Buffer.from('ignored')])
      const destroy = vi.spyOn(body, 'destroy')
      const safeFetch = createSafeFetch({ lookup: async () => [{ address: '93.184.216.34', family: 4 }], request: async () => ({ statusCode: 200, headers: { 'content-type': 'application/rss+xml' }, body, ...responseOptions }), limits: { redirects: 0, wireBytes: 10 } })
      await expect(safeFetch('https://example.com/feed', { allowedContentTypes: ['application/rss+xml'] })).rejects.toBeInstanceOf(SafeFetchError)
      expect(destroy).toHaveBeenCalled()
    }
  })

  it('uses one absolute deadline across a slow-drip body', async () => {
    const body = {
      destroy: vi.fn(),
      async *[Symbol.asyncIterator]() {
        for (;;) { await new Promise((resolve) => setTimeout(resolve, 10)); yield Buffer.from('x') }
      },
    }
    const safeFetch = createSafeFetch({ lookup: async () => [{ address: '93.184.216.34', family: 4 }], request: async () => ({ statusCode: 200, headers: { 'content-type': 'application/rss+xml' }, body }), limits: { timeoutMs: 25 } })
    await expect(safeFetch('https://example.com/feed', { allowedContentTypes: ['application/rss+xml'] })).rejects.toMatchObject({ code: 'source_fetch_timeout' })
    expect(body.destroy).toHaveBeenCalled()
  })

  it('applies the absolute deadline to a DNS lookup that never settles and does not start a request', async () => {
    const request = vi.fn()
    const safeFetch = createSafeFetch({
      lookup: () => new Promise(() => {}),
      request,
      limits: { timeoutMs: 20 },
    })
    const result = await Promise.race([
      safeFetch('https://example.com/feed.xml', { allowedContentTypes: ['application/rss+xml'] }).catch((error) => error),
      new Promise((resolve) => setTimeout(() => resolve('outer_timeout'), 80)),
    ])
    expect(result).toMatchObject({ code: 'source_fetch_timeout' })
    expect(request).not.toHaveBeenCalled()
  })

  it('uses the original deadline for DNS after a redirect and does not request the redirected host', async () => {
    const lookup = vi.fn()
      .mockResolvedValueOnce([{ address: '93.184.216.34', family: 4 }])
      .mockImplementationOnce(() => new Promise(() => {}))
    const request = vi.fn(async () => response({ statusCode: 302, headers: { location: 'https://redirected.example/feed.xml' }, chunks: [] }))
    const safeFetch = createSafeFetch({ lookup, request, limits: { timeoutMs: 20 } })
    const result = await Promise.race([
      safeFetch('https://example.com/feed.xml', { allowedContentTypes: ['application/rss+xml'] }).catch((error) => error),
      new Promise((resolve) => setTimeout(() => resolve('outer_timeout'), 80)),
    ])
    expect(result).toMatchObject({ code: 'source_fetch_timeout' })
    expect(request).toHaveBeenCalledTimes(1)
    expect(lookup).toHaveBeenCalledTimes(2)
  })
  it('classifies a caller deadline separately from the local fetch timeout', async () => {
    const request = vi.fn()
    const safeFetch = createSafeFetch({ lookup: () => new Promise(() => {}), request, limits: { timeoutMs: 500 } })
    const result = await Promise.race([
      safeFetch('https://example.com/feed.xml', { allowedContentTypes: ['application/rss+xml'], deadline: new Date(Date.now() + 25) }).catch((error) => error),
      new Promise((resolve) => setTimeout(() => resolve('outer_timeout'), 150)),
    ])
    expect(result).toMatchObject({ code: 'ingestion_deadline_exceeded', retryable: false })
    expect(request).not.toHaveBeenCalled()
  })
  it('interrupts a pending request when the ingestion signal aborts', async () => {
    const controller = new globalThis.AbortController()
    const request = vi.fn(() => new Promise(() => {}))
    const safeFetch = createSafeFetch({ lookup: async () => [{ address: '93.184.216.34', family: 4 }], request, limits: { timeoutMs: 500 } })
    const pending = safeFetch('https://example.com/feed.xml', { allowedContentTypes: ['application/rss+xml'], signal: controller.signal })
    setTimeout(() => controller.abort(Object.assign(new Error('heartbeat details'), { code: 'lease_heartbeat_lost', retryable: true })), 10)
    await expect(pending).rejects.toMatchObject({ code: 'lease_heartbeat_lost', retryable: true })
    expect(request).toHaveBeenCalledWith(expect.objectContaining({ signal: controller.signal }))
  })
  it('destroys a response body when abort lands after headers resolve', async () => {
    const controller = new globalThis.AbortController()
    const body = { destroy: vi.fn(), async *[Symbol.asyncIterator]() {} }
    const reason = Object.assign(new Error('stream detail'), { code: 'lease_heartbeat_lost', retryable: true })
    const request = vi.fn(async () => {
      controller.abort(reason)
      return { statusCode: 200, headers: { 'content-type': 'application/rss+xml' }, body }
    })
    const safeFetch = createSafeFetch({ lookup: async () => [{ address: '93.184.216.34', family: 4 }], request, limits: { timeoutMs: 500 } })

    await expect(safeFetch('https://example.com/feed.xml', { allowedContentTypes: ['application/rss+xml'], signal: controller.signal })).rejects.toMatchObject({ code: 'lease_heartbeat_lost' })
    expect(body.destroy).toHaveBeenCalled()
  })
  it('destroys a response body when the stream iterator fails', async () => {
    const body = {
      destroy: vi.fn(),
      async *[Symbol.asyncIterator]() { throw new Error('provider stream detail') },
    }
    const safeFetch = createSafeFetch({
      lookup: async () => [{ address: '93.184.216.34', family: 4 }],
      request: async () => ({ statusCode: 200, headers: { 'content-type': 'application/rss+xml' }, body }),
    })

    await expect(safeFetch('https://example.com/feed.xml', { allowedContentTypes: ['application/rss+xml'] })).rejects.toMatchObject({ code: 'source_fetch_failed', retryable: true })
    expect(body.destroy).toHaveBeenCalled()
  })

  it('enforces independent wire, decoded and expansion-ratio limits', async () => {
    const lookup = async () => [{ address: '93.184.216.34', family: 4 }]
    const wireFetch = createSafeFetch({ lookup, request: async () => response({ chunks: [Buffer.alloc(17)] }), limits: { wireBytes: 16, decodedBytes: 64, expansionRatio: 20 } })
    await expect(wireFetch('https://example.com/feed.xml', { allowedContentTypes: ['application/rss+xml'] })).rejects.toMatchObject({ code: 'source_wire_limit' })

    const decodedFetch = createSafeFetch({ lookup, request: async () => response({ chunks: [Buffer.alloc(33)] }), limits: { wireBytes: 64, decodedBytes: 32, expansionRatio: 20 } })
    await expect(decodedFetch('https://example.com/feed.xml', { allowedContentTypes: ['application/rss+xml'] })).rejects.toMatchObject({ code: 'source_decoded_limit' })

    const compressed = gzipSync(Buffer.alloc(1024, 'a'))
    const ratioFetch = createSafeFetch({ lookup, request: async () => response({ headers: { 'content-type': 'application/rss+xml', 'content-encoding': 'gzip' }, chunks: [compressed] }), limits: { wireBytes: 2048, decodedBytes: 2048, expansionRatio: 4 } })
    await expect(ratioFetch('https://example.com/feed.xml', { allowedContentTypes: ['application/rss+xml'] })).rejects.toMatchObject({ code: 'source_expansion_limit' })
  })

  it('fails closed for empty/failed DNS and invalid safety configuration', async () => {
    expect(() => assertPublicAddressSet([])).toThrow(/usable address/i)
    expect(() => createSafeFetch({ limits: { wireBytes: 0 } })).toThrow(/limits/i)
    const failed = createSafeFetch({ lookup: async () => { throw new Error('dns detail') }, request: vi.fn() })
    await expect(failed('https://example.com/feed', { allowedContentTypes: ['application/rss+xml'] })).rejects.toMatchObject({ code: 'source_dns_failed', retryable: true })
    const empty = createSafeFetch({ lookup: async () => [], request: vi.fn() })
    await expect(empty('https://example.com/feed', { allowedContentTypes: ['application/rss+xml'] })).rejects.toMatchObject({ code: 'source_dns_empty' })
  })

  it('handles relative redirects, header arrays and bounded upstream status', async () => {
    const lookup = vi.fn(async () => [{ address: '93.184.216.34', family: 4 }])
    const request = vi.fn()
      .mockResolvedValueOnce(response({ statusCode: 302, headers: { location: ['/next'] }, chunks: [] }))
      .mockResolvedValueOnce(response({ headers: { 'content-type': ['application/rss+xml; charset=utf-8'] } }))
    const result = await createSafeFetch({ lookup, request })('https://example.com/start', { allowedContentTypes: ['application/rss+xml'] })
    expect(result.url).toBe('https://example.com/next')
    expect(lookup).toHaveBeenCalledTimes(2)

    const upstream = createSafeFetch({ lookup, request: async () => response({ statusCode: 503, chunks: [] }) })
    await expect(upstream('https://example.com/feed', { allowedContentTypes: ['application/rss+xml'] })).rejects.toMatchObject({ code: 'source_upstream_status', upstreamStatus: 503, retryable: true })
  })

  it.each([
    ['deflate', deflateSync(Buffer.from('<rss/>'))],
    ['br', brotliCompressSync(Buffer.from('<rss/>'))],
  ])('decodes supported %s responses', async (encoding, encoded) => {
    const safeFetch = createSafeFetch({ lookup: async () => [{ address: '93.184.216.34', family: 4 }], request: async () => response({ headers: { 'content-type': 'application/rss+xml', 'content-encoding': encoding }, chunks: [encoded] }) })
    await expect(safeFetch('https://example.com/feed', { allowedContentTypes: ['application/rss+xml'] })).resolves.toEqual(expect.objectContaining({ body: Buffer.from('<rss/>') }))
  })

  it('rejects unsupported/corrupt encodings, declared oversize and stream failure', async () => {
    const lookup = async () => [{ address: '93.184.216.34', family: 4 }]
    const unsupported = createSafeFetch({ lookup, request: async () => response({ headers: { 'content-type': 'application/rss+xml', 'content-encoding': 'compress' } }) })
    await expect(unsupported('https://example.com/feed', { allowedContentTypes: ['application/rss+xml'] })).rejects.toMatchObject({ code: 'source_encoding_rejected' })
    const corrupt = createSafeFetch({ lookup, request: async () => response({ headers: { 'content-type': 'application/rss+xml', 'content-encoding': 'gzip' }, chunks: ['not-gzip'] }) })
    await expect(corrupt('https://example.com/feed', { allowedContentTypes: ['application/rss+xml'] })).rejects.toMatchObject({ code: 'source_decode_failed' })
    const declared = createSafeFetch({ lookup, request: async () => response({ headers: { 'content-type': 'application/rss+xml', 'content-length': '999' } }), limits: { wireBytes: 10 } })
    await expect(declared('https://example.com/feed', { allowedContentTypes: ['application/rss+xml'] })).rejects.toMatchObject({ code: 'source_wire_limit' })
    const brokenBody = { [Symbol.asyncIterator]() { return { next: async () => { throw new Error('stream detail') } } } }
    const broken = createSafeFetch({ lookup, request: async () => ({ statusCode: 200, headers: { 'content-type': 'application/rss+xml' }, body: brokenBody }) })
    await expect(broken('https://example.com/feed', { allowedContentTypes: ['application/rss+xml'] })).rejects.toMatchObject({ code: 'source_fetch_failed', retryable: true })
  })

  it('requires a response content-type allowlist and rejects exhausted redirects', async () => {
    const lookup = async () => [{ address: '93.184.216.34', family: 4 }]
    const safeFetch = createSafeFetch({ lookup, request: async () => response() })
    await expect(safeFetch('https://example.com/feed')).rejects.toThrow(/allowlist/i)
    const loop = createSafeFetch({ lookup, request: async () => response({ statusCode: 302, headers: { location: '/again' }, chunks: [] }), limits: { redirects: 0 } })
    await expect(loop('https://example.com/feed', { allowedContentTypes: ['application/rss+xml'] })).rejects.toMatchObject({ code: 'source_redirect_rejected' })
  })
})
