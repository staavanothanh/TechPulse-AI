const DEFAULT_MAX_ATTEMPTS = 2
const DEFAULT_RETRY_DELAY_MS = 25

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds))
}

function serviceUnavailable(message) {
  return Object.assign(new Error(message), { status: 503, code: 'service_unavailable' })
}

function dependencyUnavailable(cause) {
  return Object.assign(new Error('Capability dependency is unavailable'), { cause, dependencyUnavailable: true })
}

export function createSingleFlightCapability({
  name,
  load,
  maxAttempts = DEFAULT_MAX_ATTEMPTS,
  wait = () => delay(DEFAULT_RETRY_DELAY_MS),
  logError = console.error,
} = {}) {
  if (typeof load !== 'function') throw new Error(`Capability factory is required for ${name ?? 'unknown'}`)
  let value
  let flight

  async function run() {
    let lastError
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      try {
        value = await load()
        return value
      } catch (error) {
        lastError = error
        if (error?.dependencyUnavailable === true) break
        if (attempt < maxAttempts) await wait()
      }
    }
    logError(`${name ?? 'Runtime'} capability is unavailable`)
    throw lastError
  }

  function getCapability() {
    if (value !== undefined) return Promise.resolve(value)
    if (!flight) {
      flight = run().catch((error) => {
        flight = null
        throw error
      })
    }
    return flight
  }
  getCapability.peek = () => value
  return getCapability
}

function createLazyService({ load, select, unavailableMessage }) {
  return new Proxy(Object.create(null), {
    get(_target, property) {
      if (property === 'then') return undefined
      return async (...args) => {
        let loaded
        try {
          loaded = await load()
        } catch {
          throw serviceUnavailable(unavailableMessage)
        }
        const service = select(loaded)
        const method = service?.[property]
        if (typeof method !== 'function') throw serviceUnavailable(unavailableMessage)
        return method.apply(service, args)
      }
    },
  })
}

function createLazyFunction({ load, select, unavailableMessage }) {
  return async (...args) => {
    let loaded
    try {
      loaded = await load()
    } catch {
      throw serviceUnavailable(unavailableMessage)
    }
    const callable = select(loaded)
    if (typeof callable !== 'function') throw serviceUnavailable(unavailableMessage)
    return callable(...args)
  }
}

export function createConfiguredRuntimeFactories({ environment = process.env } = {}) {
  const factories = {}
  factories.common = async () => {
    const [{ createConfiguredAuthService }, { createRateLimitAdmission }, { createReleaseVerifiedSchemaVerifier }] = await Promise.all([
      import('./auth.js'),
      import('../security/rate-limit-admission.js'),
      import('./schema-readiness.js'),
    ])
    const verifySchema = createReleaseVerifiedSchemaVerifier('auth-core', environment)
    const configured = await createConfiguredAuthService({ environment, verifySchema })
    return Object.freeze({
      ...configured,
      rateLimitAdmission: createRateLimitAdmission({ repository: configured.authRepository, keyring: configured.quotaKeyring }),
    })
  }
  factories.content = async ({ common, queryEmbedding }) => {
    const [{ createConfiguredContentServices }, { createReleaseVerifiedSchemaVerifier }] = await Promise.all([
      import('./content.js'),
      import('./schema-readiness.js'),
    ])
    const verifySchema = createReleaseVerifiedSchemaVerifier('articles', environment)
    return createConfiguredContentServices({ context: common.context, queryEmbedding, verifySchema })
  }
  factories.sources = async ({ common }) => {
    const [{ createConfiguredSourceService }, { createSourceTechnicalCheckAdapter }, { createSafeFetch }, { createReleaseVerifiedSchemaVerifier }] = await Promise.all([
      import('./sources.js'),
      import('../infrastructure/http/source-technical-check.js'),
      import('../infrastructure/http/safe-fetch.js'),
      import('./schema-readiness.js'),
    ])
    const verifySchema = createReleaseVerifiedSchemaVerifier('sources', environment)
    return createConfiguredSourceService({
      context: common.context,
      rateLimitAdmission: common.rateLimitAdmission,
      technicalCheckAdapter: createSourceTechnicalCheckAdapter({ safeFetch: createSafeFetch() }),
      verifySchema,
    })
  }
  factories.jobs = async ({ common }) => {
    const [{ createProductionJobRuntime }, { createConfiguredJobRuntime }, { createReleaseVerifiedSchemaVerifier }] = await Promise.all([
      import('../maintenance/job-runtime.js'),
      import('./jobs.js'),
      import('./schema-readiness.js'),
    ])
    const verifyJobsSchema = createReleaseVerifiedSchemaVerifier('durable-jobs', environment)
    const verifyGovernanceSchema = createReleaseVerifiedSchemaVerifier('governance', environment)
    const result = await createProductionJobRuntime({
      runtimeConfig: common.runtime,
      jobOptions: {
        context: common.context,
        rateLimitAdmission: common.rateLimitAdmission,
        quotaKeyring: common.quotaKeyring,
        governanceKeyring: common.governanceKeyring,
        verifyJobsSchema,
        verifyGovernanceSchema,
      },
      createJobRuntime: createConfiguredJobRuntime,
    })
    if (!result.jobs?.jobService) throw new Error('Durable job runtime is unavailable')
    return result.jobs
  }
  factories.indexing = async ({ common, jobs }) => {
    const [{ createConfiguredProviderAdapters, DEFAULT_CHAT_TIMEOUT_MS }, { createConfiguredIndexingRuntime }, { createReleaseVerifiedSchemaVerifier }] = await Promise.all([
      import('../ai/provider-adapters.js'),
      import('./indexing.js'),
      import('./schema-readiness.js'),
    ])
    const verifySchema = createReleaseVerifiedSchemaVerifier('indexing-jobs', environment)
    const verifyProviderSchema = createReleaseVerifiedSchemaVerifier('provider-routing-v2', environment)
    const providerAdapters = createConfiguredProviderAdapters({
      registry: common.runtime.providerRegistry,
      summaryTimeoutMs: DEFAULT_CHAT_TIMEOUT_MS,
    })
    return {
      ...await createConfiguredIndexingRuntime({
        context: common.context,
        jobRuntime: jobs,
        rateLimitAdmission: common.rateLimitAdmission,
        providerRegistry: common.runtime.providerRegistry,
        ...providerAdapters,
        verifySchema,
        verifyProviderSchema,
      }),
      providerAdapters,
    }
  }
  factories.qa = async ({ common, jobs, indexing }) => {
    const [{ createConfiguredQaService }, { createReleaseVerifiedSchemaVerifier }] = await Promise.all([
      import('./qa.js'),
      import('./schema-readiness.js'),
    ])
    const verifySchema = createReleaseVerifiedSchemaVerifier('chat-sessions', environment)
    const verifyProviderSchema = createReleaseVerifiedSchemaVerifier('provider-routing-v2', environment)
    return createConfiguredQaService({
      context: common.context,
      providerRegistry: common.runtime.providerRegistry,
      providerAdapters: indexing.providerAdapters,
      providerAdmission: indexing.providerAdmission,
      queryEmbedding: indexing.queryEmbedding,
      rateLimitAdmission: common.rateLimitAdmission,
      maintenanceRegistry: jobs.maintenanceRegistry,
      verifySchema,
      verifyProviderSchema,
    })
  }
  factories.governance = async ({ common }) => {
    const [{ createConfiguredAdminGovernanceService }, { createReleaseVerifiedSchemaVerifier }] = await Promise.all([
      import('./admin.js'),
      import('./schema-readiness.js'),
    ])
    const verifySchema = createReleaseVerifiedSchemaVerifier('governance', environment)
    return createConfiguredAdminGovernanceService({
      context: common.context,
      rateLimitAdmission: common.rateLimitAdmission,
      quotaKeyring: common.quotaKeyring,
      governanceKeyring: common.governanceKeyring,
      verifySchema,
    })
  }
  return factories
}

