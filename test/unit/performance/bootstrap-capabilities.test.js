import { describe, expect, it, vi } from 'vitest'
import { createApp } from '../../../server/app.js'
import {
  createLazyRuntimeOptions,
  createSingleFlightCapability,
} from '../../../server/bootstrap/lazy-runtime.js'

async function listen(app) {
  const server = await new Promise((resolve) => {
    const instance = app.listen(0, () => resolve(instance))
  })
  return {
    origin: `http://127.0.0.1:${server.address().port}`,
    close: () => new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve()))),
  }
}

function configuredAuth() {
  return {
    authService: { authenticate: vi.fn(), verifyCsrf: vi.fn() },
    authRepository: {},
    context: { client: {}, db: {} },
    quotaKeyring: {},
    governanceKeyring: {},
    runtime: { providerRegistry: {}, origins: [], internalMachineSecretEnv: 'INTERNAL_MACHINE_SECRET' },
    rateLimitAdmission: {},
  }
}

describe('lazy bootstrap capabilities', () => {
  it('shares one in-flight load across callers', async () => {
    let release
    const load = vi.fn(() => new Promise((resolve) => { release = resolve }))
    const capability = createSingleFlightCapability({ name: 'content', load, wait: vi.fn() })

    const first = capability()
    const second = capability()
    expect(load).toHaveBeenCalledTimes(1)

    release({ ready: true })
    await expect(Promise.all([first, second])).resolves.toEqual([{ ready: true }, { ready: true }])
    await expect(capability()).resolves.toEqual({ ready: true })
    expect(load).toHaveBeenCalledTimes(1)
  })

  it('bounds each flight to two attempts and resets a rejected flight', async () => {
    const dependencyError = new Error('mongodb://user:secret@private')
    const load = vi.fn()
      .mockRejectedValueOnce(dependencyError)
      .mockRejectedValueOnce(dependencyError)
      .mockResolvedValueOnce({ ready: true })
    const wait = vi.fn(async () => undefined)
    const capability = createSingleFlightCapability({ name: 'content', load, maxAttempts: 2, wait })

    await expect(capability()).rejects.toBe(dependencyError)
    expect(load).toHaveBeenCalledTimes(2)
    expect(wait).toHaveBeenCalledTimes(1)

    await expect(capability()).resolves.toEqual({ ready: true })
    expect(load).toHaveBeenCalledTimes(3)
  })

  it('does not multiply retry attempts when a dependency exhausts', async () => {
    const factories = {
      common: vi.fn(async () => { throw new Error('database unavailable') }),
      content: vi.fn(), sources: vi.fn(), jobs: vi.fn(), indexing: vi.fn(), qa: vi.fn(), governance: vi.fn(),
    }
    const options = createLazyRuntimeOptions({ factories, maxAttempts: 2, wait: vi.fn(async () => undefined), logError: vi.fn() })

    await expect(options.articleService.list({})).rejects.toMatchObject({ status: 503, code: 'service_unavailable' })
    expect(factories.common).toHaveBeenCalledTimes(2)
    expect(factories.content).not.toHaveBeenCalled()
  })

  it('loads only auth and content for an article read', async () => {
    const common = configuredAuth()
    const factories = {
      common: vi.fn(async () => common),
      content: vi.fn(async () => ({ articleService: { list: vi.fn(async () => ({ articles: [] })) } })),
      sources: vi.fn(),
      jobs: vi.fn(),
      indexing: vi.fn(),
      qa: vi.fn(),
      governance: vi.fn(),
    }
    const options = createLazyRuntimeOptions({ factories, wait: vi.fn(async () => undefined) })

    await expect(options.articleService.list({ auth: { user: { id: 'user-1' } }, query: {} })).resolves.toEqual({ articles: [] })
    expect(factories.common).toHaveBeenCalledTimes(1)
    expect(factories.content).toHaveBeenCalledTimes(1)
    expect(factories.jobs).not.toHaveBeenCalled()
    expect(factories.indexing).not.toHaveBeenCalled()
    expect(factories.qa).not.toHaveBeenCalled()
    expect(factories.governance).not.toHaveBeenCalled()
  })

  it('loads indexing only when hybrid search invokes query embedding', async () => {
    const common = configuredAuth()
    const queryEmbedding = vi.fn(async () => ({ embedding: [0.1], dimensions: 1 }))
    const factories = {
      common: vi.fn(async () => common),
      content: vi.fn(async ({ queryEmbedding: lazyQueryEmbedding }) => ({
        articleService: { list: vi.fn(async () => ({ articles: [] })) },
        searchService: { search: vi.fn(async () => lazyQueryEmbedding('hybrid query')) },
      })),
      jobs: vi.fn(async () => ({ jobService: {}, queueRegistry: {} })),
      indexing: vi.fn(async () => ({ queryEmbedding })),
      sources: vi.fn(), qa: vi.fn(), governance: vi.fn(),
    }
    const options = createLazyRuntimeOptions({ factories, maxAttempts: 1 })

    await options.articleService.list({ auth: { user: { id: 'user-1' } }, query: {} })
    expect(factories.jobs).not.toHaveBeenCalled()
    expect(factories.indexing).not.toHaveBeenCalled()

    await expect(options.searchService.search({ auth: { user: { id: 'user-1' } }, query: { mode: 'hybrid' } })).resolves.toEqual({ embedding: [0.1], dimensions: 1 })
    expect(factories.jobs).toHaveBeenCalledTimes(1)
    expect(factories.indexing).toHaveBeenCalledTimes(1)
    expect(queryEmbedding).toHaveBeenCalledExactlyOnceWith('hybrid query')
  })

  it('loads indexing before QA and forwards its provider capabilities', async () => {
    const common = configuredAuth()
    const providerAdapters = { llmProvider: {} }
    const providerAdmission = { run: vi.fn() }
    const queryEmbedding = vi.fn()
    const createAnswer = vi.fn(async () => ({ status: 'refused' }))
    const factories = {
      common: vi.fn(async () => common),
      content: vi.fn(), sources: vi.fn(), governance: vi.fn(),
      jobs: vi.fn(async () => ({ maintenanceRegistry: {} })),
      indexing: vi.fn(async () => ({ providerAdapters, providerAdmission, queryEmbedding })),
      qa: vi.fn(async ({ indexing }) => {
        expect(indexing).toMatchObject({ providerAdapters, providerAdmission, queryEmbedding })
        return { createAnswer }
      }),
    }
    const options = createLazyRuntimeOptions({ factories, maxAttempts: 1 })

    await expect(options.qaService.createAnswer({ question: 'why' })).resolves.toEqual({ status: 'refused' })
    expect(factories.indexing).toHaveBeenCalledTimes(1)
    expect(factories.qa).toHaveBeenCalledTimes(1)
    expect(createAnswer).toHaveBeenCalledExactlyOnceWith({ question: 'why' })
  })

  it('loads reviewed CSP hosts for articles but not for health', async () => {
    const common = configuredAuth()
    common.authService.authenticate.mockResolvedValue({ user: { id: 'user-1', status: 'active' } })
    const factories = {
      common: vi.fn(async () => common),
      content: vi.fn(async () => ({
        articleService: { list: vi.fn(async () => ({ articles: [] })) },
        imageCspHosts: ['media.example.com'],
      })),
      sources: vi.fn(), jobs: vi.fn(), indexing: vi.fn(), qa: vi.fn(), governance: vi.fn(),
    }
    const options = createLazyRuntimeOptions({ factories, maxAttempts: 1 })
    const server = await listen(createApp(options))
    try {
      const health = await fetch(`${server.origin}/api/v1/health`)
      expect(health.status).toBe(200)
      expect(health.headers.get('content-security-policy')).toContain("img-src 'self'")
      expect(factories.common).not.toHaveBeenCalled()
      expect(factories.content).not.toHaveBeenCalled()

      const articles = await fetch(`${server.origin}/api/v1/articles`, {
        headers: { Cookie: '__Host-techpulse_session=session-token-12345' },
      })
      expect(articles.status).toBe(200)
      expect(articles.headers.get('content-security-policy')).toContain('https://media.example.com')
      expect(factories.common).toHaveBeenCalledTimes(1)
      expect(factories.content).toHaveBeenCalledTimes(1)
    } finally {
      await server.close()
    }
  })

  it('returns service_unavailable without exposing a bootstrap error', async () => {
    const logError = vi.fn()
    const options = createLazyRuntimeOptions({
      factories: {
        common: vi.fn(async () => { throw new Error('mongodb://user:secret@private') }),
      },
      maxAttempts: 1,
      logError,
    })

    await expect(options.authService.authenticate({ token: 'opaque' })).rejects.toMatchObject({
      status: 503,
      code: 'service_unavailable',
      message: 'Authentication service is unavailable',
    })
    expect(logError).toHaveBeenCalledExactlyOnceWith('common capability is unavailable')
    expect(JSON.stringify(logError.mock.calls)).not.toContain('secret')
  })

  it('preserves service errors after a capability loads', async () => {
    const businessError = Object.assign(new Error('Authentication is required'), { status: 401, code: 'unauthorized' })
    const options = createLazyRuntimeOptions({
      factories: {
        common: vi.fn(async () => ({ authService: { authenticate: vi.fn(async () => { throw businessError }) } })),
      },
      maxAttempts: 1,
    })

    await expect(options.authService.authenticate({ token: 'expired' })).rejects.toBe(businessError)
  })
})

describe('health bootstrap isolation', () => {
  it('does not authenticate a health request that carries a session cookie', async () => {
    const authenticate = vi.fn(async () => { throw new Error('must not run') })
    const app = createApp({ authService: { authenticate } })
    const server = await listen(app)
    try {
      const response = await fetch(`${server.origin}/api/v1/health`, {
        headers: { Cookie: 'techpulse_session=stale-session-token' },
      })
      expect(response.status).toBe(200)
      expect((await response.json()).data.status).toBe('ok')
      expect(authenticate).not.toHaveBeenCalled()
    } finally {
      await server.close()
    }
  })
})
