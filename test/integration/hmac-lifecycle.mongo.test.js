import { MongoClient, ObjectId } from 'mongodb'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { runAuthCoreMigration } from '../../scripts/migrations/auth-core.js'
import { createConfiguredAuthService } from '../../server/bootstrap/auth.js'
import { closeMongoConnection, createMongoContext } from '../../server/repositories/mongo/connection.js'
import { MongoAuthRepository } from '../../server/repositories/mongo/auth-repository.js'
import { createHmacKeyring } from '../../server/security/hmac-keyring.js'
import { reconcileQuotaHmacLifecycle } from '../../server/security/hmac-lifecycle.js'
import { databaseNameForSuite, dropTestDatabase } from '../../scripts/atlas-test-safety.js'
import { configureDns } from '../../scripts/configure-dns.js'

const hasMongo = Boolean(process.env.MONGODB_TEST_URI)
const describeMongo = hasMongo ? describe : describe.skip
let client
let context
let repository
let databaseName

function keyring(retiringVersions = [8, 9]) {
  return createHmacKeyring({
    currentEnv: 'CURRENT',
    retiringEnvs: retiringVersions.map((version) => `OLD_${version}`),
    currentVersion: 10,
    retiringVersions,
    values: { CURRENT: 'c'.repeat(32), OLD_8: 'a'.repeat(32), OLD_9: 'b'.repeat(32) },
  })
}

beforeAll(async () => {
  if (!hasMongo) return
  configureDns()
  client = new MongoClient(process.env.MONGODB_TEST_URI)
  await client.connect()
  databaseName = databaseNameForSuite('hmac')
  context = createMongoContext({ client, database: databaseName })
  await runAuthCoreMigration({ db: context.db })
  repository = new MongoAuthRepository(context)
})

afterAll(async () => {
  if (context) await dropTestDatabase({ context, expectedDatabase: databaseName })
  if (client) await client.close()
})

describeMongo('Step 2 durable HMAC lifecycle on real Mongo', () => {
  it('reconciles durable lifecycle before configured auth startup becomes available', async () => {
    const database = databaseNameForSuite('startup')
    await runAuthCoreMigration({ db: client.db(database) })
    const environment = {
      PUBLIC_APP_ORIGINS: 'http://localhost:3000', MONGODB_URI_ENV: 'TEST_MONGODB_URI', MONGODB_DATABASE: database,
      TEST_MONGODB_URI: process.env.MONGODB_TEST_URI,
      QUOTA_HMAC_CURRENT_KEY_ENV: 'CURRENT', QUOTA_HMAC_RETIRING_KEY_ENVS: 'OLD_8,OLD_9',
      QUOTA_HMAC_CURRENT_KEY_VERSION: '10', QUOTA_HMAC_RETIRING_KEY_VERSIONS: '8,9',
      CURRENT: 'c'.repeat(32), OLD_8: 'a'.repeat(32), OLD_9: 'b'.repeat(32),
      GOVERNANCE_SIGNING_CURRENT_KEY_ENV: 'GOVERNANCE_KEY', GOVERNANCE_SIGNING_RETIRING_KEY_ENVS: '',
      GOVERNANCE_KEY: 'g'.repeat(32), OFFLINE_CHECKPOINT_KEY_IDS: 'checkpoint-current',
      PROVIDER_ADMISSION_DOMAINS_JSON: '[]', INTERNAL_MACHINE_SECRET_ENV: 'CRON_SECRET', CRON_SECRET: 's'.repeat(32),
      NODE_ENV: 'test',
    }

    const configured = await createConfiguredAuthService({ environment })
    expect(await configured.context.db.collection('hmacKeyLifecycleSnapshots').countDocuments({ inventoryId: 'quota-hmac' })).toBe(1)
    await dropTestDatabase({ context: configured.context, expectedDatabase: database })
    await closeMongoConnection()
  }, 30_000)

  it('blocks deleting key 8 plus its declaration, proves zero dependents, then appends retirement history', async () => {
    await reconcileQuotaHmacLifecycle({ repository, keyring: keyring(), now: new Date('2026-07-01T00:00:00.000Z') })

    await expect(reconcileQuotaHmacLifecycle({
      repository,
      keyring: keyring([9]),
      now: new Date('2026-07-02T00:00:00.000Z'),
    })).rejects.toThrow(/30 days/)

    const windowStart = new Date('2026-08-02T00:00:00.000Z')
    await context.db.collection('rateLimitBuckets').insertOne({
      _id: new ObjectId(), scope: 'login', subjectType: 'ip', keyHash: '8'.repeat(64), keyVersion: 8,
      keyFingerprint: keyring().fingerprint(8), windowStart, count: 1, limit: 10,
      expiresAt: new Date('2026-08-02T00:16:00.000Z'), updatedAt: windowStart,
    })
    const dependentUserId = new ObjectId()
    await context.db.collection('sessions').insertOne({
      _id: new ObjectId(), tokenHash: '8'.repeat(64), userId: dependentUserId, userSessionVersion: 0,
      csrfSecretHash: 'c'.repeat(64), status: 'active', absoluteExpiresAt: new Date('2026-08-03T00:00:00.000Z'),
      expiresAt: new Date('2026-08-03T00:00:00.000Z'), lastSeenAt: windowStart, createdAt: windowStart,
      createdIpHmac: 'd'.repeat(64), ipHmacKeyVersion: 8,
    })
    await context.db.collection('adminAuditLogs').insertOne({
      _id: new ObjectId(), eventId: 'hmac-lifecycle-dependent-audit', actorType: 'system-worker', actorId: dependentUserId,
      action: 'user_logged_in', targetType: 'user', targetId: dependentUserId, changedFields: [], reasonCode: 'user_login',
      requestId: 'hmac-lifecycle-dependent-request', result: 'succeeded', createdAt: windowStart,
      ipAddressHmac: 'e'.repeat(64), ipHmacKeyVersion: 8,
    })
    expect(await repository.countHmacDependentsByKeyVersion(8)).toEqual({ rateLimitBuckets: 1, sessions: 1, adminAuditLogs: 1, total: 3 })
    await expect(reconcileQuotaHmacLifecycle({
      repository,
      keyring: keyring([9]),
      now: new Date('2026-08-02T00:00:00.000Z'),
    })).rejects.toThrow(/dependent/)

    await context.db.collection('rateLimitBuckets').deleteMany({ keyVersion: 8 })
    await context.db.collection('sessions').deleteMany({ ipHmacKeyVersion: 8 })
    await context.db.collection('adminAuditLogs').deleteMany({ ipHmacKeyVersion: 8 })
    const retired = await reconcileQuotaHmacLifecycle({
      repository,
      keyring: keyring([9]),
      now: new Date('2026-08-02T00:00:00.000Z'),
    })

    expect(retired.snapshot.revision).toBe(2)
    expect(retired.snapshot.versions.find((entry) => entry.version === 8)).toEqual(expect.objectContaining({
      state: 'retired',
      dependentEvidence: { rateLimitBuckets: 0, sessions: 0, adminAuditLogs: 0 },
    }))
    const snapshots = await context.db.collection('hmacKeyLifecycleSnapshots').find({ inventoryId: 'quota-hmac' }).sort({ revision: 1 }).toArray()
    expect(snapshots).toHaveLength(2)
    expect(snapshots[0].versions.find((entry) => entry.version === 8)?.state).toBe('retiring')
  }, 30_000)
})
