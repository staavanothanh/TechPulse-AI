import { randomUUID } from 'node:crypto'
import { ObjectId } from 'mongodb'

export function actionsForCollection(privileges, database, collection) {
  const scoped = privileges.filter((privilege) => {
    const resource = privilege.resource ?? {}
    return [database, ''].includes(resource.db) && [collection, ''].includes(resource.collection ?? '')
  })
  return new Set(scoped.flatMap((privilege) => privilege.actions ?? []))
}

function probeDocument(eventId) {
  const targetId = new ObjectId()
  return {
    _id: new ObjectId(),
    eventId,
    actorType: 'system-worker',
    actorId: targetId,
    action: 'user_logged_in',
    targetType: 'user',
    targetId,
    changedFields: [],
    reasonCode: 'user_login',
    requestId: eventId,
    result: 'pending',
    createdAt: new Date(),
  }
}

function lifecycleProbeDocument() {
  const now = new Date()
  return {
    _id: new ObjectId(),
    inventoryId: 'quota-hmac',
    revision: 2_000_000_000,
    previousRevision: 1_999_999_999,
    previousSnapshotHash: '0'.repeat(64),
    snapshotHash: 'a'.repeat(64),
    currentVersion: 2_000_000_000,
    versions: [{ version: 2_000_000_000, state: 'current', keyFingerprint: 'b'.repeat(64), firstObservedAt: now }],
    recordedAt: now,
  }
}

function sourceProbeDocument() {
  const now = new Date()
  return {
    _id: new ObjectId(),
    name: 'Role probe source',
    sourceKey: `role-probe:${randomUUID()}`,
    publisherName: 'Role probe publisher',
    domain: 'example.com',
    connectorType: 'rss',
    accessMethod: 'rss',
    authorityTier: 'editorial',
    connectorConfig: { kind: 'rss', feedUrl: 'https://example.com/feed.xml', batchSize: 1 },
    operationalStatus: 'draft',
    licenseStatus: 'review-needed',
    llmInputScope: 'none',
    storageScope: { metadata: false, excerpt: false, summary: false, embedding: false },
    mediaPolicy: { imageMode: 'none', videoMode: 'none', allowedHosts: [], attributionRequired: false, evidenceNote: null },
    attributionRequired: false,
    policyVersion: 1,
    reconciliation: { status: 'idle', requiredPolicyVersion: 1, completedPolicyVersion: null, requestedAt: null, error: null },
    technicalCheck: { status: 'not-run', checkedAt: null, contentType: null, resolvedHost: null, sampleCount: null, error: null },
    health: { lastIngestSucceededAt: null, lastIngestFailedAt: null, consecutiveFailures: 0, lastError: null },
    createdAt: now,
    updatedAt: now,
  }
}

export function isAuthorizationDenied(error) {
  if (error?.code === 13) return true
  if (error?.code !== 8000 || (error?.name !== 'AtlasError' && error?.codeName !== 'AtlasError')) return false
  const message = `${error?.message ?? ''} ${error?.errmsg ?? ''}`
  return /\bnot authorized\b|\bunauthorized\b|\bnot allowed to (?:do|perform|execute)\b|\binsufficient (?:permissions?|privileges?)\b|\bpermission denied\b/i.test(message)
}

async function closeProbeSession(session) {
  let healthy = true
  try { await session.abortTransaction() } catch { healthy = false }
  try { await session.endSession() } catch { healthy = false }
  return healthy
}

async function runProbeTransaction(client, work) {
  let session
  try {
    session = client.startSession()
  } catch {
    return { sessionHealthy: false, operationFailed: false }
  }
  try {
    await session.startTransaction()
  } catch {
    await closeProbeSession(session)
    return { sessionHealthy: false, operationFailed: false }
  }
  let value
  let operationError
  let operationFailed = false
  try {
    value = await work(session)
  } catch (error) {
    operationError = error
    operationFailed = true
  }
  const sessionHealthy = await closeProbeSession(session)
  return { sessionHealthy, operationFailed, operationError, value }
}

async function deniedMutation(client, work) {
  const outcome = await runProbeTransaction(client, work)
  return outcome.sessionHealthy && outcome.operationFailed && isAuthorizationDenied(outcome.operationError)
}

