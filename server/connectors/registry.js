import { createArxivConnector } from './arxiv/index.js'
import { createHackerNewsConnector } from './hacker-news/index.js'
import { createRssConnector } from './rss/index.js'
import { validateConnectorUnit } from '../domain/source/validation.js'

export const CONNECTOR_TYPES = Object.freeze(['rss', 'arxiv', 'hacker-news'])

function assertConnector(connector) {
  if (!connector || typeof connector !== 'object' || !CONNECTOR_TYPES.includes(connector.connectorType) || connector.name !== connector.connectorType || typeof connector.run !== 'function') throw new Error('Connector registration is invalid')
  return connector
}

export function createConnectorRegistry({ connectors = [] } = {}) {
  const registered = new Map()
  for (const connector of connectors) {
    const value = assertConnector(connector)
    if (registered.has(value.connectorType)) throw new Error('Connector is already registered')
    registered.set(value.connectorType, value)
  }
  return Object.freeze({
    register(connector) {
      const value = assertConnector(connector)
      if (registered.has(value.connectorType)) throw new Error('Connector is already registered')
      registered.set(value.connectorType, value)
      return value
    },
    get(connectorType) { return registered.get(connectorType) },
    resolve(source) {
      validateConnectorUnit(source)
      const connector = registered.get(source.connectorType)
      if (!connector || connector.accessMethods && !connector.accessMethods.includes(source.accessMethod)) throw new Error('Connector is not available for source')
      return connector
    },
    registered() { return CONNECTOR_TYPES.filter((type) => registered.has(type)).map((type) => registered.get(type)) },
    get size() { return registered.size },
  })
}

export function createDefaultConnectorRegistry({ rss, arxiv, hackerNews } = {}) {
  return createConnectorRegistry({ connectors: [
    rss ?? createRssConnector(),
    arxiv ?? createArxivConnector(),
    hackerNews ?? createHackerNewsConnector(),
  ] })
}

export const createConnectorRegistryWithDefaults = createDefaultConnectorRegistry
