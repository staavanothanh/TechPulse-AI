import {
  TOPIC_CATALOG,
  resolveTopic,
  topicLabel as catalogTopicLabel,
  topicOptions,
} from '../../../../shared/topic-catalog.js'

export const TOPICS = topicOptions({ kind: 'parent', status: 'active', locale: 'vi' })

export const TOPIC_OPTIONS = Object.freeze(
  TOPIC_CATALOG
    .filter((item) => item.status === 'active')
    .slice()
    .sort((left, right) => left.displayOrder - right.displayOrder)
    .map((item) => Object.freeze({ value: item.id, label: catalogTopicLabel(item.id, 'vi') })),
)

export function normalizeTopicFilter(value) {
  if (typeof value !== 'string') return ''
  const trimmed = value.trim()
  if (!trimmed) return ''
  return resolveTopic(trimmed).canonicalId || trimmed
}

export function topicLabel(topic) {
  return catalogTopicLabel(topic, 'vi')
}

export const EMPTY_FILTERS = Object.freeze({
  topic: '',
  sourceId: '',
  publishedAfter: '',
  publishedBefore: '',
})

export function sourceName(article) {
  return article?.source?.name || article?.sourceName || article?.sourceId || 'Nguồn chưa xác định'
}

export function sourceDomain(article) {
  return article?.source?.domain || article?.sourceDomain || ''
}

export function articleTitle(article) {
  return article?.titleVi || article?.titleOriginal || 'Bài viết không có tiêu đề'
}

export function formatDate(value) {
  if (!value) return ''
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return ''
  return new Intl.DateTimeFormat('vi-VN', { dateStyle: 'medium' }).format(date)
}

export const CONNECTOR_LABELS = Object.freeze({
  rss: 'RSS Feeds',
  arxiv: 'arXiv',
  'hacker-news': 'Hacker News',
})

export const SOURCE_CATALOG = Object.freeze([
  Object.freeze({
    id: 'c0a5a4bc55919ea3955375b1',
    sourceKey: 'rss:the-verge',
    name: 'The Verge Technology',
    connectorType: 'rss',
  }),
  Object.freeze({
    id: '57654fbdfd53bf89dcc92ff3',
    sourceKey: 'rss:ars-technica',
    name: 'Ars Technica',
    connectorType: 'rss',
  }),
  Object.freeze({
    id: 'af7ab17090f87e47197f48b5',
    sourceKey: 'rss:deepmind-blog',
    name: 'Google DeepMind Blog',
    connectorType: 'rss',
  }),
  Object.freeze({
    id: 'd05b6d8be6b254b899fbefae',
    sourceKey: 'rss:openai-news',
    name: 'OpenAI News',
    connectorType: 'rss',
  }),
  Object.freeze({
    id: '2dc0f5cf717a0e77e3eee6ff',
    sourceKey: 'rss:huggingface-blog',
    name: 'Hugging Face Blog',
    connectorType: 'rss',
  }),
  Object.freeze({
    id: '407bf4b737898beeb84f4026',
    sourceKey: 'demo:rss-the-verge',
    name: 'The Verge Technology (live demo)',
    connectorType: 'rss',
  }),
  Object.freeze({
    id: '4ca3339c26a215647d04ccfb',
    sourceKey: 'arxiv:cs-ai',
    name: 'arXiv Computer Science AI',
    connectorType: 'arxiv',
  }),
  Object.freeze({
    id: '3c15995de36ca3f9d7354c29',
    sourceKey: 'demo:arxiv-cs-ai',
    name: 'arXiv Computer Science AI (live demo)',
    connectorType: 'arxiv',
  }),
  Object.freeze({
    id: 'b2b739bcb672bde81990c1a2',
    sourceKey: 'hn:topstories',
    name: 'Hacker News Top Stories',
    connectorType: 'hacker-news',
  }),
  Object.freeze({
    id: '6e22f866d3712afcaa2d2a7e',
    sourceKey: 'demo:hn-topstories',
    name: 'Hacker News Top Stories (live demo)',
    connectorType: 'hacker-news',
  }),
])

export function resolveSourceConnector(source) {
  if (!source) return 'other'
  const rawType = source.connectorType || source.connector || source.type
  if (rawType && (rawType === 'rss' || rawType === 'arxiv' || rawType === 'hacker-news')) return rawType
  if (rawType === 'hn') return 'hacker-news'
  const idOrKey = String(source.id || source.sourceKey || source.sourceId || '')
  const name = String(source.name || source.sourceName || '')
  if (idOrKey.startsWith('rss:') || idOrKey.startsWith('demo:rss-') || /verge|ars\s*technica|deepmind|openai|hugging\s*face/i.test(name)) return 'rss'
  if (idOrKey.startsWith('arxiv:') || idOrKey.startsWith('demo:arxiv-') || /arxiv/i.test(name)) return 'arxiv'
  if (idOrKey.startsWith('hn:') || idOrKey.startsWith('demo:hn-') || /hacker\s*news/i.test(name)) return 'hacker-news'
  const catalogEntry = SOURCE_CATALOG.find((item) => item.id === idOrKey || item.sourceKey === idOrKey)
  if (catalogEntry) return catalogEntry.connectorType
  return 'other'
}

export function groupSourcesByConnector(sourceItems = []) {
  const groups = [
    { key: 'rss', label: CONNECTOR_LABELS.rss, items: [] },
    { key: 'arxiv', label: CONNECTOR_LABELS.arxiv, items: [] },
    { key: 'hacker-news', label: CONNECTOR_LABELS['hacker-news'], items: [] },
  ]
  const other = { key: 'other', label: 'Nguồn khác', items: [] }

  for (const source of sourceItems) {
    const connector = resolveSourceConnector(source)
    const target = groups.find((g) => g.key === connector)
    if (target) {
      target.items.push(source)
    } else {
      other.items.push(source)
    }
  }

  const result = groups.filter((g) => g.items.length > 0)
  if (other.items.length > 0) result.push(other)
  return result
}
