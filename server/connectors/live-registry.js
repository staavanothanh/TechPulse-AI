import { createArxivConnector } from './arxiv/index.js'
import { ARXIV_CONTENT_TYPES } from './arxiv/errors.js'
import { createHackerNewsConnector } from './hacker-news/index.js'
import { createRssConnector } from './rss/index.js'
import { RSS_CONTENT_TYPES } from './rss/errors.js'
import { createConnectorRegistry } from './registry.js'
import { createSafeFetch } from '../infrastructure/http/safe-fetch.js'

function requireSafeFetch(safeFetch) {
  if (typeof safeFetch !== 'function') throw new Error('Safe fetch is required')
  return safeFetch
}

function liveConnector(connector, { fetchPayload, safeFetch } = {}) {
  return {
    ...connector,
    async run(input = {}) {
      const requestInput =
        typeof fetchPayload === 'function' ? await fetchPayload(input, safeFetch) : input
      return connector.run(requestInput)
    },
  }
}

async function fetchRssPayload(input, safeFetch) {
  if (input?.payload !== undefined) return input
  const response = await safeFetch(input?.source?.connectorConfig?.feedUrl, {
    allowedContentTypes: RSS_CONTENT_TYPES,
  })
  return { ...input, payload: response }
}

export function createLiveConnectorRegistry({
  safeFetch = createSafeFetch(),
  now = () => new Date(),
} = {}) {
  const fetch = requireSafeFetch(safeFetch)
  const rss = liveConnector(createRssConnector({ now }), {
    fetchPayload: fetchRssPayload,
    safeFetch: fetch,
  })
  const arxiv = createArxivConnector({
    now,
    request: async ({ url }) => fetch(url, { allowedContentTypes: ARXIV_CONTENT_TYPES }),
  })
  const hackerNews = createHackerNewsConnector({
    now,
    request: async ({ url }) => fetch(url, { allowedContentTypes: ['application/json'] }),
  })
  return createConnectorRegistry({ connectors: [rss, arxiv, hackerNews] })
}
