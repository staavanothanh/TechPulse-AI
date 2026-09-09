const TRUSTED_CONNECTOR_SOURCE_KEYS = Object.freeze([
  'rss:the-verge',
  'rss:ars-technica',
  'rss:deepmind-blog',
  'rss:openai-news',
  'rss:huggingface-blog',
  'arxiv:cs-ai',
  'hn:topstories',
  'demo:rss-the-verge',
  'demo:arxiv-cs-ai',
  'demo:hn-topstories',
])

const TRUSTED_SOURCE_KEY_SET = new Set(TRUSTED_CONNECTOR_SOURCE_KEYS)
const TRUSTED_QNA_SOURCE_KEY_SET = new Set([
  'rss:the-verge',
  'rss:ars-technica',
  'rss:deepmind-blog',
  'rss:openai-news',
  'rss:huggingface-blog',
  'arxiv:cs-ai',
  'demo:rss-the-verge',
  'demo:arxiv-cs-ai',
])

const SUPPORTED_CONNECTOR_TYPES = new Set(['rss', 'arxiv', 'hacker-news', 'hn'])

function sourceKeyOf(source) {
  return typeof source?.sourceKey === 'string' ? source.sourceKey : ''
}

function connectorTypeOf(source) {
  return source?.connectorType || source?.connectorConfig?.kind || ''
}

export function isTrustedConnectorSource(source) {
  const key = sourceKeyOf(source)
  if (key && TRUSTED_SOURCE_KEY_SET.has(key)) return true
  const connector = connectorTypeOf(source)
  if (connector && SUPPORTED_CONNECTOR_TYPES.has(connector)) {
    return key.startsWith('rss:') || key.startsWith('arxiv:') || key.startsWith('hn:') || key.startsWith('demo:')
  }
  return false
}

export function canUseTrustedProviderInput(source, purpose) {
  return isTrustedConnectorSource(source) && purpose === 'summary'
}

export function canUseTrustedQnaInput(source) {
  if (source?.authorityTier === 'community-signal') return false
  const key = sourceKeyOf(source)
  if (key && TRUSTED_QNA_SOURCE_KEY_SET.has(key)) return true
  const connector = connectorTypeOf(source)
  return Boolean(connector && ['rss', 'arxiv'].includes(connector))
}

export { TRUSTED_CONNECTOR_SOURCE_KEYS }
