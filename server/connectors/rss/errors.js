export const RSS_CONTENT_TYPES = Object.freeze([
  'application/rss+xml',
  'application/atom+xml',
  'application/xml',
  'text/xml',
])

export const RSS_LIMITS = Object.freeze({
  maxPayloadBytes: 4 * 1024 * 1024,
  maxDepth: 64,
  maxNodes: 20_000,
  maxItems: 100,
  maxFieldChars: 20_000,
  parseDeadlineMs: 2_000,
})

export class RssConnectorError extends Error {
  constructor(code, message = 'RSS/Atom source payload was rejected', { retryable = false } = {}) {
    super(message)
    this.name = 'RssConnectorError'
    this.code = code
    this.retryable = retryable
  }
}

export function sourcePayloadRejected() {
  return new RssConnectorError('source_payload_rejected')
}

export function sourceConfigRejected() {
  return new RssConnectorError('source_config_rejected', 'RSS/Atom source configuration was rejected')
}

export function redactedConnectorError(error) {
  if (error instanceof RssConnectorError) return { code: error.code, retryable: error.retryable }
  return { code: 'source_payload_rejected', retryable: false }
}
