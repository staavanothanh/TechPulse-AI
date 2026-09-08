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
