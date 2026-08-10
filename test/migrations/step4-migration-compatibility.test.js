import { describe, expect, it, vi } from 'vitest'
import { AUTH_CORE_COLLECTIONS } from '../../scripts/migrations/auth-core.js'
import { SOURCE_AUDIT_VALIDATOR } from '../../scripts/migrations/sources.js'
import { DURABLE_JOB_AUDIT_VALIDATOR } from '../../scripts/migrations/durable-jobs.js'
import {
  resolveStep4AuditValidator,
  runAuthCoreWithStep4Compatibility,
  runDurableJobsWithStep4Compatibility,
  runSourcesWithStep4Compatibility,
} from '../../scripts/migrations/step4-compatibility.js'

describe('Step 4 migration compatibility', () => {
  it('accepts only exact auth, source and durable-job audit revisions', () => {
    expect(resolveStep4AuditValidator(AUTH_CORE_COLLECTIONS.adminAuditLogs.validator)).toBe(AUTH_CORE_COLLECTIONS.adminAuditLogs.validator)
    expect(resolveStep4AuditValidator(SOURCE_AUDIT_VALIDATOR)).toBe(SOURCE_AUDIT_VALIDATOR)
    expect(resolveStep4AuditValidator(DURABLE_JOB_AUDIT_VALIDATOR)).toBe(DURABLE_JOB_AUDIT_VALIDATOR)
    const unknown = structuredClone(DURABLE_JOB_AUDIT_VALIDATOR)
    unknown.$and[0].$or.push({ action: 'unknown_step4_rule' })
    expect(() => resolveStep4AuditValidator(unknown)).toThrow(/unknown audit validator revision/i)
  })

  it('fails before any mutation when current audit revision is unknown', async () => {
    const unknown = structuredClone(SOURCE_AUDIT_VALIDATOR)
    unknown.$and[0].$or.push({ action: 'unknown_step4_rule' })
    const db = {
      listCollections: vi.fn(() => ({ toArray: async () => [{ options: { validator: unknown } }] })),
      createCollection: vi.fn(), command: vi.fn(), collection: vi.fn(),
    }
    await expect(runAuthCoreWithStep4Compatibility({ db })).rejects.toThrow(/unknown audit validator revision/i)
    expect(db.createCollection).not.toHaveBeenCalled()
    expect(db.command).not.toHaveBeenCalled()
    expect(db.collection).not.toHaveBeenCalled()
  })

  it('preserves the durable-job audit revision across older migration dispatches', async () => {
    const commands = []
    const db = {
      listCollections: vi.fn(() => ({ toArray: async () => [{ options: { validator: DURABLE_JOB_AUDIT_VALIDATOR } }] })),
      createCollection: vi.fn(async () => { const error = new Error('exists'); error.code = 48; throw error }),
      command: vi.fn(async (command) => { commands.push(command) }),
      collection: vi.fn(() => ({ createIndex: vi.fn(async () => 'created') })),
    }
    await runAuthCoreWithStep4Compatibility({ db })
    await runSourcesWithStep4Compatibility({ db })
    const auditMutations = commands.filter((command) => command.collMod === 'adminAuditLogs')
    expect(auditMutations).toHaveLength(2)
    expect(auditMutations.every((command) => command.validator === DURABLE_JOB_AUDIT_VALIDATOR)).toBe(true)
  })

  it('preflights the audit revision before durable-jobs mutates any collection', async () => {
    const unknown = structuredClone(SOURCE_AUDIT_VALIDATOR)
    unknown.$and[0].$or.push({ action: 'unknown_step4_rule' })
    const db = {
      listCollections: vi.fn(() => ({ toArray: async () => [{ options: { validator: unknown } }] })),
      createCollection: vi.fn(), command: vi.fn(), collection: vi.fn(),
    }
    await expect(runDurableJobsWithStep4Compatibility({ db })).rejects.toThrow(/unknown audit validator revision/i)
    expect(db.createCollection).not.toHaveBeenCalled()
    expect(db.command).not.toHaveBeenCalled()
    expect(db.collection).not.toHaveBeenCalled()
  })

  it('requires the exact Step 3 source revision before durable-jobs can mutate', async () => {
    const db = {
      listCollections: vi.fn(() => ({ toArray: async () => [{ options: { validator: AUTH_CORE_COLLECTIONS.adminAuditLogs.validator } }] })),
      createCollection: vi.fn(), command: vi.fn(), collection: vi.fn(),
    }
    await expect(runDurableJobsWithStep4Compatibility({ db })).rejects.toThrow(/sources migration/i)
    expect(db.createCollection).not.toHaveBeenCalled()
    expect(db.command).not.toHaveBeenCalled()
  })
})
