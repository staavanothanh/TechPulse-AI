export function indexingJobPrerequisites(job = {}) {
  const retryReady = job.status === 'partial' || job.status === 'failed' && job.error?.retryable === true
  const cancelReady = ['queued', 'running'].includes(job.status)
  return {
    retryReady,
    retryReason: retryReady ? 'Có thể yêu cầu server tạo một linked retry mới.' : 'Chỉ job partial hoặc failed/retryable mới có thể gửi yêu cầu retry.',
    cancelReady,
    cancelReason: cancelReady ? 'Có thể gửi yêu cầu dừng an toàn.' : 'Job terminal không thể hủy lại.',
  }
}

export function indexingJobsErrorState(error) {
  if (error?.status === 401) return { message: 'Phiên đăng nhập đã hết hạn.', sessionExpiredNotice: 'Phiên đăng nhập đã hết hạn khi quản lý indexing jobs.' }
  if (error?.status === 403 && error?.code === 'csrf_invalid') return { message: 'Phiên thao tác đã hết hạn. Hãy tải lại để lấy CSRF mới.', sessionExpiredNotice: null }
  if (error?.status === 403) return { message: 'Bạn không có quyền quản trị indexing jobs.', sessionExpiredNotice: null }
  if (error?.status === 404) return { message: 'Job hoặc bài viết không còn khả dụng.', sessionExpiredNotice: null }
  if (error?.status === 409) return { message: 'Trạng thái vừa thay đổi. Hãy tải lại trước khi tiếp tục.', sessionExpiredNotice: null }
  if (error?.status === 422) return { message: 'Bộ lọc hoặc thao tác indexing chưa hợp lệ.', sessionExpiredNotice: null }
  if (error?.status === 429) return { message: `Đã chạm giới hạn thao tác. Thử lại sau ${error.retryAfter ?? 'ít phút'}.`, sessionExpiredNotice: null }
  if (error?.status === 503) return { message: 'Indexing service đang tạm thời không sẵn sàng.', sessionExpiredNotice: null }
  return { message: error?.message ?? 'Không thể hoàn tất thao tác indexing.', sessionExpiredNotice: null }
}

export function createIndexingJobActions({ api, csrfToken, mutate, intentKeys = new Map(), createIdempotencyKey = (intent) => `indexing-${intent}-${globalThis.crypto?.randomUUID?.() ?? Date.now()}` } = {}) {
  const headers = { 'Content-Type': 'application/json', 'X-CSRF-Token': csrfToken }
  const keyFor = (intent) => intentKeys.get(intent) ?? (() => { const key = createIdempotencyKey(intent); intentKeys.set(intent, key); return key })()
  const invoke = async (intent, operation, notice) => {
    try {
      const response = await mutate(() => operation(keyFor(intent)), notice)
      intentKeys.delete(intent)
      return response
    } catch (error) {
      if ([400, 422].includes(error?.status) || error?.status === 409 && error?.code === 'idempotency_mismatch') intentKeys.delete(intent)
      throw error
    }
  }
  return Object.freeze({
    createSummary: (articleId) => invoke(`summary:${articleId}`, (key) => api.createSummaryJob({ pathParams: { articleId }, headers: { ...headers, 'Idempotency-Key': key }, credentials: 'same-origin', body: JSON.stringify({ reasonCode: 'artifact_regeneration_requested' }) }), 'Đã xếp job tóm tắt vào hàng đợi.'),
    createTask: (articleId, task) => invoke(`${task}:${articleId}`, (key) => api.createIndexingJob({ pathParams: { articleId }, headers: { ...headers, 'Idempotency-Key': key }, credentials: 'same-origin', body: JSON.stringify({ task, reasonCode: 'artifact_regeneration_requested' }) }), `Đã xếp job ${task} vào hàng đợi.`),
    retry: (job) => invoke(`retry:${job.id}`, (key) => api.retryIndexingJob({ pathParams: { jobId: job.id }, headers: { ...headers, 'Idempotency-Key': key }, credentials: 'same-origin', body: JSON.stringify({ reasonCode: 'job_retry_requested' }) }), 'Đã tạo linked retry mới.'),
    cancel: (job) => mutate(() => api.cancelIndexingJob({ pathParams: { jobId: job.id }, headers, credentials: 'same-origin', body: JSON.stringify({ reasonCode: 'job_cancel_requested' }) }), 'Server đã ghi nhận trạng thái yêu cầu dừng.'),
  })
}
