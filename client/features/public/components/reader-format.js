export const TOPICS = Object.freeze([
  'AI',
  'JavaScript',
  'Blockchain',
  'DevOps',
  'Bảo mật',
  'Dữ liệu',
])

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
