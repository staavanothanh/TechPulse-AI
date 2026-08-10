import { describe, expect, it, vi } from 'vitest'
import { AUTH_CORE_COLLECTIONS } from '../../scripts/migrations/auth-core.js'
import { SOURCE_AUDIT_VALIDATOR } from '../../scripts/migrations/sources.js'
import {
  resolveStep3AuditValidator,
  runAuthCoreWithStep3Compatibility,
} from '../../scripts/migrations/step3-compatibility.js'

function namespaceExists() {
  const error = new Error('already exists')
  error.code = 48
  return error
}

describe('Step 3 migration compatibility', () => {
  it('accepts only exact known audit-validator revisions', () => {
    const authValidator = AUTH_CORE_COLLECTIONS.adminAuditLogs.validator
    expect(resolveStep3AuditValidator(authValidator)).toBe(authValidator)
    expect(resolveStep3AuditValidator(SOURCE_AUDIT_VALIDATOR)).toBe(SOURCE_AUDIT_VALIDATOR)

    const unknownSuperset = structuredClone(authValidator)
    unknownSuperset.$and[0].$or.push({ action: 'unknown_open_rule' })
    expect(() => resolveStep3AuditValidator(unknownSuperset)).toThrow(/unknown audit validator revision/i)
  })

  it('rejects an unknown revision before any migration mutation', async () => {
    const unknownSuperset = structuredClone(AUTH_CORE_COLLECTIONS.adminAuditLogs.validator)
    unknownSuperset.$and[0].$or.push({ action: 'unknown_open_rule' })
    const db = {
      listCollections: vi.fn(() => ({ toArray: async () => [{ options: { validator: unknownSuperset } }] })),
      createCollection: vi.fn(),
      command: vi.fn(),
      collection: vi.fn(),
    }

    await expect(runAuthCoreWithStep3Compatibility({ db })).rejects.toThrow(/unknown audit validator revision/i)
    expect(db.createCollection).not.toHaveBeenCalled()
    expect(db.command).not.toHaveBeenCalled()
    expect(db.collection).not.toHaveBeenCalled()
  })

  it('preserves the exact Source validator while dispatching auth-core', async () => {
    const commands = []
    const db = {
      listCollections: vi.fn(() => ({ toArray: async () => [{ options: { validator: SOURCE_AUDIT_VALIDATOR } }] })),
      createCollection: vi.fn(async () => { throw namespaceExists() }),
      command: vi.fn(async (command) => { commands.push(command) }),
      collection: vi.fn(() => ({ createIndex: vi.fn(async () => 'created') })),
    }

    await runAuthCoreWithStep3Compatibility({ db })

    const auditCollMod = commands.find((command) => command.collMod === 'adminAuditLogs')
    expect(auditCollMod.validator).toBe(SOURCE_AUDIT_VALIDATOR)
  })
})
