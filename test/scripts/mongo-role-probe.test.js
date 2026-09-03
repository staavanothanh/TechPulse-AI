import { describe, expect, it, vi } from 'vitest'
import {
  actionsForCollection,
  isAuthorizationDenied,
  probeAuditRoleCapabilities,
  probeCronObservabilityMaintenanceRoleCapabilities,
  probeHmacLifecycleRoleCapabilities,
  probeSourcesRoleCapabilities,
  probeCrossDatabaseTransactionCapabilities,
} from '../../scripts/mongo-role-probe.js'

function deniedError() {
  const error = new Error('not authorized')
  error.code = 13
  return error
}

function atlasDeniedError(identity = 'name', message = 'user is not allowed to do action update') {
  const error = new Error(message)
  error.code = 8000
  error[identity] = 'AtlasError'
  return error
}

function createClient(sessionBehaviors = []) {
  const sessions = []
  let attempt = 0
  const client = {
    startSession: vi.fn(() => {
      const behavior = sessionBehaviors[attempt] ?? {}
      attempt += 1
      if (behavior.startSessionError) throw behavior.startSessionError
      const session = {
        startTransaction: vi.fn(() => {
          if (behavior.startTransactionError) throw behavior.startTransactionError
        }),
        commitTransaction: vi.fn(async () => {
          if (behavior.commitError) throw behavior.commitError
        }),
        abortTransaction: vi.fn(async () => {
          if (behavior.abortError) throw behavior.abortError
        }),
        endSession: vi.fn(async () => {
          if (behavior.endError) throw behavior.endError
        }),
      }
      sessions.push(session)
      return session
    }),
  }
  return { client, sessions }
}

