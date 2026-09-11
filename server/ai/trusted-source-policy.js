const TRUSTED_SOURCE_PROFILES = Object.freeze({
  'rss:the-verge': Object.freeze({ connectorType: 'rss', accessMethod: 'rss', authorityTier: 'editorial' }),
  'arxiv:cs-ai': Object.freeze({ connectorType: 'arxiv', accessMethod: 'api', authorityTier: 'primary' }),
  'hn:topstories': Object.freeze({ connectorType: 'hacker-news', accessMethod: 'api', authorityTier: 'community-signal' }),
  'demo:rss-the-verge': Object.freeze({ connectorType: 'rss', accessMethod: 'rss', authorityTier: 'editorial' }),
  'demo:arxiv-cs-ai': Object.freeze({ connectorType: 'arxiv', accessMethod: 'api', authorityTier: 'primary' }),
  'demo:hn-topstories': Object.freeze({ connectorType: 'hacker-news', accessMethod: 'api', authorityTier: 'community-signal' }),
})

const TRUSTED_CONNECTOR_SOURCE_KEYS = Object.freeze(Object.keys(TRUSTED_SOURCE_PROFILES))
const TRUSTED_QNA_SOURCE_KEY_SET = new Set(['rss:the-verge', 'arxiv:cs-ai', 'demo:rss-the-verge', 'demo:arxiv-cs-ai'])

function sourceKeyOf(source) {
  return typeof source?.sourceKey === 'string' ? source.sourceKey : ''
}

function hasCanonicalProfile(source) {
  const profile = TRUSTED_SOURCE_PROFILES[sourceKeyOf(source)]
  return Boolean(profile) && profile.connectorType === source?.connectorType && profile.accessMethod === source?.accessMethod && profile.authorityTier === source?.authorityTier
}

export function isTrustedConnectorSource(source) {
  return hasCanonicalProfile(source)
}

export function canUseTrustedProviderInput(source, purpose) {
  return purpose === 'summary' && isTrustedConnectorSource(source)
}

export function canUseTrustedQnaInput(source) {
  return TRUSTED_QNA_SOURCE_KEY_SET.has(sourceKeyOf(source)) && isTrustedConnectorSource(source) && source?.authorityTier !== 'community-signal'
}

export { TRUSTED_CONNECTOR_SOURCE_KEYS }
