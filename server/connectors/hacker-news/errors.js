export const HACKER_NEWS_STREAMS = Object.freeze(['topstories', 'newstories', 'beststories'])
export const HACKER_NEWS_API_BASE = 'https://hacker-news.firebaseio.com/v0'
export const HACKER_NEWS_LIMITS = Object.freeze({
  maxStreamIds: 500,
  maxBatchSize: 100,
  maxStreamBytes: 128 * 1024,
  maxFieldChars: 20_000,
  concurrency: 5,
})

export class HackerNewsConnectorError extends Error {
  constructor(code, message = 'Hacker News source operation failed safely', { retryable = false, upstreamStatus } = {}) {
    super(message)
    this.name = 'HackerNewsConnectorError'
    this.code = code
    this.retryable = retryable
    if (Number.isInteger(upstreamStatus)) this.upstreamStatus = upstreamStatus
  }
}

export function sourcePayloadRejected() {
  return new HackerNewsConnectorError('source_payload_rejected')
}

export function sourceConfigRejected() {
  return new HackerNewsConnectorError('source_config_rejected')
}

export function sourceUpstreamStatus(status) {
  const retryable = status === 429 || status >= 500
  return new HackerNewsConnectorError('source_upstream_status', 'Hacker News upstream status was mapped safely', { retryable, upstreamStatus: status })
}

export function sourceFetchTimeout() {
  return new HackerNewsConnectorError('source_fetch_timeout', 'Hacker News request timed out safely', { retryable: true })
}

export function sourceFetchFailed() {
  return new HackerNewsConnectorError('source_fetch_failed', 'Hacker News request failed safely', { retryable: true })
}
