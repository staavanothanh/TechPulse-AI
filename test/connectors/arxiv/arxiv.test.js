import { readFile } from 'node:fs/promises'
import { describe, expect, it, vi } from 'vitest'
import {
  ArxivConnectorError,
  createArxivConnector,
  normalizeArxivId,
  parseArxiv,
} from '../../../server/connectors/arxiv/index.js'
import { createSafeFetch } from '../../../server/infrastructure/http/safe-fetch.js'

const FIXTURE_ROOT = new URL('../../fixtures/arxiv/', import.meta.url)
const RETRIEVED_AT = new Date('2026-08-11T00:00:00.000Z')

async function fixture(name) {
  return readFile(new URL(name, FIXTURE_ROOT))
}

function source(overrides = {}) {
  return {
    id: 'source-arxiv-1',
    sourceKey: 'arxiv:ai',
    connectorType: 'arxiv',
    accessMethod: 'api',
    authorityTier: 'primary',
    connectorConfig: { kind: 'arxiv', arxivQuery: 'cat:cs.AI', batchSize: 2 },
    ...overrides,
  }
}

describe('arXiv connector', () => {
  it('paginates official Atom responses and returns the common candidate contract without PDF/body storage', async () => {
    const pageOne = await fixture('page-1.xml')
    const pageTwo = await fixture('page-2.xml')
    const request = vi.fn(async ({ start }) => ({
      statusCode: 200,
      contentType: 'application/atom+xml',
      body: start === 0 ? pageOne : pageTwo,
    }))
    const sleep = vi.fn(async () => {})
    const result = await createArxivConnector({ now: () => RETRIEVED_AT, request, sleep, limits: { requestIntervalMs: 0 } }).run({ source: source() })

    expect(request).toHaveBeenCalledTimes(2)
    expect(request.mock.calls.map(([input]) => input.start)).toEqual([0, 2])
    expect(result.candidates).toHaveLength(3)
    expect(result.candidates[0]).toMatchObject({
      sourceId: 'source-arxiv-1',
      connectorType: 'arxiv',
      authorityTier: 'primary',
      externalId: '2401.12345',
      externalIdVersion: 2,
      titleOriginal: 'First paper & bounded parsing',
      originalUrl: 'https://arxiv.org/abs/2401.12345v2',
      author: 'Ada Example; Lin Example',
      sourceLanguage: 'en',
      excerptOriginal: 'An official abstract excerpt.',
      licenseMetadata: { url: 'https://creativecommons.org/licenses/by/4.0/', text: 'Creative Commons Attribution 4.0' },
      topics: ['cs.AI', 'cs.LG'],
      retrievedAt: RETRIEVED_AT,
      provenance: {
        connectorType: 'arxiv',
        sourceId: 'source-arxiv-1',
        sourceKey: 'arxiv:ai',
        externalId: '2401.12345',
        originalUrl: 'https://arxiv.org/abs/2401.12345v2',
        observedAt: RETRIEVED_AT,
      },
    })
    expect(result.candidates[2]).toMatchObject({ externalId: 'hep-th/9901001', externalIdVersion: 3 })
    expect(result.metrics).toMatchObject({ pagesFetched: 2, entriesSeen: 3, candidatesAccepted: 3, requests: 2 })
    expect(JSON.stringify(result)).not.toMatch(/<p>|pdf|raw|fullText|response|body/i)
  })

  it('waits between pages when rate etiquette is configured', async () => {
    const pageOne = await fixture('page-1.xml')
    const pageTwo = await fixture('page-2.xml')
    const request = vi.fn()
      .mockResolvedValueOnce({ statusCode: 200, contentType: 'application/xml', body: pageOne })
      .mockResolvedValueOnce({ statusCode: 200, contentType: 'application/xml', body: pageTwo })
    const sleep = vi.fn(async () => {})
    await createArxivConnector({ request: vi.fn(async () => ({ statusCode: 200, contentType: 'application/xml', body: pageOne })), sleep, limits: { requestIntervalMs: 25, maxPages: 1, maxResults: 1 } }).run({ source: source({ connectorConfig: { kind: 'arxiv', arxivQuery: 'cat:cs.AI', batchSize: 1 } }) })
    expect(sleep).not.toHaveBeenCalled()
    await createArxivConnector({ request, sleep, limits: { requestIntervalMs: 25, maxPages: 2, maxResults: 2 } }).run({ source: source() })
    expect(sleep).toHaveBeenCalledWith(25)
  })
  it('interrupts request backoff when the ingestion signal aborts', async () => {
    const page = await fixture('page-1.xml')
    const controller = new globalThis.AbortController()
    const reason = Object.assign(new Error('heartbeat details'), { code: 'lease_heartbeat_lost', retryable: true })
    const request = vi.fn(async () => ({ statusCode: 200, contentType: 'application/xml', body: page }))
    const sleep = vi.fn(() => new Promise(() => {}))
    const pending = createArxivConnector({ request, sleep, limits: { requestIntervalMs: 100, maxPages: 2, maxResults: 2 } }).run({ source: source(), signal: controller.signal })

    await vi.waitFor(() => expect(sleep).toHaveBeenCalledWith(100))
    controller.abort(reason)
    await expect(pending).rejects.toMatchObject({ code: 'lease_heartbeat_lost', retryable: true })
    expect(request).toHaveBeenCalledTimes(1)
  })
  it('interrupts request backoff when the outer deadline expires', async () => {
    const page = await fixture('page-1.xml')
    const sleep = vi.fn(() => new Promise(() => {}))
    const request = vi.fn(async () => ({ statusCode: 200, contentType: 'application/xml', body: page }))
    const pending = createArxivConnector({ request, sleep, limits: { requestIntervalMs: 500, maxPages: 2, maxResults: 2 } }).run({ source: source(), deadline: new Date(Date.now() + 50) })

    await expect(pending).rejects.toMatchObject({ code: 'ingestion_deadline_exceeded', retryable: false })
    expect(sleep).toHaveBeenCalledWith(500)
    expect(request).toHaveBeenCalledTimes(1)
  })
  it('clears the default backoff timer when the outer deadline expires', async () => {
    vi.useFakeTimers()
    try {
      const page = await fixture('page-1.xml')
      const request = vi.fn(async () => ({ statusCode: 200, contentType: 'application/xml', body: page }))
      const pending = createArxivConnector({ request, limits: { requestIntervalMs: 500, maxPages: 2, maxResults: 2 } }).run({ source: source(), deadline: new Date(Date.now() + 50) })
      const rejection = expect(pending).rejects.toMatchObject({ code: 'ingestion_deadline_exceeded', retryable: false })

      await vi.advanceTimersByTimeAsync(0)
      await vi.advanceTimersByTimeAsync(50)
      await rejection
      expect(request).toHaveBeenCalledTimes(1)
      expect(vi.getTimerCount()).toBe(0)
    } finally {
      vi.useRealTimers()
    }
  })
  it('preserves a safe-fetch caller deadline failure', async () => {
    const safeFetch = createSafeFetch({
      lookup: async () => [{ address: '93.184.216.34', family: 4 }],
      request: () => new Promise(() => {}),
      limits: { timeoutMs: 500 },
    })
    const connector = createArxivConnector({ request: ({ url, deadline }) => safeFetch(url, { allowedContentTypes: ['application/atom+xml'], deadline }) })

    await expect(connector.run({ source: source(), deadline: new Date(Date.now() + 25) })).rejects.toMatchObject({ code: 'ingestion_deadline_exceeded', retryable: false })
  })

  it.each([
    [429, true],
    [503, true],
    [404, false],
  ])('maps upstream status %s to retryable=%s without exposing provider details', async (statusCode, retryable) => {
    const request = vi.fn(async () => ({ statusCode, body: Buffer.from('provider body must not leak') }))
    await expect(createArxivConnector({ request }).run({ source: source() })).rejects.toMatchObject({
      code: 'source_upstream_status',
      retryable,
      upstreamStatus: statusCode,
    })
    try { await createArxivConnector({ request }).run({ source: source() }) } catch (error) {
      expect(error.message).not.toMatch(/provider body|429|503|404/)
    }
  })

  it('rejects malformed XML and invalid source configuration as non-retryable safe errors', async () => {
    const body = await fixture('malformed.xml')
    await expect(createArxivConnector({ request: async () => ({ statusCode: 200, body }) }).run({ source: source() })).rejects.toMatchObject({ code: 'source_payload_rejected', retryable: false })
    await expect(createArxivConnector({ request: async () => ({ statusCode: 200, body }) }).run({ source: source({ authorityTier: 'editorial' }) })).rejects.toMatchObject({ code: 'source_config_rejected', retryable: false })
    expect(ArxivConnectorError).toBeTypeOf('function')
  })

  it('accepts one provider-free page without retaining the response body', async () => {
    const body = await fixture('page-1.xml')
    const result = await createArxivConnector({ limits: { requestIntervalMs: 0 } }).run({
      source: source(),
      payload: { body, contentType: 'application/xml' },
      retrievedAt: RETRIEVED_AT,
    })
    expect(result.candidates).toHaveLength(2)
    expect(result.metrics.requests).toBe(0)
    expect(JSON.stringify(result)).not.toContain(body.toString())
  })

  it.each([
    [{ body: Buffer.alloc(0), contentType: 'application/xml' }, 'source_payload_rejected'],
    [{ body: '<feed/>', contentType: 'text/html' }, 'source_payload_rejected'],
    [{ body: '<!DOCTYPE feed><feed/>', contentType: 'application/xml' }, 'source_payload_rejected'],
  ])('fails closed for provider payload %j', async (payload, code) => {
    expect(() => parseArxiv(payload)).toThrow(expect.objectContaining({ code, retryable: false }))
  })

  it('maps timeout and unknown request errors and rejects invalid normalized IDs', async () => {
    await expect(createArxivConnector({ request: async () => { throw Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' }) } }).run({ source: source() })).rejects.toMatchObject({ code: 'source_fetch_timeout', retryable: true })
    await expect(createArxivConnector({ request: async () => { throw new Error('socket') } }).run({ source: source() })).rejects.toMatchObject({ code: 'source_fetch_failed', retryable: true })
    expect(normalizeArxivId('arXiv:2401.12345v2')).toEqual({ id: '2401.12345', version: 2 })
    expect(normalizeArxivId('2401.12345v0')).toBeUndefined()
  })

  it('aggregates a query batch with redacted per-source errors', async () => {
    const body = await fixture('page-2.xml')
    const request = vi.fn(async ({ query }) => query === 'bad'
      ? { statusCode: 503, body: Buffer.from('provider body') }
      : { statusCode: 200, body })
    const result = await createArxivConnector({ request, limits: { requestIntervalMs: 0, maxPages: 1, maxResults: 2 } }).runBatch({
      sources: [source(), source({ connectorConfig: { kind: 'arxiv', arxivQuery: 'bad', batchSize: 2 } })],
    })
    expect(result.candidates).toHaveLength(1)
    expect(result.errors).toEqual([{ code: 'source_upstream_status', retryable: true, upstreamStatus: 503 }])
    expect(JSON.stringify(result)).not.toMatch(/provider body|<feed/i)
  })

  it('treats large totalResults as query metadata while bounding pages and requiring forward progress', async () => {
    const pageOne = (await fixture('page-1.xml')).toString().replace('<opensearch:totalResults>3</opensearch:totalResults>', '<opensearch:totalResults>100001</opensearch:totalResults>')
    const pageTwo = (await fixture('page-2.xml')).toString().replace('<opensearch:totalResults>3</opensearch:totalResults>', '<opensearch:totalResults>100001</opensearch:totalResults>')
    const request = vi.fn()
      .mockResolvedValueOnce({ statusCode: 200, body: pageOne })
      .mockResolvedValueOnce({ statusCode: 200, body: pageTwo })
    const result = await createArxivConnector({ request, limits: { requestIntervalMs: 0, maxPages: 2, maxResults: 2 } }).run({ source: source() })
    expect(result.candidates).toHaveLength(3)
    expect(request.mock.calls.map(([input]) => input.start)).toEqual([0, 2])

    const repeatedPage = pageOne.replace('<opensearch:startIndex>0</opensearch:startIndex>', '<opensearch:startIndex>0</opensearch:startIndex>')
    const repeatedRequest = vi.fn(async () => ({ statusCode: 200, body: repeatedPage }))
    await expect(createArxivConnector({ request: repeatedRequest, limits: { requestIntervalMs: 0, maxPages: 3, maxResults: 2 } }).run({ source: source() })).rejects.toMatchObject({ code: 'source_payload_rejected', retryable: false })
    expect(repeatedRequest.mock.calls.map(([input]) => input.start)).toEqual([0, 2])
  })

  it('rejects unsafe or over-bound query metadata before pagination work', async () => {
    const body = (await fixture('page-1.xml')).toString()
    for (const totalResults of ['9007199254740992', '1000000001']) {
      const invalid = body.replace('<opensearch:totalResults>3</opensearch:totalResults>', `<opensearch:totalResults>${totalResults}</opensearch:totalResults>`)
      expect(() => parseArxiv({ body: invalid, contentType: 'application/xml' })).toThrow(expect.objectContaining({ code: 'source_payload_rejected', retryable: false }))
    }
  })
})
