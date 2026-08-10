import { normalizeArxivEntry, validateArxivSource } from './normalizer.js'
import { ARXIV_API_URL, ARXIV_CONTENT_TYPES, ARXIV_LIMITS, ArxivConnectorError, redactedArxivError, sourceConfigRejected, sourceFetchFailed, sourceFetchTimeout, sourcePayloadRejected, sourceUpstreamStatus } from './errors.js'
import { boundedLimits, normalizeArxivId, parseArxivPage } from './parser.js'

function retrievalDate(value, now) {
  const candidate = value === undefined ? now() : value
  const date = new Date(candidate)
  if (Number.isNaN(date.getTime())) throw sourceConfigRejected()
  return date
}

function normalizeRequestError(error) {
  if (error instanceof ArxivConnectorError) return error
  if (error?.code === 'source_fetch_timeout' || error?.code === 'ETIMEDOUT' || error?.name === 'AbortError') return sourceFetchTimeout()
  if (Number.isInteger(error?.statusCode) || Number.isInteger(error?.status)) return sourceUpstreamStatus(Number(error.statusCode ?? error.status))
  return sourceFetchFailed()
}

function endpointUrl(query, start, maxResults) {
  const url = new URL(ARXIV_API_URL)
  url.searchParams.set('search_query', query)
  url.searchParams.set('start', String(start))
  url.searchParams.set('max_results', String(maxResults))
  return url.href
}

function defaultSleep(delayMs) {
  return new Promise((resolve) => setTimeout(resolve, delayMs))
}

export function createArxivConnector({ now = () => new Date(), request, sleep = defaultSleep, limits: configuredLimits } = {}) {
  const limits = boundedLimits(configuredLimits)
  if (request !== undefined && typeof request !== 'function') throw sourceConfigRejected()
  if (typeof sleep !== 'function') throw sourceConfigRejected()

  async function fetchPage({ source, query, start, maxResults, pageIndex, payload }) {
    if (payload !== undefined) return parseArxivPage(payload, limits)
    if (typeof request !== 'function') throw sourceConfigRejected()
    const url = endpointUrl(query, start, maxResults)
    let response
    try {
      response = await request({ url, query, start, maxResults, page: pageIndex, source })
    } catch (error) {
      throw normalizeRequestError(error)
    }
    return parseArxivPage(response, limits)
  }

  async function run({ source, payload, pages, responses, query: configuredQuery, retrievedAt, maxResults: configuredMaxResults, maxPages: configuredMaxPages } = {}) {
    const observedAt = retrievalDate(retrievedAt, now)
    const query = validateArxivSource(source, configuredQuery ?? source?.connectorConfig?.arxivQuery)
    const maxResults = configuredMaxResults ?? source?.connectorConfig?.batchSize ?? 20
    if (!Number.isInteger(maxResults) || maxResults < 1 || maxResults > limits.maxResults) throw sourceConfigRejected()
    const maxPages = configuredMaxPages ?? limits.maxPages
    if (!Number.isInteger(maxPages) || maxPages < 1 || maxPages > limits.maxPages) throw sourceConfigRejected()
    const pageInputs = Array.isArray(pages) ? pages : Array.isArray(responses) ? responses : undefined
    const staticPayload = payload !== undefined && pageInputs === undefined
    const candidates = []
    const metrics = { pagesFetched: 0, entriesSeen: 0, candidatesAccepted: 0, invalidEntries: 0, requests: 0, retryableErrors: 0 }
    let start = 0
    let previousStart = -1
    let totalResults = Number.POSITIVE_INFINITY
    for (let pageIndex = 0; pageIndex < maxPages && start < totalResults && candidates.length < limits.maxEntries; pageIndex += 1) {
      if (pageIndex > 0 && limits.requestIntervalMs > 0) await sleep(limits.requestIntervalMs)
      const pagePayload = pageInputs ? pageInputs[pageIndex] : pageIndex === 0 && payload !== undefined ? payload : undefined
      if (pageInputs && pagePayload === undefined) break
      const page = await fetchPage({ source, query, start, maxResults, pageIndex, payload: pagePayload })
      metrics.pagesFetched += 1
      if (!pageInputs && !staticPayload) metrics.requests += 1
      if ((pageIndex > 0 && page.startIndex !== start) || page.startIndex <= previousStart) throw sourcePayloadRejected()
      const nextStart = page.startIndex + page.entries.length
      if (!Number.isSafeInteger(nextStart)) throw sourcePayloadRejected()
      if (page.entries.length === 0 && page.startIndex < page.totalResults) throw sourcePayloadRejected()
      if (page.entries.length > 0 && page.startIndex >= page.totalResults) throw sourcePayloadRejected()
      metrics.entriesSeen += page.entries.length
      totalResults = page.totalResults
      for (const entry of page.entries) {
        if (candidates.length >= limits.maxEntries) break
        const candidate = normalizeArxivEntry(entry, { source, retrievedAt: observedAt, limits })
        if (!candidate) {
          metrics.invalidEntries += 1
          continue
        }
        candidates.push(candidate)
        metrics.candidatesAccepted += 1
      }
      previousStart = page.startIndex
      if (staticPayload || page.entries.length === 0 || nextStart >= totalResults) break
      start = nextStart
    }
    return Object.freeze({ candidates: Object.freeze(candidates), retrievedAt: observedAt, query, metrics: Object.freeze(metrics) })
  }

  async function runBatch({ sources, queries, retrievedAt } = {}) {
    const inputs = Array.isArray(sources) ? sources : Array.isArray(queries) ? queries.map((arxivQuery) => ({ connectorConfig: { kind: 'arxiv', arxivQuery }, connectorType: 'arxiv', accessMethod: 'api', authorityTier: 'primary' })) : []
    if (inputs.length === 0) throw sourceConfigRejected()
    const candidates = []
    const errors = []
    const metrics = { batches: inputs.length, succeeded: 0, failed: 0 }
    for (const source of inputs) {
      try {
        const result = await run({ source, retrievedAt })
        candidates.push(...result.candidates)
        metrics.succeeded += 1
      } catch (error) {
        metrics.failed += 1
        errors.push(redactedArxivError(error))
      }
    }
    return Object.freeze({ candidates: Object.freeze(candidates), errors: Object.freeze(errors), metrics: Object.freeze(metrics) })
  }

  return Object.freeze({
    name: 'arxiv',
    connectorType: 'arxiv',
    accessMethods: Object.freeze(['api']),
    run,
    runBatch,
    parse: (payload, options) => parseArxivPage(payload, { ...limits, ...options?.limits }),
    request,
    limits,
  })
}

export const createArXivConnector = createArxivConnector
export const parseArxiv = parseArxivPage
export const normalizeArxiv = normalizeArxivEntry
export { normalizeArxivEntry, normalizeArxivId, parseArxivPage, ARXIV_API_URL, ARXIV_CONTENT_TYPES, ARXIV_LIMITS, ArxivConnectorError }
