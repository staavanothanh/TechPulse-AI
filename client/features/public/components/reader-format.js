import {
  topicLabel as catalogTopicLabel,
  topicOptions,
} from '../../../../shared/topic-catalog.js'

export const TOPICS = topicOptions({ kind: 'parent', status: 'active', locale: 'vi' })

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
