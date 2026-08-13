import { ObjectId } from 'mongodb'
import { describe, expect, it, vi } from 'vitest'
import { assertChatSessionsReady, createConfiguredQaService } from '../../../server/bootstrap/qa.js'
import { MongoChatRepository } from '../../../server/repositories/mongo/chat-repository.js'
import { CHAT_SESSION_COLLECTIONS, CHAT_SESSION_INDEXES } from '../../../scripts/migrations/chat-sessions.js'

function readyContext({ indexOverride = {} } = {}) {
  const collections = Object.entries(CHAT_SESSION_COLLECTIONS).map(([name, definition]) => ({
    name,
    options: { validator: definition.validator, validationLevel: 'strict', validationAction: 'error' },
  }))
  return {
    client: {},
    db: {
      listCollections: () => ({ toArray: async () => collections }),
      collection: (name) => ({
        indexes: async () => indexOverride[name] ?? CHAT_SESSION_INDEXES[name]?.map((index) => ({ name: index.name, key: index.key, ...(index.options ?? {}) })) ?? [],
      }),
    },
  }
}

describe('Step 10 Q&A bootstrap', () => {
  it('fails closed unless exact chat validators and indexes are deployed', async () => {
    await expect(assertChatSessionsReady(readyContext())).resolves.toBeUndefined()
    await expect(assertChatSessionsReady(readyContext({ indexOverride: { answerAttempts: [] } }))).rejects.toThrow(/indexes/i)
  })

  it('registers bounded answer-attempt cleanup only after readiness succeeds', async () => {
    const registered = []
    const maintenanceRegistry = { register: vi.fn((name, handler) => { registered.push([name, handler]); return handler }) }
    await createConfiguredQaService({
      context: readyContext(),
      maintenanceRegistry,
      providerRegistry: { routes: [{ routeId: 'zen-qa', provider: 'opencode-zen', capability: 'zdr-verified', enabled: true }], domains: [{}] },
      providerAdmission: { run: vi.fn() },
      providerAdapters: { llmProvider: { answer: vi.fn(), verifySupport: vi.fn() } },
    })
    expect(registered.map(([name]) => name)).toEqual(['purge-answer-attempts'])
  })

  it('fails closed when the maintenance cleanup registry is unavailable', async () => {
    const options = {
      context: readyContext(),
      providerRegistry: { routes: [{ routeId: 'zen-qa', provider: 'opencode-zen', capability: 'zdr-verified', enabled: true }], domains: [{}] },
      providerAdmission: { run: vi.fn() },
      providerAdapters: { llmProvider: { answer: vi.fn(), verifySupport: vi.fn() } },
    }

    await expect(createConfiguredQaService(options)).rejects.toThrow(/maintenance/i)
    await expect(createConfiguredQaService({ ...options, maintenanceRegistry: {} })).rejects.toThrow(/maintenance/i)
    await expect(createConfiguredQaService({
      ...options,
      maintenanceRegistry: { register: vi.fn(() => { throw new Error('Maintenance registration failed') }) },
    })).rejects.toThrow('Maintenance registration failed')
  })

  it('requires a real provider admission boundary and an eligible registered route', async () => {
    const base = {
      context: readyContext(),
      maintenanceRegistry: { register: vi.fn() },
      providerAdapters: { llmProvider: { answer: vi.fn(), verifySupport: vi.fn() } },
    }
    await expect(createConfiguredQaService({ ...base, providerRegistry: { routes: [{ routeId: 'zen-qa', provider: 'opencode-zen', capability: 'zdr-verified', enabled: true }] }, providerAdmission: {} })).rejects.toThrow(/admission/i)
    await expect(createConfiguredQaService({ ...base, providerRegistry: { routes: [] }, providerAdmission: { run: vi.fn() }, routes: { primary: 'injected' } })).rejects.toThrow(/route/i)
  })
})

describe('Step 10 answer-attempt retention', () => {
  it('selects and deletes at most one bounded page of expired opaque receipts', async () => {
    const first = new ObjectId()
    const second = new ObjectId()
    const third = new ObjectId()
    const toArray = vi.fn(async () => [{ _id: first }, { _id: second }, { _id: third }])
    const find = vi.fn(() => ({ sort() { return this }, hint() { return this }, project() { return this }, limit() { return this }, toArray }))
    const deleteMany = vi.fn(async () => ({ deletedCount: 2 }))
    const repository = new MongoChatRepository({ db: {}, client: {} })
    repository.answerAttempts = () => ({ find, deleteMany })
    const cutoff = new Date('2026-08-12T00:00:00.000Z')

    await expect(repository.purgeDueAnswerAttempts({ cutoff, limit: 2 })).resolves.toEqual({ inspected: 2, affected: 2, hasMore: true })
    expect(find).toHaveBeenCalledWith({ expiresAt: { $lte: cutoff } })
    expect(deleteMany).toHaveBeenCalledWith({ _id: { $in: [first, second] }, expiresAt: { $lte: cutoff } })
  })
})
