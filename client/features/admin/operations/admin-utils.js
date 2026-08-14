export function normalizeAdminFailure(error = {}) {
  if (error.status === 401) return { message: 'Phiên đăng nhập đã hết hạn. Hãy đăng nhập lại.' }
  if (error.status === 403) return { message: 'Bạn không có quyền quản trị thao tác này.' }
  if (error.status === 404) return { message: 'Bản ghi không còn khả dụng.' }
  if (error.status === 409) return { message: 'Trạng thái vừa thay đổi. Hãy tải lại trước khi tiếp tục.' }
  if (error.status === 422) return { message: 'Dữ liệu bộ lọc chưa hợp lệ.' }
  if (error.status === 429) return { message: `Đã chạm giới hạn thao tác. Thử lại sau ${error.retryAfter ?? 60} giây.` }
  if (error.status === 503) return { message: 'Dịch vụ tạm thời không sẵn sàng.' }
  if (error.status === 500) return { message: 'Không thể hoàn tất thao tác.' }
  return { message: 'Không thể hoàn tất thao tác.' }
}

const TAKEDOWN_COMPLETION_FIELDS = Object.freeze(['hidden', 'metadataRemoved', 'mediaMetadataRemoved', 'summaryRemoved', 'embeddingRemoved', 'historicalChatCitationsRedacted'])

export function projectTakedownDetail(payload) {
  const source = payload?.data ?? payload
  if (!source || typeof source !== 'object') return null
  const completion = source.completion && typeof source.completion === 'object'
    ? Object.fromEntries(TAKEDOWN_COMPLETION_FIELDS.map((field) => [field, source.completion[field] === true]))
    : null
  return {
    id: source.id,
    status: source.status,
    targetType: source.targetType,
    targetIds: Array.isArray(source.targetIds) ? [...source.targetIds] : [],
    requestedScope: Array.isArray(source.requestedScope) ? [...source.requestedScope] : [],
    decisionReasonCode: source.decisionReasonCode ?? null,
    completion,
    completedAt: source.completedAt ?? null,
    createdAt: source.createdAt,
    updatedAt: source.updatedAt,
  }
}
