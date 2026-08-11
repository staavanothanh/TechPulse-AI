import { describe, expect, it, vi } from 'vitest'
import { createConnectorRegistry, createDefaultConnectorRegistry } from '../../../server/connectors/registry.js'
import { makeSource } from './fixtures.js'

function fakeConnector(name, connectorType = name) {
  return { name, connectorType, run: vi.fn() }
}

describe('Step 7 connector registry', () => {
  it('registers exactly rss, arxiv and hacker-news and resolves by validated source discriminant', () => {
    const registry = createConnectorRegistry({ connectors: [fakeConnector('rss'), fakeConnector('arxiv'), fakeConnector('hacker-news')] })

    expect(registry.registered().map(({ connectorType }) => connectorType)).toEqual(['rss', 'arxiv', 'hacker-news'])
    expect(registry.resolve(makeSource()).name).toBe('rss')
    expect(registry.resolve(makeSource({ connectorType: 'arxiv', accessMethod: 'api', authorityTier: 'primary', connectorConfig: { kind: 'arxiv', arxivQuery: 'cat:cs.AI', batchSize: 20 } })).name).toBe('arxiv')
    expect(registry.resolve(makeSource({ connectorType: 'hacker-news', accessMethod: 'api', authorityTier: 'community-signal', connectorConfig: { kind: 'hacker-news', hackerNewsStream: 'topstories', batchSize: 20 } })).name).toBe('hacker-news')
  })

  it('fails closed for duplicate or mismatched connector registration', () => {
    const registry = createConnectorRegistry({ connectors: [fakeConnector('rss')] })
    expect(() => registry.register(fakeConnector('rss'))).toThrow(/already/i)
    expect(() => registry.resolve(makeSource({ connectorType: 'arxiv' }))).toThrow(/connector/i)
    expect(() => createConnectorRegistry({ connectors: [fakeConnector('rss', 'arxiv')] })).toThrow(/connector/i)
  })

  it('exposes a provider-free default registry without fetching or persisting source payloads', () => {
    const registry = createDefaultConnectorRegistry()
    expect(registry.registered().map(({ connectorType }) => connectorType)).toEqual(['rss', 'arxiv', 'hacker-news'])
    expect(registry.get('rss')).toMatchObject({ connectorType: 'rss' })
    expect(registry.get('arxiv')).toMatchObject({ connectorType: 'arxiv' })
    expect(registry.get('hacker-news')).toMatchObject({ connectorType: 'hacker-news' })
  })
})
