import { TOPIC_TAXONOMY_USERS_VALIDATOR, TOPIC_TAXONOMY_USERS_COMPATIBILITY_VALIDATOR } from './topic-taxonomy-v1.js'
import { SOURCE_POLICY_RECONCILIATION_AUDIT_VALIDATOR } from './source-policy-reconciliation.js'

/**
 * Migration `password-change`: mở rộng schema để hỗ trợ tính năng khách hàng đổi
 * mật khẩu (kể cả tài khoản Google-only đặt mật khẩu lần đầu).
 *
 * Phạm vi collMod (chỉ 2 collection, không đụng rateLimitBuckets):
 * - `users`: thêm field optional `passwordEnabled` (bool) vào active schema.
 *   `passwordEnabled === false` đánh dấu tài khoản chỉ có hash "mồi" (OAuth-only,
 *   chưa đặt mật khẩu thật); `true`/thiếu nghĩa là đã có mật khẩu dùng được.
 * - `adminAuditLogs`: cho phép action `user_password_changed` trong allowlist.
 *
 * Không tạo index mới: `passwordEnabled` không phải khoá truy vấn; `googleSub`
 * đã có unique index từ migration google-oauth.
 */

function clone(value) {
  return structuredClone(value)
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`
  return JSON.stringify(value)
}

// --- users validator: kế thừa bản cuối của topic-taxonomy-v1, thêm passwordEnabled ---
const topicUsersValidator = TOPIC_TAXONOMY_USERS_VALIDATOR
const activeUserSchema = clone(topicUsersValidator.$or[0].$jsonSchema)
const deletedUserSchema = clone(topicUsersValidator.$or[1].$jsonSchema)
activeUserSchema.properties.passwordEnabled = { bsonType: 'bool' }

export const PASSWORD_CHANGE_USERS_VALIDATOR = Object.freeze({
  $or: Object.freeze([
    { $jsonSchema: activeUserSchema },
    { $jsonSchema: deletedUserSchema },
  ]),
})

// --- audit validator: kế thừa bản cuối của source-policy-reconciliation, thêm rule ---
const passwordAuditRule = Object.freeze({
  action: 'user_password_changed',
  reasonCode: 'password_changed',
  changedFields: ['passwordHash', 'sessionVersion'],
  stateTransition: { $exists: false },
})

const baseAuditParts = SOURCE_POLICY_RECONCILIATION_AUDIT_VALIDATOR.$and
export const PASSWORD_CHANGE_AUDIT_VALIDATOR = Object.freeze({
  $and: Object.freeze([
    { $or: Object.freeze([...baseAuditParts[0].$or, passwordAuditRule]) },
    baseAuditParts[1],
  ]),
})

export const PASSWORD_CHANGE_COLLECTIONS = Object.freeze({
  users: Object.freeze({ validator: PASSWORD_CHANGE_USERS_VALIDATOR }),
  adminAuditLogs: Object.freeze({ validator: PASSWORD_CHANGE_AUDIT_VALIDATOR }),
})

const KNOWN_USERS_PREDECESSORS = Object.freeze([
  TOPIC_TAXONOMY_USERS_VALIDATOR,
  TOPIC_TAXONOMY_USERS_COMPATIBILITY_VALIDATOR,
])
const KNOWN_AUDIT_PREDECESSORS = Object.freeze([
  SOURCE_POLICY_RECONCILIATION_AUDIT_VALIDATOR,
])

/**
 * Kiểm tra predecessor: users đang ở validator của topic-taxonomy (hoặc compatibility)
 * và audit đang ở validator của source-policy-reconciliation — hoặc đã là bản
 * password-change (cho phép chạy lại idempotent).
 */
async function assertPredecessor(db) {
  if (typeof db.listCollections !== 'function') throw new Error('password-change migration predecessor check is unavailable')
  const collections = await db.listCollections({ name: /^(users|adminAuditLogs)$/ }, { nameOnly: false }).toArray()
  const byName = new Map(collections.map((collection) => [collection.name, collection]))
  const users = byName.get('users')
  const audit = byName.get('adminAuditLogs')
  const usersReady = users && [...KNOWN_USERS_PREDECESSORS, PASSWORD_CHANGE_USERS_VALIDATOR].some((validator) => stableJson(users.options?.validator) === stableJson(validator))
  const auditReady = audit && [...KNOWN_AUDIT_PREDECESSORS, PASSWORD_CHANGE_AUDIT_VALIDATOR].some((validator) => stableJson(audit.options?.validator) === stableJson(validator))
  if (!usersReady || !auditReady) throw new Error('password-change migration predecessor is not ready')
}

/**
 * Backfill idempotent cho tài khoản đã tồn tại trước khi có field `passwordEnabled`.
 * Trong code hiện hành, `googleSub` chỉ được gán khi tạo user qua Google OAuth với
 * hash "mồi", nên `googleSub` tồn tại ⟺ tài khoản OAuth-only chưa có mật khẩu thật.
 * Chỉ áp dụng cho user chưa bị xoá (tombstone không mang các field này).
 */
async function backfillPasswordEnabled(db) {
  await db.collection('users').updateMany(
    { status: { $ne: 'deleted' }, googleSub: { $exists: true }, passwordEnabled: { $exists: false } },
    { $set: { passwordEnabled: false } },
  )
  await db.collection('users').updateMany(
    { status: { $ne: 'deleted' }, googleSub: { $exists: false }, passwordEnabled: { $exists: false } },
    { $set: { passwordEnabled: true } },
  )
}

function migrationOperations() {
  return [
    { type: 'collMod', collection: 'users', options: { validator: PASSWORD_CHANGE_USERS_VALIDATOR, validationLevel: 'strict', validationAction: 'error' } },
    { type: 'collMod', collection: 'adminAuditLogs', options: { validator: PASSWORD_CHANGE_AUDIT_VALIDATOR, validationLevel: 'strict', validationAction: 'error' } },
  ]
}

export function buildPasswordChangeMigration({ dryRun = false } = {}) {
  const plan = migrationOperations()
  return dryRun ? plan.map((operation) => ({ ...operation, dryRun: true })) : plan
}

export async function runPasswordChangeMigration({ db, dryRun = false } = {}) {
  if (!db || typeof db.command !== 'function' || typeof db.collection !== 'function') throw new Error('MongoDB database is required')
  const plan = buildPasswordChangeMigration({ dryRun })
  if (dryRun) return plan
  await assertPredecessor(db)
  for (const operation of plan) {
    if (operation.type === 'collMod') await db.command({ collMod: operation.collection, ...operation.options })
  }
  // collMod trước để validator chấp nhận passwordEnabled, rồi mới backfill dữ liệu cũ.
  await backfillPasswordEnabled(db)
  return plan
}