describe('Mongo audit role capability probe', () => {
  it('classifies Mongo code 13 and narrowly identified Atlas authorization denials', () => {
    expect(isAuthorizationDenied(deniedError())).toBe(true)
    expect(isAuthorizationDenied(atlasDeniedError('name'))).toBe(true)
    expect(isAuthorizationDenied(atlasDeniedError('codeName', 'not authorized to perform this operation'))).toBe(true)
  })

  it('proves cross-database commit and rollback with post-checks and idempotent cleanup', async () => {
    const persisted = { app: new Map(), governance: new Map() }
    const sessions = []
    const client = {
      startSession: vi.fn(() => {
        const session = {
          pending: [],
          startTransaction: vi.fn(),
          commitTransaction: vi.fn(async () => undefined),
          abortTransaction: vi.fn(async () => {
            for (const { store, key } of session.pending) store.delete(key)
            session.pending = []
          }),
          endSession: vi.fn(async () => undefined),
        }
        sessions.push(session)
        return session
      }),
    }
    const collection = (store) => ({
      insertOne: vi.fn(async (document, { session } = {}) => {
        const key = document.probeId
        store.set(key, document)
        session?.pending.push({ store, key })
        return { acknowledged: true, insertedId: document._id }
      }),
      findOne: vi.fn(async (filter) => store.get(filter.probeId) ?? null),
      deleteOne: vi.fn(async (filter) => {
        const key = filter.probeId
        const existed = store.delete(key)
        return { deletedCount: existed ? 1 : 0 }
      }),
    })
    const appCollection = collection(persisted.app)
    const governanceCollection = collection(persisted.governance)
    const db = { collection: vi.fn(() => appCollection) }
    const governanceDb = { collection: vi.fn(() => governanceCollection) }

    await expect(probeCrossDatabaseTransactionCapabilities({ client, db, governanceDb })).resolves.toEqual({
      committedTransaction: true,
      committedAppVisible: true,
      committedGovernanceVisible: true,
      committedPostCheck: true,
      committedCleanup: true,
      abortedTransaction: true,
      abortedAppAbsent: true,
      abortedGovernanceAbsent: true,
      abortedPostCheck: true,
    })
    expect(client.startSession).toHaveBeenCalledTimes(3)
    expect(sessions[0].commitTransaction).toHaveBeenCalledOnce()
    expect(sessions[1].commitTransaction).toHaveBeenCalledOnce()
    expect(sessions[2].abortTransaction).toHaveBeenCalledOnce()
    expect(db.collection).toHaveBeenCalledWith('runtimeCapabilityProbes')
    expect(governanceDb.collection).toHaveBeenCalledWith('runtimeCapabilityProbes')
    expect(db.collection).not.toHaveBeenCalledWith('takedownRequests')
    expect(governanceDb.collection).not.toHaveBeenCalledWith('governanceSuppressions')
    expect(persisted.app.size).toBe(0)
    expect(persisted.governance.size).toBe(0)
  })

  it('rejects unrelated Atlas, network, transaction, validation and arbitrary errors', () => {
    expect(isAuthorizationDenied(atlasDeniedError('name', 'request rate limit reached'))).toBe(false)
    expect(isAuthorizationDenied(atlasDeniedError('codeName', 'authorization service unavailable'))).toBe(false)
    expect(isAuthorizationDenied(Object.assign(new Error('socket closed'), { code: 'ECONNRESET' }))).toBe(false)
    expect(isAuthorizationDenied(Object.assign(new Error('transaction aborted'), { code: 251 }))).toBe(false)
    expect(isAuthorizationDenied(Object.assign(new Error('document validation failed'), { code: 121 }))).toBe(false)
    expect(isAuthorizationDenied(new Error('arbitrary failure'))).toBe(false)
  })

  it('includes database-wide Atlas privileges when evaluating a protected collection', () => {
    const actions = actionsForCollection([
      { resource: { db: '', collection: '' }, actions: ['find', 'insert', 'update'] },
      { resource: { db: 'techpulse_app', collection: 'adminAuditLogs' }, actions: ['remove'] },
      { resource: { db: 'other', collection: '' }, actions: ['dropDatabase'] },
    ], 'techpulse_app', 'adminAuditLogs')

    expect(actions).toEqual(new Set(['find', 'insert', 'update', 'remove']))
  })

  it('uses independent transactions to prove update and delete are each denied', async () => {
    const { client, sessions } = createClient()
    const collection = {
      insertOne: vi.fn(async () => undefined),
      findOne: vi.fn(async () => ({ eventId: 'role-probe' })),
      updateOne: vi.fn(async () => { throw deniedError() }),
      deleteOne: vi.fn(async () => { throw deniedError() }),
    }

    const result = await probeAuditRoleCapabilities({ client, db: { collection: vi.fn(() => collection) } })

    expect(result).toEqual({ inserted: true, findAllowed: true, updateDenied: true, deleteDenied: true })
    expect(client.startSession).toHaveBeenCalledTimes(3)
    expect(sessions.every((session) => session.abortTransaction.mock.calls.length === 1)).toBe(true)
  })

  it('allows append/read but independently denies update and delete for lifecycle snapshots', async () => {
    const { client, sessions } = createClient()
    const collection = {
      insertOne: vi.fn(async () => undefined),
      findOne: vi.fn(async () => ({ inventoryId: 'quota-hmac', revision: 1 })),
      updateOne: vi.fn(async () => { throw atlasDeniedError('name') }),
      deleteOne: vi.fn(async () => { throw atlasDeniedError('codeName') }),
    }

    const result = await probeHmacLifecycleRoleCapabilities({ client, db: { collection: vi.fn(() => collection) } })

    expect(result).toEqual({ inserted: true, findAllowed: true, updateDenied: true, deleteDenied: true })
    expect(client.startSession).toHaveBeenCalledTimes(3)
    expect(sessions.every((session) => session.abortTransaction.mock.calls.length === 1)).toBe(true)
  })

  it('does not claim denial when update and delete operations actually succeed', async () => {
    const { client } = createClient()
    const collection = {
      insertOne: vi.fn(async () => undefined),
      findOne: vi.fn(async () => ({ eventId: 'role-probe' })),
      updateOne: vi.fn(async () => ({ matchedCount: 0 })),
      deleteOne: vi.fn(async () => ({ deletedCount: 0 })),
    }

    await expect(probeAuditRoleCapabilities({ client, db: { collection: vi.fn(() => collection) } })).resolves.toEqual({
      inserted: true, findAllowed: true, updateDenied: false, deleteDenied: false,
    })
  })

  it('live-probes Source Registry find/insert/update/listIndexes and independently denies delete', async () => {
    const { client, sessions } = createClient()
    const collection = {
      listIndexes: vi.fn(() => ({ hasNext: vi.fn(async () => true) })),
      insertOne: vi.fn(async () => ({ acknowledged: true })),
      findOne: vi.fn(async () => ({ sourceKey: 'role-probe' })),
      updateOne: vi.fn(async () => ({ matchedCount: 1 })),
      deleteOne: vi.fn(async () => { throw atlasDeniedError('name') }),
    }
    const db = {
      listCollections: vi.fn(() => ({ hasNext: vi.fn(async () => true) })),
      collection: vi.fn(() => collection),
    }

    await expect(probeSourcesRoleCapabilities({ client, db })).resolves.toEqual({
      listCollectionsAllowed: true,
      listIndexesAllowed: true,
      inserted: true,
      findAllowed: true,
      updateAllowed: true,
      deleteDenied: true,
    })
    expect(client.startSession).toHaveBeenCalledTimes(3)
    expect(sessions.every((session) => session.abortTransaction.mock.calls.length === 1)).toBe(true)
  })

  it.each([
    ['startSession', { startSessionError: deniedError() }],
    ['startTransaction', { startTransactionError: deniedError() }],
    ['abortTransaction', { abortError: deniedError() }],
    ['endSession', { endError: deniedError() }],
  ])('fails closed when %s fails instead of treating it as mutation denial', async (_phase, behavior) => {
    const { client } = createClient([{}, behavior, {}])
    const collection = {
      insertOne: vi.fn(async () => undefined),
      findOne: vi.fn(async () => ({ eventId: 'role-probe' })),
      updateOne: vi.fn(async () => { throw deniedError() }),
      deleteOne: vi.fn(async () => { throw deniedError() }),
    }

    await expect(probeAuditRoleCapabilities({ client, db: { collection: vi.fn(() => collection) } })).resolves.toEqual({
      inserted: true, findAllowed: true, updateDenied: false, deleteDenied: true,
    })
  })
  it('probes cron deletion and audit field-unset capabilities without audit deletion', async () => {
    const collection = {
      indexes: vi.fn(async () => [{ name: '_id_' }]),
      find: vi.fn(() => ({
        project: () => ({
          limit: () => ({ toArray: vi.fn(async () => []) }),
        }),
      })),
    }
    const runtimeHello = { serviceId: 'cluster-1', setName: 'rs0', hosts: ['node-1'] }
    const maintenanceHello = { serviceId: 'cluster-1', setName: 'rs0', hosts: ['node-1'] }
    const maintenancePrivileges = [
      { resource: { db: 'app', collection: 'cronLifecycleEvents' }, actions: ['find', 'remove', 'listIndexes'] },
      { resource: { db: 'app', collection: 'adminAuditLogs' }, actions: ['find', 'update'] },
      { resource: { db: 'app', collection: '' }, actions: ['listCollections'] },
    ]
    const db = {
      collection: vi.fn(() => collection),
      listCollections: vi.fn(() => ({ toArray: vi.fn(async () => [{ name: 'cronLifecycleEvents' }]) })),
      command: vi.fn(async (command) => command.hello ? maintenanceHello : { authInfo: { authenticatedUsers: [{ user: 'maintenance-role', db: 'admin' }], authenticatedUserPrivileges: maintenancePrivileges } }),
    }
    const runtimeDb = {
      collection: vi.fn(),
      command: vi.fn(async (command) => command.hello ? runtimeHello : { authInfo: { authenticatedUsers: [{ user: 'runtime-role', db: 'admin' }] } }),
    }
    const client = { connect: vi.fn(async () => undefined), db: vi.fn(() => db), close: vi.fn(async () => undefined) }
    const clientFactory = vi.fn(() => client)

    await expect(probeCronObservabilityMaintenanceRoleCapabilities({
      environment: { MONGODB_MAINTENANCE_URI_ENV: 'MAINTENANCE_URI', MAINTENANCE_URI: 'mongodb://maintenance', RUNTIME_URI: 'mongodb://runtime' },
      database: 'app',
      runtimeUriEnv: 'RUNTIME_URI',
      runtimeDb,
      clientFactory,
    })).resolves.toEqual({
      configured: true,
      connected: true,
      clusterBound: true,
      distinctPrincipal: true,
      leastPrivilege: true,
      cronLifecycleFindAllowed: true,
      cronLifecycleRemoveAllowed: true,
      cronLifecycleListIndexesAllowed: true,
      cronLifecycleListCollectionsAllowed: true,
      auditFindAllowed: true,
      auditUpdateAllowed: true,
      auditRemoveDenied: true,
      auditDeleteDenied: true,
    })
    expect(client.close).toHaveBeenCalledOnce()
  })
  it.each([
    ['wrong cluster', { serviceId: 'cluster-2' }, [{ user: 'maintenance-role', db: 'admin' }], [
      { resource: { db: 'app', collection: 'cronLifecycleEvents' }, actions: ['find', 'remove', 'listIndexes'] },
      { resource: { db: 'app', collection: 'adminAuditLogs' }, actions: ['find', 'update'] },
      { resource: { db: 'app', collection: '' }, actions: ['listCollections'] },
    ]],
    ['same principal', { serviceId: 'cluster-1' }, [{ user: 'runtime-role', db: 'admin' }], [
      { resource: { db: 'app', collection: 'cronLifecycleEvents' }, actions: ['find', 'remove', 'listIndexes'] },
      { resource: { db: 'app', collection: 'adminAuditLogs' }, actions: ['find', 'update'] },
      { resource: { db: 'app', collection: '' }, actions: ['listCollections'] },
    ]],
    ['extra privilege', { serviceId: 'cluster-1' }, [{ user: 'maintenance-role', db: 'admin' }], [
      { resource: { db: 'app', collection: 'cronLifecycleEvents' }, actions: ['find', 'remove', 'listIndexes'] },
      { resource: { db: 'app', collection: 'adminAuditLogs' }, actions: ['find', 'update', 'remove'] },
      { resource: { db: 'app', collection: '' }, actions: ['listCollections'] },
    ]],
    ['cross database privilege', { serviceId: 'cluster-1' }, [{ user: 'maintenance-role', db: 'admin' }], [
      { resource: { db: 'app', collection: 'cronLifecycleEvents' }, actions: ['find', 'remove', 'listIndexes'] },
      { resource: { db: 'app', collection: 'adminAuditLogs' }, actions: ['find', 'update'] },
      { resource: { db: 'app', collection: '' }, actions: ['listCollections'] },
      { resource: { db: 'other', collection: 'jobs' }, actions: ['find'] },
    ]],
  ])('fails closed for %s maintenance identity binding', async (_name, maintenanceHello, maintenanceUsers, maintenancePrivileges) => {
    const db = {
      collection: vi.fn(),
      command: vi.fn(async (command) => command.hello ? maintenanceHello : { authInfo: { authenticatedUsers: maintenanceUsers, authenticatedUserPrivileges: maintenancePrivileges } }),
    }
    const runtimeDb = {
      collection: vi.fn(),
      command: vi.fn(async (command) => command.hello ? { serviceId: 'cluster-1' } : { authInfo: { authenticatedUsers: [{ user: 'runtime-role', db: 'admin' }] } }),
    }
    const client = { connect: vi.fn(async () => undefined), db: vi.fn(() => db), close: vi.fn(async () => undefined) }
    const result = await probeCronObservabilityMaintenanceRoleCapabilities({
      environment: { MONGODB_MAINTENANCE_URI_ENV: 'MAINTENANCE_URI', MAINTENANCE_URI: 'mongodb://maintenance' },
      database: 'app', runtimeDb, clientFactory: () => client,
    })
    expect(result).toMatchObject({ configured: true, connected: true, leastPrivilege: !['extra privilege', 'cross database privilege'].includes(_name) })
    expect(result.cronLifecycleFindAllowed).toBe(false)
  })

  it('fails closed when the maintenance credential is absent or overlaps runtime', async () => {
    const clientFactory = vi.fn()
    const runtimeDb = { command: vi.fn(), collection: vi.fn() }
    const environment = { MONGODB_MAINTENANCE_URI_ENV: 'MAINTENANCE_URI', MAINTENANCE_URI: 'mongodb://same' }

    await expect(probeCronObservabilityMaintenanceRoleCapabilities({ environment: {}, database: 'app', clientFactory })).resolves.toMatchObject({ configured: false, connected: false })
    await expect(probeCronObservabilityMaintenanceRoleCapabilities({
      environment: { ...environment, RUNTIME_URI: 'mongodb://same' }, database: 'app', runtimeUriEnv: 'RUNTIME_URI', runtimeDb, clientFactory,
    })).resolves.toMatchObject({ configured: false, connected: false })
    const throwingFactory = vi.fn(() => { throw new Error('invalid URI') })
    await expect(probeCronObservabilityMaintenanceRoleCapabilities({ environment, database: 'app', runtimeDb, clientFactory: throwingFactory })).resolves.toMatchObject({ configured: true, connected: false })
    expect(throwingFactory).toHaveBeenCalledOnce()
    expect(clientFactory).not.toHaveBeenCalled()
  })
})
