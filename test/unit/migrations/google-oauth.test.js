import { describe, expect, it, vi } from 'vitest'
import {
  GOOGLE_OAUTH_AUDIT_VALIDATOR,
  GOOGLE_OAUTH_COLLECTIONS,
  GOOGLE_OAUTH_INDEXES,
  buildGoogleOAuthMigration,
  runGoogleOAuthMigration,
} from '../../../scripts/migrations/google-oauth.js'
import { AUTH_CORE_COLLECTIONS } from '../../../scripts/migrations/auth-core.js'
import { GOVERNANCE_AUDIT_VALIDATOR } from '../../../scripts/migrations/governance-audit.js'

describe('Google OAuth migration contract', () => {
  it('keeps the password hash required while allowing a bounded optional Google subject', () => {
    const activeSchema = GOOGLE_OAUTH_COLLECTIONS.users.validator.$or[0].$jsonSchema
    expect(activeSchema.required).toContain('passwordHash')
    expect(activeSchema.properties.passwordHash).toEqual(expect.objectContaining({ bsonType: 'string' }))
    expect(activeSchema.properties.googleSub).toEqual(expect.objectContaining({ bsonType: 'string', maxLength: 255 }))
    expect(GOOGLE_OAUTH_INDEXES.users).toContainEqual(expect.objectContaining({
      name: 'users_google_sub_unique',
      key: { googleSub: 1 },
      options: { unique: true, partialFilterExpression: { googleSub: { $type: 'string' } } },
    }))
  })

  it('extends the latest governance audit validator with OAuth actions', () => {
    const rules = GOOGLE_OAUTH_AUDIT_VALIDATOR.$and[0].$or
    expect(rules).toContainEqual(expect.objectContaining({ action: 'google_oauth_registered', reasonCode: 'google_oauth_registered' }))
    expect(rules).toContainEqual(expect.objectContaining({ action: 'google_oauth_login', reasonCode: 'google_oauth_login' }))
  })

  it('builds only idempotent collMod/createIndex operations and preserves governance audit compatibility', () => {
    const plan = buildGoogleOAuthMigration({ dryRun: true })
    expect(plan.every((operation) => ['collMod', 'createIndex'].includes(operation.type))).toBe(true)
    expect(plan.some((operation) => operation.type === 'dropCollection' || operation.type === 'dropIndex')).toBe(false)
    expect(plan).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'collMod', collection: 'users' }),
      expect.objectContaining({ type: 'collMod', collection: 'adminAuditLogs', options: expect.objectContaining({ validator: GOOGLE_OAUTH_AUDIT_VALIDATOR }) }),
    ]))
  })

  it('is safe to rerun against an existing database', async () => {
    const db = {
      listCollections: vi.fn(() => ({ toArray: async () => [
        { name: 'users', options: { validator: AUTH_CORE_COLLECTIONS.users.validator } },
        { name: 'adminAuditLogs', options: { validator: GOVERNANCE_AUDIT_VALIDATOR } },
      ] })),
      command: vi.fn(async () => undefined),
      collection: vi.fn(() => ({ createIndex: vi.fn(async () => 'index-name') })),
    }
    await expect(runGoogleOAuthMigration({ db })).resolves.toHaveLength(3)
    await expect(runGoogleOAuthMigration({ db })).resolves.toHaveLength(3)
    expect(db.listCollections).toHaveBeenLastCalledWith({ name: /^(users|adminAuditLogs)$/ }, { nameOnly: false })
    expect(db.command).toHaveBeenCalledTimes(4)
  })
})
