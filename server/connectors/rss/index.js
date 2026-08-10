import { normalizeRssAtom } from './normalizer.js'
import { parseRssAtom } from './parser.js'
import { RSS_CONTENT_TYPES, RSS_LIMITS, RssConnectorError, redactedConnectorError } from './errors.js'

function retrievalDate(value, now) {
  const candidate = value === undefined ? now() : value
  const date = candidate instanceof Date ? new Date(candidate) : new Date(candidate)
  if (Number.isNaN(date.getTime())) throw new RssConnectorError('source_config_rejected', 'RSS/Atom retrieval timestamp is invalid')
  return date
}

function normalizeError(error) {
  if (error instanceof RssConnectorError) return error
  return new RssConnectorError('source_payload_rejected')
}

/**
 * Create the provider-free RSS/Atom connector.
 *
 * The connector consumes an already bounded safe-fetch payload. It never
 * performs DNS, HTTP, media, article, AI, or persistence work.
 */
export function createRssConnector({ now = () => new Date(), parser, limits, request, workerDelayMs } = {}) {
  async function run({ source, payload, response, body, contentType, contentEncoding, url, retrievedAt } = {}) {
    const observedAt = retrievalDate(retrievedAt, now)
    try {
      const input = payload ?? response ?? (body === undefined ? undefined : { body, contentType, contentEncoding, url })
      const parsed = await parseRssAtom(input, { parser, limits, workerDelayMs })
      return normalizeRssAtom({ parsed, source, retrievedAt: observedAt })
    } catch (error) {
      throw normalizeError(error)
    }
  }

  async function runBatch({ source, payloads } = {}) {
    if (!Array.isArray(payloads)) throw new RssConnectorError('source_payload_rejected')
    const candidates = []
    const errors = []
    for (const payload of payloads) {
      try {
        const result = await run({ source, payload })
        candidates.push(...result.candidates)
      } catch (error) {
        const safe = redactedConnectorError(normalizeError(error))
        errors.push(safe)
      }
    }
    return Object.freeze({ candidates: Object.freeze(candidates), errors: Object.freeze(errors) })
  }

  return Object.freeze({
    name: 'rss',
    connectorType: 'rss',
    accessMethods: Object.freeze(['rss', 'atom']),
    contentTypes: RSS_CONTENT_TYPES,
    limits: RSS_LIMITS,
    parse: (payload, options) => parseRssAtom(payload, {
      ...options,
      limits: options?.limits ?? limits,
      parser: options?.parser ?? parser,
      workerDelayMs: options?.workerDelayMs ?? workerDelayMs,
    }),
    run,
    runBatch,
    request,
  })
}

export const createRssAtomConnector = createRssConnector
export const parseFeed = parseRssAtom
export { normalizeRssAtom, parseRssAtom, RSS_CONTENT_TYPES, RSS_LIMITS, RssConnectorError }
