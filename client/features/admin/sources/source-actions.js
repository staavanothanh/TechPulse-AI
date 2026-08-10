export function sourceActionPrerequisites(source = {}) {
  const missing = []
  if (source.technicalCheck?.status !== 'passed') missing.push('kiểm tra kỹ thuật chưa đạt')
  if (!['permitted', 'metadata-only'].includes(source.licenseStatus) || !source.reviewedAt || !source.reviewedBy || typeof source.evidenceNote !== 'string' || !source.evidenceNote.trim()) missing.push('duyệt quyền chưa đầy đủ')
  return {
    activationReady: missing.length === 0,
    activationReason: missing.length === 0 ? 'Đủ điều kiện kích hoạt.' : `Chưa thể kích hoạt: ${missing.join('; ')}.`,
    technicalCheckReady: false,
    technicalCheckReason: 'Kiểm tra kỹ thuật bằng safe-fetch sẽ khả dụng ở Step 4.',
  }
}

export function sourceRegistryErrorState(error) {
  let message
  if (error?.status === 401) message = 'Phiên đăng nhập đã hết hạn. Hãy đăng nhập lại.'
  else if (error?.status === 403) message = 'Bạn không có quyền quản trị Source Registry.'
  else if (error?.status === 409) message = 'Nguồn vừa thay đổi, evidence cần duyệt lại hoặc Idempotency-Key không còn khớp. Hãy tải lại.'
  else if (error?.status === 422) message = 'Dữ liệu nguồn hoặc chính sách chưa hợp lệ.'
  else if (error?.status === 503) message = 'Source Registry hoặc audit bắt buộc đang tạm thời không sẵn sàng.'
  else message = error?.message ?? 'Không thể hoàn tất thao tác Source Registry.'
  return { message, sessionExpiredNotice: error?.status === 401 ? 'Phiên đăng nhập đã hết hạn khi quản lý nguồn.' : null }
}

export function createSourceRegistryActions({ api, csrfToken, mutate, createIdempotencyKey = () => globalThis.crypto?.randomUUID?.() ?? `source-${Date.now()}` } = {}) {
  const jsonHeaders = { 'Content-Type': 'application/json', 'X-CSRF-Token': csrfToken }
  return {
    onCreate: (input) => mutate(() => api.createSource({ headers: jsonHeaders, credentials: 'same-origin', body: JSON.stringify(input) }), 'Đã tạo source draft.'),
    onConfig: (source, patch) => mutate(() => api.updateSource({ pathParams: { sourceId: source.id }, headers: jsonHeaders, credentials: 'same-origin', body: JSON.stringify(patch) }), 'Đã lưu cấu hình nguồn.'),
    onStatus: (source, operationalStatus) => mutate(() => api.updateSource({ pathParams: { sourceId: source.id }, headers: jsonHeaders, credentials: 'same-origin', body: JSON.stringify({ operationalStatus, reasonCode: 'source_status_changed' }) }), `Đã chuyển nguồn sang ${operationalStatus}.`),
    onTechnicalCheck: (source) => mutate(() => api.runSourceTechnicalCheck({ pathParams: { sourceId: source.id }, headers: jsonHeaders, credentials: 'same-origin', body: JSON.stringify({ reasonCode: 'source_technical_check_requested' }) }), 'Đã ghi kết quả kiểm tra kỹ thuật.'),
    onPolicyReview: (source, review) => mutate(() => api.reviewSourcePolicy({ pathParams: { sourceId: source.id }, headers: jsonHeaders, credentials: 'same-origin', body: JSON.stringify(review) }), 'Đã lưu quyết định policy review.'),
    onReReview: (source) => mutate(() => api.requestSourcePolicyReReview({ pathParams: { sourceId: source.id }, headers: { ...jsonHeaders, 'Idempotency-Key': createIdempotencyKey() }, credentials: 'same-origin', body: JSON.stringify({ reasonCode: 'source_policy_re_review_requested' }) }), 'Nguồn đã được fail-close để duyệt lại.'),
  }
}
