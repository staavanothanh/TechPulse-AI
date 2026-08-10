import { MongoClient, ObjectId } from 'mongodb'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createSourceAuditEvent } from '../../server/audit/source-writer.js'
import { createDraftSource, applySourceUpdate } from '../../server/domain/source/state-machine.js'
import { createMongoContext } from '../../server/repositories/mongo/connection.js'
import { MongoSourceRepository } from '../../server/repositories/mongo/source-repository.js'
import { runAuthCoreMigration } from '../../scripts/migrations/auth-core.js'
import { runSourcesMigration } from '../../scripts/migrations/sources.js'
import { databaseNameForSuite, dropTestDatabase } from '../../scripts/atlas-test-safety.js'
import { configureDns } from '../../scripts/configure-dns.js'
import { SOURCE_SEEDS, seedSources } from '../../scripts/seed-sources.js'

const hasMongo = Boolean(process.env.MONGODB_TEST_URI)
const describeMongo = hasMongo ? describe : describe.skip
const connector = { name: 'Example', sourceKey: 'rss:example', publisherName: 'Example Publisher', domain: 'example.com', connectorType: 'rss', accessMethod: 'rss', authorityTier: 'editorial', connectorConfig: { kind: 'rss', feedUrl: 'https://example.com/feed.xml', batchSize: 20 } }
let client
let context
let databaseName
let repository
let actor
let actorFence

beforeAll(async () => {
  if (!hasMongo) return
  configureDns()
  databaseName = databaseNameForSuite('sources')
  client = new MongoClient(process.env.MONGODB_TEST_URI)
  await client.connect()
  context = createMongoContext({ client, database: databaseName })
  await runAuthCoreMigration({ db: context.db })
  await runSourcesMigration({ db: context.db })
  repository = new MongoSourceRepository(context)
  const userId = new ObjectId()
  const sessionId = new ObjectId()
  const now = new Date()
  await context.db.collection('users').insertOne({ _id: userId, emailNormalized: 'source-admin@example.com', emailDisplay: 'source-admin@example.com', passwordHash: 'scrypt$16384$8$1$s:' + 's'.repeat(64), role: 'admin', status: 'active', topicPreferences: [], sessionVersion: 0, createdAt: now, updatedAt: now })
  await context.db.collection('sessions').insertOne({ _id: sessionId, tokenHash: 'a'.repeat(64), userId, userSessionVersion: 0, csrfSecretHash: 'c'.repeat(64), status: 'active', absoluteExpiresAt: new Date(now.getTime() + 86_400_000), expiresAt: new Date(now.getTime() + 86_400_000), lastSeenAt: now, createdAt: now })
  actor = { id: userId.toHexString(), role: 'admin' }
  actorFence = { userId: userId.toHexString(), sessionId: sessionId.toHexString(), sessionVersion: 0 }
})

afterAll(async () => {
  if (context) await dropTestDatabase({ context, expectedDatabase: databaseName })
  if (client) await client.close()
})

