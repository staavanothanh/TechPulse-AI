const TRUSTED_CONNECTOR_SOURCE_KEYS = Object.freeze([
  'rss:the-verge',
  'arxiv:cs-ai',
  'hn:topstories',
  'demo:rss-the-verge',
  'demo:arxiv-cs-ai',
  'demo:hn-topstories',
])

const TRUSTED_SOURCE_KEY_SET = new Set(TRUSTED_CONNECTOR_SOURCE_KEYS)
const TRUSTED_QNA_SOURCE_KEY_SET = new Set(['rss:the-verge', 'arxiv:cs-ai', 'demo:rss-the-verge', 'demo:arxiv-cs-ai'])

function sourceKeyOf(source) {
  return typeof source?.sourceKey === 'string' ? source.sourceKey : ''
}

export function isTrustedConnectorSource(source) {
  return TRUSTED_SOURCE_KEY_SET.has(sourceKeyOf(source))
}

export function canUseTrustedProviderInput(source, purpose) {
  return isTrustedConnectorSource(source) && purpose === 'summary'
}

export function canUseTrustedQnaInput(source) {
  return TRUSTED_QNA_SOURCE_KEY_SET.has(sourceKeyOf(source)) && source?.authorityTier !== 'community-signal'
}

export { TRUSTED_CONNECTOR_SOURCE_KEYS }
