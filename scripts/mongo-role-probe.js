import { randomUUID } from 'node:crypto'
import { MongoClient, ObjectId } from 'mongodb'
import { RUNTIME_CAPABILITY_PROBE_COLLECTION } from './migrations/governance-capability-probes.js'

export function actionsForCollection(privileges, database, collection) {
  const scoped = privileges.filter((privilege) => {
    const resource = privilege.resource ?? {}
    return [database, ''].includes(resource.db) && [collection, ''].includes(resource.collection ?? '')
  })
  return new Set(scoped.flatMap((privilege) => privilege.actions ?? []))
}
function principalSet(users) {
  return new Set((Array.isArray(users) ? users : []).flatMap((entry) => {
    if (!entry?.user || !entry?.db) return []
    return [`${String(entry.db)}:${String(entry.user)}`]
  }))
}

function clusterIdentity(hello) {
  if (hello?.serviceId) return `service:${String(hello.serviceId)}`
  const hosts = Array.isArray(hello?.hosts) ? [...hello.hosts].map(String).sort().join(',') : ''
  const setName = hello?.setName ? String(hello.setName) : ''
  const primary = hello?.primary ? String(hello.primary) : ''
  if (!setName && !hosts && !primary) return null
  return `set:${setName}|hosts:${hosts}|primary:${primary}`
}

function hasOnlyAllowedPrivileges(privileges, database) {
  const allowed = new Map([
    ['cronLifecycleEvents', new Set(['find', 'remove', 'listIndexes', 'listCollections'])],
    ['adminAuditLogs', new Set(['find', 'update'])],
  ])
  const allPrivileges = Array.isArray(privileges) ? privileges : []
  if (allPrivileges.length === 0) return false
  return allPrivileges.every((privilege) => {
    const resource = privilege.resource ?? {}
    const actions = privilege.actions ?? []
    if (resource.db !== database) return false
    if (resource.collection === '') return actions.every((action) => action === 'listCollections')
    if (!allowed.has(resource.collection)) return false
    return actions.every((action) => allowed.get(resource.collection).has(action))
  })
}

const MAINTENANCE_CLIENT_OPTIONS = Object.freeze({ maxPoolSize: 2, serverSelectionTimeoutMS: 5_000 })
const ENV_NAME_PATTERN = /^[A-Z][A-Z0-9_]{1,127}$/

