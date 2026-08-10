export const ARXIV_CONTENT_TYPES = Object.freeze([
  'application/atom+xml',
  'application/xml',
  'text/xml',
])

export const ARXIV_API_URL = 'https://export.arxiv.org/api/query'

export const ARXIV_LIMITS = Object.freeze({
  maxPayloadBytes: 1 * 1024 * 1024,
  maxEntries: 100,
  maxPages: 100,
  maxResults: 100,
  maxFieldChars: 20_000,
  requestIntervalMs: 3_000,
})

export class ArxivConnectorError extends Error {
  constructor(code, message = 'arXiv source operation failed safely', { retryable = false, upstreamStatus } = {}) {
    super(message)
    this.name = 'ArxivConnectorError'
    this.code = code
    this.retryable = retryable
    if (Number.isInteger(upstreamStatus)) this.upstreamStatus = upstreamStatus
  }
}

export function sourcePayloadRejected() {
  return new ArxivConnectorError('source_payload_rejected')
}

export function sourceConfigRejected() {
  return new ArxivConnectorError('source_config_rejected')
}

export function sourceUpstreamStatus(status) {
  const retryable = status === 429 || status >= 500
  return new ArxivConnectorError('source_upstream_status', 'arXiv upstream status was mapped safely', { retryable, upstreamStatus: status })
}

export function sourceFetchTimeout() {
  return new ArxivConnectorError('source_fetch_timeout', 'arXiv request timed out safely', { retryable: true })
}

export function sourceFetchFailed() {
  return new ArxivConnectorError('source_fetch_failed', 'arXiv request failed safely', { retryable: true })
}

export function redactedArxivError(error) {
  if (!(error instanceof ArxivConnectorError)) return { code: 'source_fetch_failed', retryable: true }
  return {
    code: error.code,
    retryable: error.retryable,
    ...(Number.isInteger(error.upstreamStatus) ? { upstreamStatus: error.upstreamStatus } : {}),
  }
}
