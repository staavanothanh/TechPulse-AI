const FILTER_FIELDS = Object.freeze(['status', 'task', 'articleId', 'sourceId'])
const FILTER_FIELD_COPY = Object.freeze({
  status: 'Trạng thái lọc chưa hợp lệ.',
  task: 'Task lọc chưa hợp lệ.',
  articleId: 'Article ID chưa hợp lệ.',
  sourceId: 'Source ID chưa hợp lệ.',
})
const MAX_SAFE_RETRY_AFTER_SECONDS = 86_400

function queryEntries(query = {}) {
  return Object.entries(query).filter(([, value]) => value !== undefined && value !== null && value !== '')
}

function filterField(value) {
  const segments = String(value ?? '').split(/[./]/).filter(Boolean)
  const candidate = segments.at(-1)
  return FILTER_FIELDS.includes(candidate) ? candidate : null
}

export function safeRetryAfterSeconds(response) {
  const rawValue = response?.headers?.get?.('Retry-After')
  const value = typeof rawValue === 'string' ? rawValue.trim() : ''
  if (!/^[1-9]\d*$/.test(value)) return null
  const seconds = Number(value)
  return Number.isSafeInteger(seconds) && seconds <= MAX_SAFE_RETRY_AFTER_SECONDS ? seconds : null
}

export function safeIndexingFilterErrors(payload) {
  const details = payload?.error?.details
  if (!Array.isArray(details)) return {}
  const errors = {}
  for (const detail of details) {
    const field = filterField(detail?.field)
    if (field) errors[field] = FILTER_FIELD_COPY[field]
  }
  return errors
}

async function filterErrorsFromResponse(response) {
  if (response?.status !== 422 || typeof response.clone !== 'function') return {}
  try {
    return safeIndexingFilterErrors(await response.clone().json())
  } catch {
    return {}
  }
}

function attachSafeContext(error, { retryAfter, fieldErrors }) {
  if (!error || typeof error !== 'object') return error
  try {
    if (retryAfter !== null) error.retryAfter = retryAfter
    if (Object.keys(fieldErrors).length > 0) error.fieldErrors = fieldErrors
  } catch {
    // A frozen transport error still keeps its canonical status/code; omit local hints safely.
  }
  return error
}

export function createIndexingRequestGate() {
  let inFlight = false
  return Object.freeze({
    isInFlight: () => inFlight,
    run(request) {
      if (inFlight) return { started: false }
      inFlight = true
      return Promise.resolve()
        .then(request)
        .then((value) => ({ started: true, value }))
        .finally(() => { inFlight = false })
    },
  })
}

export function createIndexingApi(generatedApi, fetchImpl = globalThis.fetch) {
  async function invoke(operation, { query, fetchImpl: suppliedFetch, ...init } = {}) {
    let retryAfter = null
    let fieldErrors = {}
    const requestFetch = suppliedFetch ?? fetchImpl
    const managedFetch = async (input, requestInit) => {
      const url = new URL(input)
      for (const [key, value] of queryEntries(query)) url.searchParams.set(key, String(value))
      const response = await requestFetch(url, requestInit)
      retryAfter = safeRetryAfterSeconds(response)
      fieldErrors = await filterErrorsFromResponse(response)
      return response
    }
    try {
      return await operation({ ...init, credentials: 'same-origin', fetchImpl: managedFetch })
    } catch (error) {
      throw attachSafeContext(error, { retryAfter, fieldErrors })
    }
  }

  const call = (operationName, options) => invoke(generatedApi[operationName], options)
  return Object.freeze({
    listIndexingJobs: (options) => call('listIndexingJobs', options),
    getIndexingJob: (options) => call('getIndexingJob', options),
    createSummaryJob: (options) => call('createSummaryJob', options),
    createIndexingJob: (options) => call('createIndexingJob', options),
    retryIndexingJob: (options) => call('retryIndexingJob', options),
    cancelIndexingJob: (options) => call('cancelIndexingJob', options),
  })
}
