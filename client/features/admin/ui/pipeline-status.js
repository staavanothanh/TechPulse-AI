const PIPELINE_STATUS = Object.freeze({
  actionableFailure: Object.freeze({ value: 'failed-actionable', label: 'Cần xem' }),
  reviewNeeded: Object.freeze({ value: 'review-needed', label: 'Cần xem xét' }),
  active: Object.freeze({ value: 'active', label: 'Đang chạy' }),
  queued: Object.freeze({ value: 'queued', label: 'Đang chờ' }),
  stable: Object.freeze({ value: 'stable', label: 'Ổn định' }),
})

function hasCount(value) {
  const count = Number(value)
  return Number.isFinite(count) && count > 0
}

export function deriveIngestionPipelineStatus(metrics = {}) {
  const data = metrics && typeof metrics === 'object' ? metrics : {}
  if (hasCount(data.actionableFailedJobs)) return PIPELINE_STATUS.actionableFailure
  if (hasCount(data.sourcesNeedingReview)) return PIPELINE_STATUS.reviewNeeded
  if (hasCount(data.activeJobs)) return PIPELINE_STATUS.active
  if (hasCount(data.queuedJobs)) return PIPELINE_STATUS.queued
  return PIPELINE_STATUS.stable
}
