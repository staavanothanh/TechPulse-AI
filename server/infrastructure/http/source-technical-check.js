import { SafeFetchError } from './safe-fetch.js'

const XML_TYPES = Object.freeze(['application/rss+xml', 'application/atom+xml', 'application/xml', 'text/xml'])
const JSON_TYPES = Object.freeze(['application/json'])

function endpointFor(source) {
  if (source?.connectorType === 'rss' && source.connectorConfig?.kind === 'rss') return { url: source.connectorConfig.feedUrl, allowedContentTypes: XML_TYPES }
  if (source?.connectorType === 'arxiv' && source.connectorConfig?.kind === 'arxiv') {
    const url = new URL('https://export.arxiv.org/api/query')
    url.searchParams.set('search_query', source.connectorConfig.arxivQuery)
    url.searchParams.set('start', '0')
    url.searchParams.set('max_results', '1')
    return { url: url.href, allowedContentTypes: XML_TYPES }
  }
  if (source?.connectorType === 'hacker-news' && source.connectorConfig?.kind === 'hacker-news') {
    return { url: `https://hacker-news.firebaseio.com/v0/${source.connectorConfig.hackerNewsStream}.json`, allowedContentTypes: JSON_TYPES }
  }
  throw new Error('Source connector is invalid')
}

export function createSourceTechnicalCheckAdapter({ safeFetch, now = () => new Date() } = {}) {
  if (typeof safeFetch !== 'function') throw new Error('Safe fetch is required')
  return Object.freeze({
    async run({ source } = {}) {
      const checkedAt = now()
      try {
        const endpoint = endpointFor(source)
        const result = await safeFetch(endpoint.url, { allowedContentTypes: endpoint.allowedContentTypes })
        if (!Buffer.isBuffer(result.body) || result.body.length === 0) {
          return { status: 'failed', checkedAt, error: { code: 'source_empty_payload', message: 'Source returned an empty payload', retryable: false, occurredAt: checkedAt } }
        }
        return { status: 'passed', checkedAt, contentType: result.contentType, resolvedHost: result.resolvedHost, sampleCount: 1 }
      } catch (error) {
        const safe = error instanceof SafeFetchError
          ? error
          : new SafeFetchError('source_check_failed', 'Source technical check failed', { retryable: false })
        return {
          status: 'failed', checkedAt,
          error: {
            code: safe.code, message: 'Source technical check failed safely', retryable: safe.retryable,
            occurredAt: checkedAt, ...(Number.isInteger(safe.upstreamStatus) ? { upstreamStatus: safe.upstreamStatus } : {}),
          },
        }
      }
    },
  })
}
