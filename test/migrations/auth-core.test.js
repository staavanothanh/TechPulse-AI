import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { ObjectId } from 'mongodb'
import {
  AUTH_CORE_COLLECTIONS,
  AUTH_CORE_INDEXES,
  buildAuthCoreMigration,
  validateDeletedUserDocument,
} from '../../scripts/migrations/auth-core.js'

const DEPLOYED_AUTH_CORE_BLOB = '6556ff34cdd954bea9831ba60ae40c81af8da67b'

function gitBlobHash(buffer) {
  return createHash('sha1')
    .update(`blob ${buffer.length}\0`)
    .update(buffer)
    .digest('hex')
}

describe('Step 2 auth-core migration contract', () => {
  it('defines all Step 2 collections and required indexes', () => {
    expect(Object.keys(AUTH_CORE_COLLECTIONS)).toEqual(['users', 'sessions', 'rateLimitBuckets', 'savedArticles', 'adminAuditLogs', 'hmacKeyLifecycleSnapshots'])
    expect(AUTH_CORE_INDEXES.users.some((index) => index.name === 'users_email_unique')).toBe(true)
    expect(AUTH_CORE_INDEXES.sessions.some((index) => index.name === 'sessions_expires_ttl')).toBe(true)
    expect(AUTH_CORE_INDEXES.rateLimitBuckets.some((index) => index.name === 'rate_limit_unique_window')).toBe(true)
    expect(AUTH_CORE_INDEXES.savedArticles.some((index) => index.name === 'saved_articles_user_article_unique')).toBe(true)
    expect(AUTH_CORE_INDEXES.adminAuditLogs.some((index) => index.name === 'audit_event_unique')).toBe(true)
    expect(AUTH_CORE_INDEXES.adminAuditLogs.find((index) => index.name === 'audit_ip_purge')?.key).toEqual({ ipHmacPurgeAfter: 1, _id: 1 })
    expect(AUTH_CORE_INDEXES.adminAuditLogs.find((index) => index.name === 'audit_purge')?.key).toEqual({ purgeAfter: 1, _id: 1 })
    expect(AUTH_CORE_INDEXES.hmacKeyLifecycleSnapshots.find((index) => index.name === 'hmac_lifecycle_revision_unique')).toEqual(expect.objectContaining({
      key: { inventoryId: 1, revision: 1 },
      options: { unique: true },
    }))
    expect(AUTH_CORE_INDEXES.hmacKeyLifecycleSnapshots.find((index) => index.name === 'hmac_lifecycle_latest')?.key).toEqual({ inventoryId: 1, revision: -1 })
  })

  it('validates a closed deleted-user tombstone and rejects identity fields', () => {
    const tombstone = {
      _id: new ObjectId(),
      status: 'deleted',
      deletionRequestedAt: new Date(),
      deletionRequestId: new ObjectId(),
      deletedAt: new Date(),
      sessionVersion: 2,
      createdAt: new Date(),
      updatedAt: new Date(),
    }
    expect(validateDeletedUserDocument(tombstone)).toEqual({ valid: true, errors: [] })
    expect(validateDeletedUserDocument({ ...tombstone, emailNormalized: 'leak@example.com' }).valid).toBe(false)
    expect(validateDeletedUserDocument({ ...tombstone, role: 'admin' }).valid).toBe(false)
  })

  it('builds an idempotent migration plan without destructive operations', () => {
    const plan = buildAuthCoreMigration({ dryRun: true })
    expect(plan.every((operation) => ['createCollection', 'collMod', 'createIndex'].includes(operation.type))).toBe(true)
    expect(plan.some((operation) => operation.type === 'dropCollection' || operation.type === 'dropIndex')).toBe(false)
  })

  it('keeps the deployed migration byte-identical to commit 12847240', () => {
    const migration = readFileSync(new URL('../../scripts/migrations/auth-core.js', import.meta.url))
    expect(gitBlobHash(migration)).toBe(DEPLOYED_AUTH_CORE_BLOB)
  })
})
