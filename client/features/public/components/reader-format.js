export const TOPICS = Object.freeze([
  'AI',
  'JavaScript',
  'Blockchain',
  'DevOps',
  'Bảo mật',
  'Dữ liệu',
])

const TOPIC_LABELS = Object.freeze({
  ai: 'AI',
  javascript: 'JavaScript',
  blockchain: 'Blockchain',
  devops: 'DevOps',
  'dev ops': 'DevOps',
  'dev-ops': 'DevOps',
  'bảo mật': 'Bảo mật',
  security: 'Bảo mật',
  'dữ liệu': 'Dữ liệu',
  data: 'Dữ liệu',
  database: 'Dữ liệu',
})

export function topicLabel(topic) {
  if (typeof topic !== 'string') return ''
  const normalized = topic.trim().toLocaleLowerCase('vi')
  return TOPIC_LABELS[normalized] ?? topic.trim()
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
