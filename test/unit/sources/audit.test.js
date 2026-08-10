import { describe, expect, it } from 'vitest'
import { createSourceAuditEvent, sourceAuditEventId } from '../../../server/audit/source-writer.js'

const actor = { id: '64d2f4bda57d0c1d2c38f001', role: 'admin' }

describe('Source audit writer', () => {
  it('allows only the operation-specific action, reason and changed fields', () => {
    expect(createSourceAuditEvent({
      actor, action: 'source_status_updated', targetId: '64d2f4bda57d0c1d2c38f010',
      changedFields: ['operationalStatus'], reasonCode: 'source_status_changed',
      stateTransition: { from: 'testing', to: 'paused' }, request: { serverRequestId: 'server-request-1' },
    })).toEqual(expect.objectContaining({ targetType: 'source', actorType: 'admin', result: 'succeeded' }))
    expect(() => createSourceAuditEvent({ actor, action: 'source_status_updated', targetId: '64d2f4bda57d0c1d2c38f010', changedFields: ['licenseStatus'], reasonCode: 'source_status_changed', request: { serverRequestId: 'server-request-1' } })).toThrow(/allowlisted/i)
    expect(() => createSourceAuditEvent({ actor, action: 'source_configuration_updated', targetId: '64d2f4bda57d0c1d2c38f010', changedFields: ['passwordHash'], reasonCode: 'source_configuration_changed', request: { serverRequestId: 'server-request-1' } })).toThrow(/allowlisted/i)
    expect(() => createSourceAuditEvent({ actor, action: 'source_configuration_updated', targetId: '64d2f4bda57d0c1d2c38f010', changedFields: ['operationalStatus'], reasonCode: 'source_configuration_changed', request: { serverRequestId: 'server-request-1' } })).toThrow(/transition/i)
    expect(() => createSourceAuditEvent({ actor, action: 'source_configuration_updated', targetId: '64d2f4bda57d0c1d2c38f010', changedFields: ['domain', 'operationalStatus'], reasonCode: 'source_configuration_changed', request: { serverRequestId: 'server-request-1' } })).toThrow(/transition/i)
  })

  it('allows an enum-safe attempted transition only for a failed audit', () => {
    const input = { actor, action: 'source_status_updated', targetId: '64d2f4bda57d0c1d2c38f010', changedFields: ['operationalStatus'], reasonCode: 'source_status_changed', stateTransition: { from: 'draft', to: 'active' }, request: { serverRequestId: 'server-request-failed' } }
    expect(() => createSourceAuditEvent(input)).toThrow(/transition/i)
    expect(createSourceAuditEvent({ ...input, result: 'failed' })).toEqual(expect.objectContaining({ result: 'failed', stateTransition: { from: 'draft', to: 'active' } }))
  })

  it('scopes a re-review Idempotency-Key to actor and session instead of target source', () => {
    const first = sourceAuditEventId('source_policy_re_review_requested', '64d2f4bda57d0c1d2c38f010', 'same-key-1', actor.id, '64d2f4bda57d0c1d2c38f100')
    const differentTarget = sourceAuditEventId('source_policy_re_review_requested', '64d2f4bda57d0c1d2c38f011', 'same-key-1', actor.id, '64d2f4bda57d0c1d2c38f100')
    const differentSession = sourceAuditEventId('source_policy_re_review_requested', '64d2f4bda57d0c1d2c38f011', 'same-key-1', actor.id, '64d2f4bda57d0c1d2c38f101')
    expect(differentTarget).toBe(first)
    expect(differentSession).not.toBe(first)
  })

  it('rejects missing session scope, invalid result/timestamp and unauthorized worker actions', () => {
    expect(() => sourceAuditEventId('source_policy_re_review_requested', 'target', 'key', actor.id)).toThrow(/session/i)
    const base = { actor, action: 'source_created', targetId: '64d2f4bda57d0c1d2c38f010', changedFields: ['sourceKey', 'operationalStatus', 'policyVersion'], reasonCode: 'source_created', request: { serverRequestId: 'audit-guard-1' } }
    expect(() => createSourceAuditEvent({ ...base, result: 'unknown' })).toThrow(/result/i)
    expect(() => createSourceAuditEvent({ ...base, createdAt: new Date('invalid') })).toThrow(/timestamp/i)
    expect(() => createSourceAuditEvent({ ...base, actor: { id: 'worker', role: 'system-worker' }, action: 'source_status_updated', changedFields: ['operationalStatus'], reasonCode: 'source_status_changed', stateTransition: { from: 'testing', to: 'paused' } })).toThrow(/identity/i)
  })
})
