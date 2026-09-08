import { describe, expect, it, vi } from 'vitest'
import {
  PASSWORD_CHANGE_AUDIT_VALIDATOR,
  PASSWORD_CHANGE_COLLECTIONS,
  PASSWORD_CHANGE_USERS_VALIDATOR,
  buildPasswordChangeMigration,
  runPasswordChangeMigration,
} from '../../../scripts/migrations/password-change.js'
import { TOPIC_TAXONOMY_USERS_VALIDATOR } from '../../../scripts/migrations/topic-taxonomy-v1.js'
import { SOURCE_POLICY_RECONCILIATION_AUDIT_VALIDATOR } from '../../../scripts/migrations/source-policy-reconciliation.js'
import { AUTH_CORE_COLLECTIONS } from '../../../scripts/migrations/auth-core.js'

function readyDb() {
  const updateMany = vi.fn(async () => ({ matchedCount: 0, modifiedCount: 0 }))
  const db = {
    listCollections: vi.fn(() => ({ toArray: async () => [
      { name: 'users', options: { validator: TOPIC_TAXONOMY_USERS_VALIDATOR } },
      { name: 'adminAuditLogs', options: { validator: SOURCE_POLICY_RECONCILIATION_AUDIT_VALIDATOR } },
    ] })),
    command: vi.fn(async () => undefined),
    collection: vi.fn(() => ({ updateMany })),
  }
  return { db, updateMany }
}

describe('password-change migration contract', () => {
  it('adds an optional passwordEnabled flag while keeping the password hash required', () => {
    const activeSchema = PASSWORD_CHANGE_USERS_VALIDATOR.$or[0].$jsonSchema
    expect(activeSchema.required).toContain('passwordHash')
    expect(activeSchema.required).not.toContain('passwordEnabled')
    expect(activeSchema.properties.passwordEnabled).toEqual({ bsonType: 'bool' })
    // The deleted tombstone schema must not gain the new field.
    expect(PASSWORD_CHANGE_USERS_VALIDATOR.$or[1].$jsonSchema.properties.passwordEnabled).toBeUndefined()
  })

  it('extends the latest source-policy audit validator with the password change action', () => {
    const rules = PASSWORD_CHANGE_AUDIT_VALIDATOR.$and[0].$or
    expect(rules).toContainEqual(expect.objectContaining({ action: 'user_password_changed', reasonCode: 'password_changed', changedFields: ['passwordHash', 'sessionVersion'] }))
    expect(rules).toContainEqual(expect.objectContaining({ action: 'source_policy_reconciliation_requested' }))
  })

  it('builds only idempotent collMod operations for users and adminAuditLogs', () => {
    const plan = buildPasswordChangeMigration({ dryRun: true })
    expect(plan.every((operation) => operation.type === 'collMod')).toBe(true)
    expect(plan.some((operation) => operation.type === 'dropCollection' || operation.type === 'dropIndex')).toBe(false)
    expect(plan).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'collMod', collection: 'users', options: expect.objectContaining({ validator: PASSWORD_CHANGE_USERS_VALIDATOR }) }),
      expect.objectContaining({ type: 'collMod', collection: 'adminAuditLogs', options: expect.objectContaining({ validator: PASSWORD_CHANGE_AUDIT_VALIDATOR }) }),
    ]))
    expect(PASSWORD_CHANGE_COLLECTIONS.users.validator).toBe(PASSWORD_CHANGE_USERS_VALIDATOR)
  })

  it('applies the validators then backfills passwordEnabled for existing accounts', async () => {
    const { db, updateMany } = readyDb()
    const plan = await runPasswordChangeMigration({ db })
    expect(plan).toHaveLength(2)
    expect(db.command).toHaveBeenCalledTimes(2)
    // Two idempotent backfills: OAuth-only accounts to false, everyone else to true.
    expect(updateMany).toHaveBeenCalledTimes(2)
    const [oauthFilter, oauthSet] = updateMany.mock.calls[0]
    expect(oauthFilter).toEqual(expect.objectContaining({ status: { $ne: 'deleted' }, googleSub: { $exists: true }, passwordEnabled: { $exists: false } }))
    expect(oauthSet).toEqual({ $set: { passwordEnabled: false } })
    const [passwordFilter, passwordSet] = updateMany.mock.calls[1]
    expect(passwordFilter).toEqual(expect.objectContaining({ status: { $ne: 'deleted' }, googleSub: { $exists: false }, passwordEnabled: { $exists: false } }))
    expect(passwordSet).toEqual({ $set: { passwordEnabled: true } })
  })

  it('is safe to rerun once the validators are already installed', async () => {
    const updateMany = vi.fn(async () => ({ matchedCount: 0, modifiedCount: 0 }))
    const db = {
      listCollections: vi.fn(() => ({ toArray: async () => [
        { name: 'users', options: { validator: PASSWORD_CHANGE_USERS_VALIDATOR } },
        { name: 'adminAuditLogs', options: { validator: PASSWORD_CHANGE_AUDIT_VALIDATOR } },
      ] })),
      command: vi.fn(async () => undefined),
      collection: vi.fn(() => ({ updateMany })),
    }
    await expect(runPasswordChangeMigration({ db })).resolves.toHaveLength(2)
    expect(db.command).toHaveBeenCalledTimes(2)
  })

  it('refuses to run when the users predecessor validator is not ready', async () => {
    const db = {
      listCollections: vi.fn(() => ({ toArray: async () => [
        { name: 'users', options: { validator: AUTH_CORE_COLLECTIONS.users.validator } },
        { name: 'adminAuditLogs', options: { validator: SOURCE_POLICY_RECONCILIATION_AUDIT_VALIDATOR } },
      ] })),
      command: vi.fn(async () => undefined),
      collection: vi.fn(() => ({ updateMany: vi.fn(async () => ({})) })),
    }
    await expect(runPasswordChangeMigration({ db })).rejects.toThrow(/predecessor is not ready/i)
    expect(db.command).not.toHaveBeenCalled()
  })
})
