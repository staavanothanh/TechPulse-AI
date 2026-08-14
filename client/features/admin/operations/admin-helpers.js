import { useEffect, useState } from 'react'

export const OVERVIEW_FIELDS = Object.freeze([
  ['failedJobs', 'Job lỗi', 'exception'],
  ['failedIndexes', 'Index lỗi', 'exception'],
  ['openTakedowns', 'Takedown đang mở', 'warning'],
  ['failedAccountDeletions', 'Xóa tài khoản lỗi', 'exception'],
  ['sourcesNeedingReview', 'Nguồn cần duyệt', 'warning'],
  ['articlesNeedingReview', 'Article cần duyệt', 'warning'],
  ['queuedJobs', 'Job đang chờ', 'quiet'],
  ['activeSources', 'Nguồn đang hoạt động', 'quiet'],
  ['pausedSources', 'Nguồn tạm dừng', 'quiet'],
])

export const DELETION_FLAGS = Object.freeze(['sessionsRevoked', 'sessionsDeleted', 'savedArticlesDeleted', 'chatSessionsDeleted', 'answerAttemptsDeleted', 'userQuotaDataDeleted', 'identityAnonymized'])
export const TERMINAL_WORKFLOW_STATES = new Set(['completed', 'failed', 'rejected', 'cancelled'])

export function idempotencyKey(intent) {
  const suffix = globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`
  return `admin-${intent}-${suffix}`
}

export function invalidateRequest(requestId) {
  requestId.current += 1
}

export function useRetryAfterCooldown() {
  const [retryAfter, setRetryAfter] = useState(0)
  useEffect(() => {
    if (retryAfter <= 0) return undefined
    const timer = globalThis.setTimeout(() => setRetryAfter((current) => Math.max(0, current - 1)), 1_000)
    return () => globalThis.clearTimeout(timer)
  }, [retryAfter])
  return [retryAfter, setRetryAfter]
}

export function formatDate(value) {
  if (!value) return '—'
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? '—' : new Intl.DateTimeFormat('vi-VN', { dateStyle: 'medium', timeStyle: 'short' }).format(date)
}

export function statusLabel(value) {
  const labels = {
    published: 'Đang hiển thị',
    hidden: 'Đã ẩn',
    approved: 'Đã duyệt',
    reviewing: 'Đang xem xét',
    rejected: 'Từ chối',
    completed: 'Hoàn tất',
    received: 'Đã tiếp nhận',
    active: 'Đang hoạt động',
    suspended: 'Tạm dừng',
    deleted: 'Đã xóa',
    queued: 'Đang chờ',
    running: 'Đang chạy',
    failed: 'Lỗi',
  }
  return labels[value] ?? value ?? '—'
}