export async function probeCronObservabilityMaintenanceRoleCapabilities({ environment = process.env, database, runtimeUriEnv, runtimeDb, maintenanceClient, closeClient = true, clientFactory = (uri) => new MongoClient(uri, MAINTENANCE_CLIENT_OPTIONS) } = {}) {
  const failed = Object.freeze({ configured: false, connected: false, clusterBound: false, distinctPrincipal: false, leastPrivilege: false, cronLifecycleFindAllowed: false, cronLifecycleRemoveAllowed: false, cronLifecycleListIndexesAllowed: false, cronLifecycleListCollectionsAllowed: false, auditFindAllowed: false, auditUpdateAllowed: false, auditRemoveDenied: false, auditDeleteDenied: false })
  const maintenanceUriEnv = environment?.MONGODB_MAINTENANCE_URI_ENV
  const maintenanceUri = ENV_NAME_PATTERN.test(String(maintenanceUriEnv ?? '')) ? environment[maintenanceUriEnv] : undefined
  if (typeof maintenanceUri !== 'string' || maintenanceUri.trim() === '' || typeof database !== 'string' || database.trim() === '') return failed
  const runtimeUri = ENV_NAME_PATTERN.test(String(runtimeUriEnv ?? '')) ? environment[runtimeUriEnv] : undefined
  if (typeof runtimeUri === 'string' && runtimeUri.trim() !== '' && runtimeUri === maintenanceUri) return failed
  if (!runtimeDb || typeof runtimeDb.command !== 'function' || typeof runtimeDb.collection !== 'function') return failed
  let client
  let connected = false
  try {
    client = maintenanceClient ?? clientFactory(maintenanceUri)
    if (!client || typeof client.connect !== 'function') return { ...failed, configured: true }
    if (!maintenanceClient) await client.connect()
    connected = true
    const db = maintenanceClient?.db?.(database) ?? client.db(database)
    const [runtimeHello, runtimeStatus, maintenanceHello, maintenanceStatus] = await Promise.all([
      runtimeDb.command({ hello: 1 }),
      runtimeDb.command({ connectionStatus: 1, showPrivileges: true }),
      db.command({ hello: 1 }),
      db.command({ connectionStatus: 1, showPrivileges: true }),
    ])
    const runtimeUsers = principalSet(runtimeStatus?.authInfo?.authenticatedUsers)
    const maintenanceUsers = principalSet(maintenanceStatus?.authInfo?.authenticatedUsers)
    const clusterBound = clusterIdentity(runtimeHello) !== null && clusterIdentity(runtimeHello) === clusterIdentity(maintenanceHello)
    const distinctPrincipal = runtimeUsers.size > 0 && maintenanceUsers.size > 0 && [...runtimeUsers].every((user) => !maintenanceUsers.has(user))
    const maintenancePrivileges = maintenanceStatus?.authInfo?.authenticatedUserPrivileges ?? []
    const leastPrivilege = hasOnlyAllowedPrivileges(maintenancePrivileges, database)
    if (!clusterBound || !distinctPrincipal || !leastPrivilege) return { ...failed, configured: true, connected: true, clusterBound, distinctPrincipal, leastPrivilege }
    const cronLifecycleCollection = db.collection('cronLifecycleEvents')
    const auditCollection = db.collection('adminAuditLogs')
    const [collections, indexes] = await Promise.all([
      db.listCollections({ name: 'cronLifecycleEvents' }, { nameOnly: true }).toArray(),
      cronLifecycleCollection.indexes(),
    ])
    await cronLifecycleCollection.find({ eventId: '0'.repeat(64) }).project({ _id: 1 }).limit(1).toArray()
    await auditCollection.find({ eventId: '0'.repeat(64) }).project({ _id: 1 }).limit(1).toArray()
    const lifecycleActions = actionsForCollection(maintenancePrivileges, database, 'cronLifecycleEvents')
    const auditActions = actionsForCollection(maintenancePrivileges, database, 'adminAuditLogs')
    return {
      configured: true,
      connected: true,
      clusterBound,
      distinctPrincipal,
      leastPrivilege,
      cronLifecycleFindAllowed: lifecycleActions.has('find'),
      cronLifecycleRemoveAllowed: lifecycleActions.has('remove'),
      cronLifecycleListIndexesAllowed: lifecycleActions.has('listIndexes') && Array.isArray(indexes),
      cronLifecycleListCollectionsAllowed: lifecycleActions.has('listCollections') && Array.isArray(collections),
      auditFindAllowed: auditActions.has('find'),
      auditUpdateAllowed: auditActions.has('update'),
      auditRemoveDenied: !auditActions.has('remove'),
      auditDeleteDenied: !auditActions.has('delete'),
    }
  } catch {
    return { ...failed, configured: true, connected }
  } finally {
    if (closeClient && !maintenanceClient) {
      try { await client?.close?.() } catch { /* best-effort cleanup */ }
    }
  }
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

async function runProbeTransaction(client, work, { commit = false } = {}) {
  let session
  let transactionStarted = false
  let transactionCommitted = false
  let transactionAborted = false
  let transactionAbortAttempted = false
  let sessionHealthy = true
  let operationFailed = false
  let operationError
  let value
  try {
    session = client.startSession()
  } catch {
    return { transactionStarted, transactionCommitted, transactionAborted, sessionHealthy: false, operationFailed }
  }
  try {
    await session.startTransaction()
    transactionStarted = true
    value = await work(session)
    if (commit) {
      await session.commitTransaction()
      transactionCommitted = true
    } else {
      transactionAbortAttempted = true
      await session.abortTransaction()
      transactionAborted = true
    }
  } catch (error) {
    operationError = error
    operationFailed = true
    if (!transactionStarted) {
      // A session/transaction setup failure is not evidence that the
      // requested mutation was denied.  Keep the role gate fail-closed.
      operationFailed = false
      operationError = undefined
    }
    if (transactionStarted && !transactionAbortAttempted && !transactionCommitted && !transactionAborted) {
      transactionAbortAttempted = true
      try { await session.abortTransaction(); transactionAborted = true } catch { sessionHealthy = false }
    }
  } finally {
    try { await session.endSession() } catch { sessionHealthy = false }
  }
  return { transactionStarted, transactionCommitted, transactionAborted, transactionAbortAttempted, sessionHealthy, operationFailed, operationError, value }
}

/*
 * Probe collections are dedicated to this verification and grant the runtime
 * role the narrow remove action. Cleanup is still part of the capability gate:
 * a committed probe is not verified while either synthetic document remains.
 * Repeating delete-by-probeId is safe when a previous cleanup was interrupted.
 */
async function cleanupCrossDatabaseProbe({ client, appCollection, governanceCollection, probeId }) {
  const outcome = await runProbeTransaction(client, async (session) => {
    const appResult = await appCollection.deleteOne({ probeId }, { session })
    const governanceResult = await governanceCollection.deleteOne({ probeId }, { session })
    return { appDeleted: appResult?.deletedCount === 1 || appResult?.deletedCount === 0, governanceDeleted: governanceResult?.deletedCount === 1 || governanceResult?.deletedCount === 0 }
  }, { commit: true })
  return outcome.sessionHealthy && !outcome.operationFailed && outcome.transactionCommitted && outcome.value?.appDeleted === true && outcome.value?.governanceDeleted === true
}

function crossDatabaseProbeDocuments(probeKind) {
  const now = new Date()
  const probeId = `runtime-capability:${randomUUID()}`
  const document = { _id: new ObjectId(), probeId, probeKind, expiresAt: new Date(now.getTime() + 5 * 60 * 1000), createdAt: now }
  return {
    app: { ...document },
    governance: { ...document, _id: new ObjectId() },
  }
}

async function findProbeDocument(collection, filter) {
  try {
    return await collection.findOne(filter, { projection: { _id: 1 } })
  } catch {
    return null
  }
}

export async function probeCrossDatabaseTransactionCapabilities({ client, db, governanceDb } = {}) {
  if (!client?.startSession || !db?.collection || !governanceDb?.collection) {
    return {
      committedTransaction: false,
      committedAppVisible: false,
      committedGovernanceVisible: false,
      committedPostCheck: false,
      committedCleanup: false,
      abortedTransaction: false,
      abortedAppAbsent: false,
      abortedGovernanceAbsent: false,
      abortedPostCheck: false,
    }
  }
  const appCollection = db.collection(RUNTIME_CAPABILITY_PROBE_COLLECTION)
  const governanceCollection = governanceDb.collection(RUNTIME_CAPABILITY_PROBE_COLLECTION)
  const committedDocuments = crossDatabaseProbeDocuments('commit')
  const committed = await runProbeTransaction(client, async (session) => {
    await appCollection.insertOne(committedDocuments.app, { session })
    await governanceCollection.insertOne(committedDocuments.governance, { session })
    return true
  }, { commit: true })
  const committedApp = committed.transactionCommitted && !committed.operationFailed ? await findProbeDocument(appCollection, { probeId: committedDocuments.app.probeId }) : null
  const committedGovernance = committed.transactionCommitted && !committed.operationFailed ? await findProbeDocument(governanceCollection, { probeId: committedDocuments.governance.probeId }) : null
  const committedAppVisible = Boolean(committedApp)
  const committedGovernanceVisible = Boolean(committedGovernance)
  const committedPostCheck = committedAppVisible && committedGovernanceVisible
  const committedCleanup = await cleanupCrossDatabaseProbe({ client, appCollection, governanceCollection, probeId: committedDocuments.app.probeId })

  const abortedDocuments = crossDatabaseProbeDocuments('abort')
  const aborted = await runProbeTransaction(client, async (session) => {
    await appCollection.insertOne(abortedDocuments.app, { session })
    await governanceCollection.insertOne(abortedDocuments.governance, { session })
    return true
  })
  const abortedApp = await findProbeDocument(appCollection, { probeId: abortedDocuments.app.probeId })
  const abortedGovernance = await findProbeDocument(governanceCollection, { probeId: abortedDocuments.governance.probeId })
  const abortedAppAbsent = !abortedApp
  const abortedGovernanceAbsent = !abortedGovernance
  return {
    committedTransaction: committed.sessionHealthy && !committed.operationFailed && committed.transactionCommitted,
    committedAppVisible,
    committedGovernanceVisible,
    committedPostCheck,
    committedCleanup,
    abortedTransaction: aborted.sessionHealthy && !aborted.operationFailed && aborted.transactionAborted,
    abortedAppAbsent,
    abortedGovernanceAbsent,
    abortedPostCheck: abortedAppAbsent && abortedGovernanceAbsent,
  }
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

export async function probeGovernanceRoleCapabilities({ client, db, governanceDb } = {}) {
  if (!client?.startSession || !db?.collection || !governanceDb?.collection) throw new Error('Mongo client and governance databases are required')
  const now = new Date()
  const requestId = new ObjectId()
  const takedown = {
    _id: requestId, status: 'received', requesterName: 'Role probe', requesterContact: 'probe@example.com', targetType: 'article', targetIds: [new ObjectId()], reason: 'Role probe only', requestedScope: ['metadata'],
    decisionReasonCode: null, completion: { hidden: false, metadataRemoved: false, mediaMetadataRemoved: false, summaryRemoved: false, embeddingRemoved: false, historicalChatCitationsRedacted: false }, completedAt: null, createdAt: now, updatedAt: now,
  }
  const suppression = {
    _id: new ObjectId(), eventId: `role-probe:${requestId.toHexString()}`, kind: 'takedown', requestId, targetType: 'article', targetIds: takedown.targetIds, requestedScope: ['metadata'], effectiveAt: now, payloadDigest: 'a'.repeat(64), signatureKeyVersion: 1, signature: 'probe', createdAt: now,
  }
  const outcome = await runProbeTransaction(client, async (session) => {
    await db.collection('takedownRequests').insertOne(takedown, { session })
    await governanceDb.collection('governanceSuppressions').insertOne(suppression, { session })
    const appFound = await db.collection('takedownRequests').findOne({ _id: requestId }, { session, projection: { _id: 1 } })
    const governanceFound = await governanceDb.collection('governanceSuppressions').findOne({ _id: suppression._id }, { session, projection: { _id: 1 } })
    const workflowUpdate = await db.collection('takedownRequests').updateOne({ _id: requestId, status: 'received' }, { $set: { status: 'reviewing', updatedAt: now } }, { session })
    return { appWrite: Boolean(appFound), governanceWrite: Boolean(governanceFound), workflowUpdate: workflowUpdate.matchedCount === 1 }
  })
  const suppressionUpdateDenied = await deniedMutationAfterSetup(client, (session) => governanceDb.collection('governanceSuppressions').insertOne(suppression, { session }), (session) => governanceDb.collection('governanceSuppressions').updateOne({ _id: suppression._id }, { $set: { signature: 'denied' } }, { session }))
  const suppressionDeleteDenied = await deniedMutationAfterSetup(client, (session) => governanceDb.collection('governanceSuppressions').insertOne(suppression, { session }), (session) => governanceDb.collection('governanceSuppressions').deleteOne({ _id: suppression._id }, { session }))
  const auditEvent = `governance-role-probe:${randomUUID()}`
  const auditOutcome = await runProbeTransaction(client, async (session) => {
    const collection = db.collection('adminAuditLogs')
    await collection.insertOne(probeDocument(auditEvent), { session })
    return Boolean(await collection.findOne({ eventId: auditEvent }, { session, projection: { _id: 1 } }))
  })
  const auditUpdateDenied = await deniedMutationAfterSetup(client, (session) => db.collection('adminAuditLogs').insertOne(probeDocument(auditEvent), { session }), (session) => db.collection('adminAuditLogs').updateOne({ eventId: auditEvent }, { $set: { result: 'failed' } }, { session }))
  const auditDeleteDenied = await deniedMutationAfterSetup(client, (session) => db.collection('adminAuditLogs').insertOne(probeDocument(auditEvent), { session }), (session) => db.collection('adminAuditLogs').deleteOne({ eventId: auditEvent }, { session }))
  return {
    transaction: outcome.sessionHealthy && !outcome.operationFailed,
    appWrite: outcome.value?.appWrite === true,
    workflowUpdate: outcome.value?.workflowUpdate === true,
    governanceWrite: outcome.value?.governanceWrite === true,
    suppressionUpdateDenied,
    suppressionDeleteDenied,
    auditInsert: auditOutcome.sessionHealthy && !auditOutcome.operationFailed && auditOutcome.value === true,
    auditUpdateDenied,
    auditDeleteDenied,
    rolledBack: outcome.sessionHealthy && auditOutcome.sessionHealthy,
  }
}
