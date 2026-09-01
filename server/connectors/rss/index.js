import { normalizeRssAtom } from './normalizer.js'
import { parseRssAtom } from './parser.js'
import { RSS_CONTENT_TYPES, RSS_LIMITS, RssConnectorError, redactedConnectorError, sourceConfigRejected } from './errors.js'

function retrievalDate(value, now) {
  const candidate = value === undefined ? now() : value
  const date = candidate instanceof Date ? new Date(candidate) : new Date(candidate)
  if (Number.isNaN(date.getTime())) throw new RssConnectorError('source_config_rejected', 'RSS/Atom retrieval timestamp is invalid')
  return date
}
function maxResultsFor(source, requested, limits) {
  const value = requested ?? source?.connectorConfig?.batchSize ?? RSS_LIMITS.maxItems
  const configuredMaxItems = limits?.maxItems ?? RSS_LIMITS.maxItems
  if (!Number.isInteger(value) || value < 1 || value > RSS_LIMITS.maxItems) throw sourceConfigRejected()
  if (!Number.isInteger(configuredMaxItems) || configuredMaxItems < 1 || configuredMaxItems > RSS_LIMITS.maxItems) throw sourceConfigRejected()
  return Math.min(value, configuredMaxItems)
}

function normalizeError(error) {
  if (error instanceof RssConnectorError) return error
  if (error?.code === 'ingestion_deadline_exceeded' || error?.code === 'lease_heartbeat_lost') return error
  return new RssConnectorError('source_payload_rejected')
}

function emitStage(onStage, event) {
  if (typeof onStage === 'function') onStage(Object.freeze({ ...event }))
}

/**
 * Create the provider-free RSS/Atom connector.
 *
 * The connector consumes an already bounded safe-fetch payload. It never
 * performs DNS, HTTP, media, article, AI, or persistence work.
 */
export function createRssConnector({ now = () => new Date(), parser, limits, request, workerDelayMs } = {}) {
  async function run({ source, payload, response, body, contentType, contentEncoding, url, retrievedAt, maxResults, signal, deadline, onStage } = {}) {
    const observedAt = retrievalDate(retrievedAt, now)
    let activeStage = 'rss_parse'
    try {
      const boundedMaxResults = maxResultsFor(source, maxResults, limits)
      const input = payload ?? response ?? (body === undefined ? undefined : { body, contentType, contentEncoding, url })
      emitStage(onStage, { stage: activeStage, status: 'started' })
      const parsed = await parseRssAtom(input, { parser, limits: { ...limits, maxItems: boundedMaxResults }, workerDelayMs, signal, deadline })
      if (signal?.aborted) throw signal.reason
      emitStage(onStage, { stage: activeStage, status: 'succeeded', counters: { fetched: parsed.nodes?.length ?? 0 } })
      activeStage = 'rss_normalize'
      emitStage(onStage, { stage: activeStage, status: 'started', batchSize: boundedMaxResults })
      const result = normalizeRssAtom({ parsed, source, retrievedAt: observedAt, maxResults: boundedMaxResults })
      if (signal?.aborted) throw signal.reason
      emitStage(onStage, { stage: activeStage, status: 'succeeded', counters: { fetched: result.candidates.length } })
      return result
    } catch (error) {
      emitStage(onStage, { stage: activeStage, status: error?.code === 'ingestion_deadline_exceeded' ? 'timeout' : 'failed', error })
      throw normalizeError(error)
    }
  }

  async function runBatch({ source, payloads, maxResults, signal, deadline, onStage } = {}) {
    if (!Array.isArray(payloads)) throw new RssConnectorError('source_payload_rejected')
    const candidates = []
    const errors = []
    for (const payload of payloads) {
      if (signal?.aborted) throw signal.reason
      try {
        const result = await run({ source, payload, maxResults, signal, deadline, onStage })
        candidates.push(...result.candidates)
      } catch (error) {
        if (signal?.aborted) throw signal.reason ?? error
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
