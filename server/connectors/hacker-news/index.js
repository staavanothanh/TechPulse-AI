import { HACKER_NEWS_API_BASE, HACKER_NEWS_LIMITS, HACKER_NEWS_STREAMS, HackerNewsConnectorError, sourceConfigRejected, sourceFetchFailed, sourceFetchTimeout, sourcePayloadRejected, sourceUpstreamStatus } from './errors.js'
import { parseIdList, parseItem, responseStatus } from './parser.js'
import { normalizeHackerNewsItem, validateHackerNewsSource } from './normalizer.js'

function retrievalDate(value, now) {
  const date = new Date(value === undefined ? now() : value)
  if (Number.isNaN(date.getTime())) throw sourceConfigRejected()
  return date
}

function normalizeRequestError(error) {
  if (error instanceof HackerNewsConnectorError) return error
  if (error?.code === 'source_fetch_timeout' || error?.code === 'ETIMEDOUT' || error?.name === 'AbortError') return sourceFetchTimeout()
  if (Number.isInteger(error?.statusCode) || Number.isInteger(error?.status)) return sourceUpstreamStatus(Number(error.statusCode ?? error.status))
  return sourceFetchFailed()
}

function boundedLimits(overrides = {}) {
  const result = {}
  for (const key of Object.keys(HACKER_NEWS_LIMITS)) {
    const value = overrides[key] ?? HACKER_NEWS_LIMITS[key]
    if (!Number.isInteger(value) || value < 1 || value > HACKER_NEWS_LIMITS[key]) throw sourceConfigRejected()
    result[key] = value
  }
  return Object.freeze(result)
}

function endpointUrl(stream, id) {
  return id === undefined ? `${HACKER_NEWS_API_BASE}/${stream}.json` : `${HACKER_NEWS_API_BASE}/item/${encodeURIComponent(String(id))}.json`
}

async function mapWithConcurrency(values, concurrency, worker) {
  const results = new Array(values.length)
  let cursor = 0
  async function consume() {
    while (cursor < values.length) {
      const index = cursor
      cursor += 1
      results[index] = await worker(values[index], index)
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, values.length) }, consume))
  return results
}

export function createHackerNewsConnector({ now = () => new Date(), request, concurrency: configuredConcurrency, limits: configuredLimits } = {}) {
  const limits = boundedLimits(configuredLimits)
  const concurrency = configuredConcurrency ?? limits.concurrency
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > limits.concurrency) throw sourceConfigRejected()
  if (request !== undefined && typeof request !== 'function') throw sourceConfigRejected()

  async function requestPayload({ source, stream, id, payload }) {
    if (payload !== undefined) return payload
    if (typeof request !== 'function') throw sourceConfigRejected()
    try {
      return await request({ url: endpointUrl(stream, id), kind: id === undefined ? 'stream' : 'item', stream, id, source })
    } catch (error) {
      throw normalizeRequestError(error)
    }
  }

  async function run({ source, payload, ids, itemPayloads, items, retrievedAt, stream: configuredStream } = {}) {
    const observedAt = retrievalDate(retrievedAt, now)
    const stream = validateHackerNewsSource(source, configuredStream ?? source?.connectorConfig?.hackerNewsStream)
    const batchSize = source?.connectorConfig?.batchSize ?? limits.maxBatchSize
    if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > limits.maxBatchSize) throw sourceConfigRejected()
    const metrics = { streamRequests: 0, itemRequests: 0, candidatesAccepted: 0, deletedItems: 0, missingItems: 0, invalidItems: 0, maxConcurrent: 0 }
    const inlineIds = Array.isArray(payload?.ids) ? payload.ids : undefined
    const idPayload = ids ?? inlineIds ?? await requestPayload({ source, stream, payload: payload?.ids === undefined ? payload : payload.ids })
    if (ids === undefined && inlineIds === undefined && payload === undefined) metrics.streamRequests += 1
    let storyIds
    try { storyIds = parseIdList(idPayload, limits) } catch (error) { throw error instanceof HackerNewsConnectorError ? error : sourcePayloadRejected() }
    const boundedIds = storyIds.slice(0, batchSize)
    let active = 0
    const itemResults = await mapWithConcurrency(boundedIds, concurrency, async (id, index) => {
      const numericId = Number(id)
      if (!Number.isSafeInteger(numericId) || numericId < 1) {
        metrics.invalidItems += 1
        return undefined
      }
      metrics.itemRequests += 1
      const inlineItems = items ?? payload?.items
      const providedPayload = Array.isArray(itemPayloads)
        ? itemPayloads[index]
        : inlineItems && typeof inlineItems === 'object'
          ? inlineItems[String(numericId)]
          : undefined
      active += 1
      metrics.maxConcurrent = Math.max(metrics.maxConcurrent, active)
      try {
        let itemPayload
        try {
          itemPayload = await requestPayload({ source, stream, id: numericId, payload: providedPayload })
        } catch (error) {
          if (error instanceof HackerNewsConnectorError && error.code === 'source_upstream_status' && error.upstreamStatus === 404) {
            metrics.missingItems += 1
            return undefined
          }
          throw error
        }
        const status = responseStatus(itemPayload)
        if (status === 404) {
          metrics.missingItems += 1
          return undefined
        }
        let item
        try { item = parseItem(itemPayload, limits) } catch (error) { throw error instanceof HackerNewsConnectorError ? error : sourcePayloadRejected() }
        if (item === null || item === undefined) {
          metrics.missingItems += 1
          return undefined
        }
        if (item.deleted === true || item.dead === true) {
          metrics.deletedItems += 1
          return undefined
        }
        const candidate = normalizeHackerNewsItem(item, { source, retrievedAt: observedAt, maxFieldChars: limits.maxFieldChars })
        if (!candidate) metrics.invalidItems += 1
        return candidate
      } catch (error) {
        if (error instanceof HackerNewsConnectorError && error.code === 'source_payload_rejected') {
          metrics.invalidItems += 1
          return undefined
        }
        throw error
      } finally {
        active -= 1
      }
    })
    const candidates = itemResults.filter(Boolean)
    metrics.candidatesAccepted = candidates.length
    return Object.freeze({ stream, candidates: Object.freeze(candidates), retrievedAt: observedAt, metrics: Object.freeze(metrics) })
  }

  return Object.freeze({
    name: 'hacker-news',
    connectorType: 'hacker-news',
    accessMethods: Object.freeze(['api']),
    streams: HACKER_NEWS_STREAMS,
    run,
    parse: (payload) => parseIdList(payload, limits),
    request,
    limits,
  })
}

export const createHnConnector = createHackerNewsConnector
export const parseHn = parseIdList
export const normalizeHnItem = normalizeHackerNewsItem
export { HACKER_NEWS_API_BASE, HACKER_NEWS_LIMITS, HACKER_NEWS_STREAMS, HackerNewsConnectorError, normalizeHackerNewsItem }
