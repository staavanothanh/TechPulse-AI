import { describe, expect, it } from 'vitest'
import { deriveIngestionPipelineStatus } from '../../../client/features/admin/ui/pipeline-status.js'
import { statusTone } from '../../../client/features/admin/ui/admin-data.js'

describe('ingestion pipeline status', () => {
  it('keeps actionable failures ahead of every other signal', () => {
    expect(deriveIngestionPipelineStatus({
      actionableFailedJobs: 1,
      terminalFailedJobs: 2,
      sourcesNeedingReview: 3,
      activeJobs: 4,
      queuedJobs: 5,
    })).toMatchObject({ value: 'failed-actionable', label: 'Cần xem' })
  })

  it('reports review-needed sources when no jobs are queued', () => {
    expect(deriveIngestionPipelineStatus({ queuedJobs: 0, activeJobs: 0, sourcesNeedingReview: 2 }))
      .toMatchObject({ value: 'review-needed', label: 'Cần xem xét' })
  })
  it('prioritizes review-needed over active and queued without an actionable failure', () => {
    expect(deriveIngestionPipelineStatus({
      queuedJobs: 3,
      activeJobs: 2,
      actionableFailedJobs: 0,
      sourcesNeedingReview: 1,
    })).toMatchObject({ value: 'review-needed', label: 'Cần xem xét' })
  })

  it('keeps terminal failures diagnostic without making the pipeline actionable', () => {
    expect(deriveIngestionPipelineStatus({ queuedJobs: 0, activeJobs: 0, terminalFailedJobs: 2 }))
      .toMatchObject({ value: 'stable', label: 'Ổn định' })
  })

  it('reports active work before queued work', () => {
    expect(deriveIngestionPipelineStatus({ queuedJobs: 3, activeJobs: 1 }))
      .toMatchObject({ value: 'active', label: 'Đang chạy' })
  })

  it('reports queued work when no active work or review signal exists', () => {
    expect(deriveIngestionPipelineStatus({ queuedJobs: 3, activeJobs: 0 }))
      .toMatchObject({ value: 'queued', label: 'Đang chờ' })
  })

  it('reports a stable pipeline when all operational signals are empty', () => {
    expect(deriveIngestionPipelineStatus({
      queuedJobs: 0,
      activeJobs: 0,
      actionableFailedJobs: 0,
      terminalFailedJobs: 0,
      sourcesNeedingReview: 0,
    })).toMatchObject({ value: 'stable', label: 'Ổn định' })
  })
  it('maps pipeline-specific values to actionable, stable and review tones', () => {
    expect(statusTone('failed-actionable')).toBe('danger')
    expect(statusTone('review-needed')).toBe('warning')
    expect(statusTone('active')).toBe('success')
    expect(statusTone('queued')).toBe('accent')
    expect(statusTone('stable')).toBe('success')
  })
})
