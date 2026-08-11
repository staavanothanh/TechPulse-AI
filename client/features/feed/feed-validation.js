export function validateFeedFilters(filters = {}) {
  const errors = {}
  if ((filters.topic ?? '').length > 64) errors.topic = 'Chủ đề tối đa 64 ký tự.'
  if ((filters.sourceId ?? '').length > 128) errors.sourceId = 'Source ID tối đa 128 ký tự.'
  for (const field of ['publishedAfter', 'publishedBefore']) {
    if (filters[field] && Number.isNaN(new Date(filters[field]).getTime())) errors[field] = 'Mốc thời gian chưa hợp lệ.'
  }
  if (!errors.publishedAfter && !errors.publishedBefore && filters.publishedAfter && filters.publishedBefore && new Date(filters.publishedAfter) > new Date(filters.publishedBefore)) errors.publishedAfter = 'Mốc bắt đầu phải trước mốc kết thúc.'
  const firstInvalid = ['topic', 'sourceId', 'publishedAfter', 'publishedBefore'].find((field) => errors[field]) ?? null
  return { valid: !firstInvalid, firstInvalid, errors }
}
