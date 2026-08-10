import { describe, expect, it } from 'vitest'
import { createJobAuditEvent, validateJobAuditInput } from '../../../server/audit/job-writer.js'

const actor = { id: '507f1f77bcf86cd799439011', role: 'admin' }

describe('safe job audit writer', () => {
  it('creates deterministic allowlisted admin job audit without snapshots', () => {
    const input = {
      actor, action: 'ingestion_job_retry_created', targetId: '507f1f77bcf86cd799439012',
      changedFields: ['status', 'attempt', 'parentJobId'], reasonCode: 'job_retry_requested',
      request: { idempotencyKey: 'retry-job-key-0001', actorSessionId: '507f1f77bcf86cd799439013' },
      result: 'succeeded', createdAt: new Date('2026-08-10T00:00:00.000Z'),
    }
    const first = createJobAuditEvent(input)
    const second = createJobAuditEvent(input)
    expect(first.eventId).toBe(second.eventId)
    expect(first).not.toHaveProperty('before')
    expect(first).not.toHaveProperty('after')
    expect(first.changedFields).toEqual(['status', 'attempt', 'parentJobId'])
  })

  it('rejects mismatched action, reason and changed fields', () => {
    expect(() => validateJobAuditInput({ action: 'ingestion_job_created', reasonCode: 'job_cancel_requested', changedFields: ['status'] })).toThrow(/allowlisted/i)
    expect(() => validateJobAuditInput({ action: 'ingestion_job_cancelled', reasonCode: 'job_cancel_requested', changedFields: ['passwordHash'] })).toThrow(/allowlisted/i)
  })
})