export function createLazyRuntimeOptions({
  factories = createConfiguredRuntimeFactories(),
  maxAttempts = DEFAULT_MAX_ATTEMPTS,
  wait,
  logError,
} = {}) {
  const capabilities = {}
  const capability = (name, dependencies = [], inputs = {}) => createSingleFlightCapability({
    name,
    maxAttempts,
    wait,
    logError,
    load: async () => {
      let resolved
      try {
        resolved = Object.fromEntries(await Promise.all(dependencies.map(async (dependency) => [dependency, await capabilities[dependency]()])))
      } catch (error) {
        throw dependencyUnavailable(error)
      }
      return factories[name]({ ...resolved, ...inputs })
    },
  })

  capabilities.common = capability('common')
  capabilities.jobs = capability('jobs', ['common'])
  capabilities.indexing = capability('indexing', ['common', 'jobs'])
  const queryEmbedding = createLazyFunction({
    load: capabilities.indexing,
    select: (value) => value.queryEmbedding,
    unavailableMessage: 'Query embedding is unavailable',
  })
  capabilities.content = capability('content', ['common'], { queryEmbedding })
  capabilities.sources = capability('sources', ['common'])
  capabilities.qa = capability('qa', ['common', 'jobs', 'indexing'])
  capabilities.governance = capability('governance', ['common'])

  return Object.freeze({
    authService: createLazyService({ load: capabilities.common, select: (value) => value.authService, unavailableMessage: 'Authentication service is unavailable' }),
    articleService: createLazyService({ load: capabilities.content, select: (value) => value.articleService, unavailableMessage: 'Article service is unavailable' }),
    searchService: createLazyService({ load: capabilities.content, select: (value) => value.searchService, unavailableMessage: 'Search service is unavailable' }),
    savedService: createLazyService({ load: capabilities.content, select: (value) => value.savedService, unavailableMessage: 'Saved-article service is unavailable' }),
    sourceService: createLazyService({ load: capabilities.sources, select: (value) => value.sourceService, unavailableMessage: 'Source Registry service is unavailable' }),
    jobService: createLazyService({ load: capabilities.jobs, select: (value) => value.jobService, unavailableMessage: 'Durable job service is unavailable' }),
    indexingJobService: createLazyService({ load: capabilities.indexing, select: (value) => value.indexingJobService, unavailableMessage: 'Indexing job service is unavailable' }),
    qaService: createLazyService({ load: capabilities.qa, select: (value) => value, unavailableMessage: 'Grounded Q&A service is unavailable' }),
    adminGovernanceService: createLazyService({ load: capabilities.governance, select: (value) => value.adminGovernanceService, unavailableMessage: 'Admin governance service is unavailable' }),
    accountDeletionService: createLazyService({ load: capabilities.governance, select: (value) => value.accountDeletionService, unavailableMessage: 'Account deletion service is unavailable' }),
    dueWorkRunner: createLazyFunction({ load: capabilities.jobs, select: (value) => value.dueWorkRunner, unavailableMessage: 'Due-work runner is unavailable' }),
    maintenanceRunner: createLazyService({ load: capabilities.jobs, select: (value) => value.maintenanceRunner, unavailableMessage: 'Maintenance runner is unavailable' }),
    imageCspHosts: () => capabilities.content.peek()?.imageCspHosts ?? [],
  })
}