async function deniedMutationAfterSetup(client, setup, mutation) {
  const outcome = await runProbeTransaction(client, async (session) => {
    await setup(session)
    try {
      await mutation(session)
      return { mutationDenied: false }
    } catch (error) {
      return { mutationDenied: isAuthorizationDenied(error) }
    }
  })
  return outcome.sessionHealthy && !outcome.operationFailed && outcome.value?.mutationDenied === true
}

export async function probeAuditRoleCapabilities({ client, db } = {}) {
  if (!client?.startSession || !db?.collection) throw new Error('Mongo client and database are required')
  const collection = db.collection('adminAuditLogs')
  const eventId = `role-probe:${randomUUID()}`
  const availability = await runProbeTransaction(client, async (session) => {
    await collection.insertOne(probeDocument(eventId), { session })
    return { inserted: true, findAllowed: Boolean(await collection.findOne({ eventId }, { session })) }
  })
  if (!availability.sessionHealthy || availability.operationFailed) {
    return { inserted: false, findAllowed: false, updateDenied: false, deleteDenied: false }
  }
  const updateDenied = await deniedMutation(client, (session) => collection.updateOne({ eventId }, { $set: { result: 'failed' } }, { session }))
  const deleteDenied = await deniedMutation(client, (session) => collection.deleteOne({ eventId }, { session }))
  return { ...availability.value, updateDenied, deleteDenied }
}

export async function probeHmacLifecycleRoleCapabilities({ client, db } = {}) {
  if (!client?.startSession || !db?.collection) throw new Error('Mongo client and database are required')
  const collection = db.collection('hmacKeyLifecycleSnapshots')
  const document = lifecycleProbeDocument()
  const availability = await runProbeTransaction(client, async (session) => {
    await collection.insertOne(document, { session })
    return { inserted: true, findAllowed: Boolean(await collection.findOne({ _id: document._id }, { session })) }
  })
  if (!availability.sessionHealthy || availability.operationFailed) {
    return { inserted: false, findAllowed: false, updateDenied: false, deleteDenied: false }
  }
  const updateDenied = await deniedMutation(client, (session) => collection.updateOne({ _id: document._id }, { $set: { snapshotHash: 'c'.repeat(64) } }, { session }))
  const deleteDenied = await deniedMutation(client, (session) => collection.deleteOne({ _id: document._id }, { session }))
  return { ...availability.value, updateDenied, deleteDenied }
}

export async function probeSourcesRoleCapabilities({ client, db } = {}) {
  if (!client?.startSession || !db?.collection || !db?.listCollections) throw new Error('Mongo client and database are required')
  const collection = db.collection('sources')
  let listCollectionsAllowed = false
  let listIndexesAllowed = false
  try { listCollectionsAllowed = Boolean(await db.listCollections({ name: 'sources' }, { nameOnly: true }).hasNext()) } catch { /* fail closed */ }
  try { listIndexesAllowed = Boolean(await collection.listIndexes().hasNext()) } catch { /* fail closed */ }

  const availabilityDocument = sourceProbeDocument()
  const availability = await runProbeTransaction(client, async (session) => {
    await collection.insertOne(availabilityDocument, { session })
    return { inserted: true, findAllowed: Boolean(await collection.findOne({ _id: availabilityDocument._id }, { session })) }
  })
  const updateDocument = sourceProbeDocument()
  const update = await runProbeTransaction(client, async (session) => {
    await collection.insertOne(updateDocument, { session })
    const result = await collection.updateOne({ _id: updateDocument._id }, { $set: { name: 'Updated role probe source', updatedAt: new Date(updateDocument.updatedAt.getTime() + 1) } }, { session })
    return result.matchedCount === 1
  })
  const deleteDocument = sourceProbeDocument()
  const deleteDenied = await deniedMutationAfterSetup(
    client,
    (session) => collection.insertOne(deleteDocument, { session }),
    (session) => collection.deleteOne({ _id: deleteDocument._id }, { session }),
  )
  return {
    listCollectionsAllowed,
    listIndexesAllowed,
    inserted: availability.sessionHealthy && !availability.operationFailed && availability.value?.inserted === true,
    findAllowed: availability.sessionHealthy && !availability.operationFailed && availability.value?.findAllowed === true,
    updateAllowed: update.sessionHealthy && !update.operationFailed && update.value === true,
    deleteDenied,
  }
}
