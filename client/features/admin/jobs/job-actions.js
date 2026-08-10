export function jobActionPrerequisites(job = {}) {
  const retryReady = (job.status === 'partial' || job.status === 'failed' && job.error?.retryable === true) && job.attempt < 3
  const cancelReady = ['queued', 'running'].includes(job.status)
  return {
    retryReady,
    retryReason: retryReady ? 'Job có thể tạo linked retry.' : 'Chỉ job partial hoặc failed/retryable dưới ba lần thử mới được retry.',
    cancelReady,
    cancelReason: cancelReady ? 'Job có thể dừng an toàn.' : 'Job terminal không thể hủy lại.',
  }
}

export function jobsErrorState(error) {
  let message
  if (error?.status === 401) message = 'Phiên đăng nhập đã hết hạn. Hãy đăng nhập lại.'
  else if (error?.status === 403 && error?.code === 'csrf_invalid') message = 'Phiên thao tác đã hết hạn. Hãy tải lại để lấy CSRF mới.'
  else if (error?.status === 403) message = 'Bạn không có quyền quản trị durable jobs.'
  else if (error?.status === 409) message = 'Job vừa thay đổi hoặc Idempotency-Key đã gắn với intent khác. Hãy tải lại.'
  else if (error?.status === 422) message = 'Yêu cầu job chưa hợp lệ.'
  else if (error?.status === 429) message = `Đã chạm giới hạn thao tác. Thử lại sau ${error?.retryAfter ?? error?.retryAfterSeconds ?? 'ít phút'}.`
  else if (error?.status === 503) message = 'Durable job service đang tạm thời không sẵn sàng.'
  else message = error?.message ?? 'Không thể hoàn tất thao tác durable job.'
  return { message, sessionExpiredNotice: error?.status === 401 ? 'Phiên đăng nhập đã hết hạn khi quản lý jobs.' : null }
}

export function createJobActions({ api, csrfToken, mutate, intentKeys = new Map(), createIdempotencyKey = (intent) => `job-${intent}-${globalThis.crypto?.randomUUID?.() ?? Date.now()}` } = {}) {
  const headers = { 'Content-Type': 'application/json', 'X-CSRF-Token': csrfToken }
  const keyFor = (intent) => intentKeys.get(intent) ?? (() => {
    const key = createIdempotencyKey(intent)
    intentKeys.set(intent, key)
    return key
  })()
  const invoke = async (intent, operation, notice) => {
    try {
      const result = await mutate(() => operation(keyFor(intent)), notice)
      intentKeys.delete(intent)
      return result
    } catch (error) {
      if ([400, 422].includes(error?.status) || error?.status === 409 && error?.code === 'idempotency_mismatch') intentKeys.delete(intent)
      throw error
    }
  }
  return {
    onCreate: (input) => invoke(`create:${input.sourceId}:${input.batchSize}`, (key) => api.createIngestionJob({ headers: { ...headers, 'Idempotency-Key': key }, credentials: 'same-origin', body: JSON.stringify(input) }), 'Đã xếp ingestion job vào durable queue.'),
    onRetry: (job) => invoke(`retry:${job.id}`, (key) => api.retryIngestionJob({ pathParams: { jobId: job.id }, headers: { ...headers, 'Idempotency-Key': key }, credentials: 'same-origin', body: JSON.stringify({ reasonCode: 'job_retry_requested' }) }), 'Đã tạo linked retry.'),
    onCancel: (job) => mutate(() => api.cancelIngestionJob({ pathParams: { jobId: job.id }, headers, credentials: 'same-origin', body: JSON.stringify({ reasonCode: 'job_cancel_requested' }) }), job.status === 'running' ? 'Đã ghi yêu cầu dừng an toàn.' : 'Đã hủy job đang chờ.'),
  }
}
