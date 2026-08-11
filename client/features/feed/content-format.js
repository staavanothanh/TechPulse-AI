export function contentErrorCopy(error, fallback = 'Không thể tải dữ liệu.') {
  if (!error) return fallback
  if (error.status === 401) return 'Phiên đã hết hạn. Đăng nhập lại để tiếp tục.'
  if (error.status === 403) return 'Bạn không có quyền thực hiện thao tác này.'
  if (error.status === 404) return 'Bài không còn khả dụng.'
  if (error.status === 422) return 'Một trường chưa hợp lệ. Kiểm tra lại dữ liệu đã nhập.'
  if (error.status === 429) return `Bạn đã thao tác quá nhanh. Thử lại sau ${error.retryAfter ?? 'ít phút'} giây.`
  if (error.status === 503) return 'Dịch vụ đang tạm gián đoạn. Dữ liệu đã hiển thị vẫn được giữ nguyên.'
  return error.message || fallback
}

export function formatPublishedAt(value) {
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? '' : new Intl.DateTimeFormat('vi-VN', { dateStyle: 'medium', timeStyle: 'short' }).format(date)
}