describeMongo('Step 3 Source Registry Mongo transaction boundary', () => {
  it('commits a draft and safe audit in one transaction', async () => {
    const source = createDraftSource(connector, { id: new ObjectId().toHexString(), now: new Date() })
    const audit = createSourceAuditEvent({ actor, action: 'source_created', targetId: source.id, changedFields: ['sourceKey', 'operationalStatus', 'policyVersion'], reasonCode: 'source_created', request: { serverRequestId: 'source-create-1' } })
    const saved = await repository.commitCreate({ source, audit, actorFence })
    expect(saved.id).toBe(source.id)
    expect(await context.db.collection('sources').countDocuments({ sourceKey: source.sourceKey })).toBe(1)
    expect(await context.db.collection('adminAuditLogs').findOne({ eventId: audit.eventId })).toEqual(expect.objectContaining({ targetType: 'source', action: 'source_created' }))
  })

  it('rolls back a source mutation when the audit is invalid', async () => {
    const source = createDraftSource({ ...connector, sourceKey: 'rss:rollback' }, { id: new ObjectId().toHexString(), now: new Date() })
    const audit = createSourceAuditEvent({ actor, action: 'source_created', targetId: source.id, changedFields: ['sourceKey', 'operationalStatus', 'policyVersion'], reasonCode: 'source_created', request: { serverRequestId: 'source-create-rollback' } })
    audit.reasonCode = 'free_form'
    await expect(repository.commitCreate({ source, audit, actorFence })).rejects.toThrow(/allowlisted|validation/i)
    expect(await context.db.collection('sources').findOne({ sourceKey: source.sourceKey })).toBeNull()
  })

  it('uses exact CAS so concurrent connector updates cannot drift marker and audit', async () => {
    const current = await repository.findSourceByKey('rss:example')
    const first = applySourceUpdate(current, { domain: 'first.example.com', connectorConfig: { kind: 'rss', feedUrl: 'https://first.example.com/feed.xml', batchSize: 30 }, reasonCode: 'source_configuration_changed' }, { now: new Date('2026-08-11T00:00:00.000Z') })
    const second = applySourceUpdate(current, { domain: 'second.example.com', connectorConfig: { kind: 'rss', feedUrl: 'https://second.example.com/feed.xml', batchSize: 40 }, reasonCode: 'source_configuration_changed' }, { now: new Date('2026-08-11T00:00:01.000Z') })
    const makeAudit = (result, requestId) => createSourceAuditEvent({ actor, action: 'source_configuration_updated', targetId: result.source.id, changedFields: result.changedFields, reasonCode: 'source_configuration_changed', request: { serverRequestId: requestId } })
    const outcomes = await Promise.allSettled([
      repository.commitReplacement({ source: first.source, expectedUpdatedAt: current.updatedAt, expectedPolicyVersion: current.policyVersion, audit: makeAudit(first, 'source-update-1'), actorFence }),
      repository.commitReplacement({ source: second.source, expectedUpdatedAt: current.updatedAt, expectedPolicyVersion: current.policyVersion, audit: makeAudit(second, 'source-update-2'), actorFence }),
    ])
    expect(outcomes.filter(({ status }) => status === 'fulfilled')).toHaveLength(1)
    expect(outcomes.filter(({ status }) => status === 'rejected')).toHaveLength(1)
    const saved = await repository.findSourceByKey('rss:example')
    expect(saved.policyVersion).toBe(2)
    expect(saved.reconciliation.requiredPolicyVersion).toBe(2)
    expect(await context.db.collection('adminAuditLogs').countDocuments({ action: 'source_configuration_updated', targetId: new ObjectId(saved.id) })).toBe(1)
    expect(await context.db.collection('adminAuditLogs').findOne({ action: 'source_configuration_updated', targetId: new ObjectId(saved.id) })).toEqual(expect.objectContaining({ changedFields: ['connectorConfig', 'domain'] }))
  })

  it('rejects a replacement whose updatedAt does not advance the CAS token', async () => {
    const current = await repository.findSourceByKey('rss:example')
    const audit = createSourceAuditEvent({ actor, action: 'source_configuration_updated', targetId: current.id, changedFields: ['name'], reasonCode: 'source_configuration_changed', request: { serverRequestId: 'non-advancing-cas' } })
    await expect(repository.commitReplacement({ source: { ...current, name: `${current.name} stale` }, expectedUpdatedAt: current.updatedAt, expectedPolicyVersion: current.policyVersion, audit, actorFence })).rejects.toMatchObject({ code: 'source_validation' })
  })

  it('seeds all connector families idempotently as unreviewed drafts', async () => {
    const first = await seedSources({ context, now: new Date('2026-08-12T00:00:00.000Z') })
    const second = await seedSources({ context, now: new Date('2026-08-12T00:00:01.000Z') })
    expect(first.filter(({ seeded }) => seeded)).toHaveLength(SOURCE_SEEDS.length)
    expect(second.filter(({ existing }) => existing)).toHaveLength(SOURCE_SEEDS.length)
    const seeded = await context.db.collection('sources').find({ sourceKey: { $in: SOURCE_SEEDS.map(({ sourceKey }) => sourceKey) } }).toArray()
    expect(seeded).toHaveLength(SOURCE_SEEDS.length)
    expect(seeded.every((source) => source.operationalStatus === 'draft' && source.licenseStatus === 'review-needed' && source.reviewedBy === null)).toBe(true)
  })

  it('paginates and filters the admin source list with an opaque validated cursor', async () => {
    const first = await repository.listSources({ limit: '2' })
    expect(first.sources).toHaveLength(2)
    expect(first.hasNext).toBe(true)
    expect(typeof first.nextCursor).toBe('string')
    const second = await repository.listSources({ limit: '2', cursor: first.nextCursor })
    expect(second.sources.map(({ id }) => id).some((id) => first.sources.some((source) => source.id === id))).toBe(false)
    const arxiv = await repository.listSources({ connectorType: 'arxiv', limit: '100' })
    expect(arxiv.sources.length).toBeGreaterThan(0)
    expect(arxiv.sources.every(({ connectorType }) => connectorType === 'arxiv')).toBe(true)
    await expect(repository.listSources({ cursor: 'not-a-valid-cursor' })).rejects.toMatchObject({ code: 'source_validation' })
  })

  it('stores hex-looking audit identities as ObjectIds and rejects policy-version or private-host drift at the DB boundary', async () => {
    const hexId = 'abcdefabcdefabcdefabcdef'
    const source = createDraftSource({ ...connector, sourceKey: 'rss:hex-audit' }, { id: hexId, now: new Date() })
    const audit = createSourceAuditEvent({ actor, action: 'source_created', targetId: source.id, changedFields: ['sourceKey', 'operationalStatus', 'policyVersion'], reasonCode: 'source_created', request: { serverRequestId: 'source-create-hex' } })
    await repository.commitCreate({ source, audit, actorFence })
    expect((await context.db.collection('adminAuditLogs').findOne({ eventId: audit.eventId })).targetId).toBeInstanceOf(ObjectId)

    const persisted = await context.db.collection('sources').findOne({ _id: new ObjectId(hexId) })
    await expect(context.db.collection('sources').replaceOne({ _id: persisted._id }, { ...persisted, policyVersion: 3 })).rejects.toThrow(/validation/i)
    await expect(context.db.collection('sources').replaceOne({ _id: persisted._id }, { ...persisted, mediaPolicy: { ...persisted.mediaPolicy, imageMode: 'remote-preview', allowedHosts: ['127.0.0.1'] } })).rejects.toThrow(/validation/i)
    await expect(context.db.collection('sources').replaceOne({ _id: persisted._id }, { ...persisted, mediaPolicy: { ...persisted.mediaPolicy, imageMode: 'remote-preview', allowedHosts: ['bad..example.com'] } })).rejects.toThrow(/validation/i)
    await expect(context.db.collection('sources').replaceOne({ _id: persisted._id }, { ...persisted, reconciliation: { status: 'completed', requiredPolicyVersion: 1, completedPolicyVersion: 2, requestedAt: new Date(), error: null } })).rejects.toThrow(/validation/i)
    await expect(context.db.collection('sources').replaceOne({ _id: persisted._id }, { ...persisted, reconciliation: { status: 'failed', requiredPolicyVersion: 1, completedPolicyVersion: null, requestedAt: new Date(), error: null } })).rejects.toThrow(/validation/i)

    const validConfigurationAudit = createSourceAuditEvent({ actor, action: 'source_configuration_updated', targetId: source.id, changedFields: ['domain'], reasonCode: 'source_configuration_changed', request: { serverRequestId: 'source-audit-validator-base' } })
    for (const [suffix, changedFields] of [['duplicates', ['domain', 'domain']], ['status-only', ['operationalStatus']], ['missing-transition', ['domain', 'operationalStatus']]]) {
      await expect(context.db.collection('adminAuditLogs').insertOne({ ...validConfigurationAudit, _id: new ObjectId(), eventId: `${validConfigurationAudit.eventId}:${suffix}`, changedFields })).rejects.toThrow(/validation/i)
    }
  })
})
