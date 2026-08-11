import { validateFeedFilters } from '../feed/feed-validation.js'

export function validateSearchInput(query = {}) {
  const feed = validateFeedFilters(query)
  const errors = { ...feed.errors }
  const q = query.q ?? ''
  if (q.length < 2 || q.length > 300) errors.q = 'Từ khóa phải có từ 2 đến 300 ký tự.'
  if (!['text', 'hybrid'].includes(query.mode ?? 'hybrid')) errors.mode = 'Chế độ tìm kiếm chưa hợp lệ.'
  const firstInvalid = ['q', 'mode', 'topic', 'sourceId', 'publishedAfter', 'publishedBefore'].find((field) => errors[field]) ?? null
  return { valid: !firstInvalid, firstInvalid, errors }
}
