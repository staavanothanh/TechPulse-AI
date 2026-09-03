const ADMIN_FILTERS = Object.freeze({
  listAdminArticles: ['status', 'sourceId', 'summaryStatus', 'embeddingStatus', 'cursor', 'limit'],
  listAuditLogs: ['actorType', 'actorId', 'targetType', 'targetId', 'cursor', 'limit'],
  listTakedownRequests: ['status', 'cursor', 'limit'],
  listAdminUsers: ['status', 'email', 'cursor', 'limit'],
  listAccountDeletionRequests: ['status', 'cursor', 'limit'],
  listCronLifecycleEvents: ['runId', 'queueName', 'task', 'jobId', 'articleId', 'sourceId', 'status', 'stage', 'from', 'to', 'cursor', 'limit'],
})
const MAX_RETRY_AFTER = 86_400

function allowlistedQuery(operation, query = {}) {
  const allowed = ADMIN_FILTERS[operation] ?? []
  return Object.fromEntries(allowed.flatMap((key) => query[key] === undefined || query[key] === null || query[key] === '' ? [] : [[key, String(query[key])]]))
}

function retryAfter(response) {
  const raw = response?.headers?.get?.('Retry-After')
  if (typeof raw !== 'string' || !/^[1-9]\d*$/.test(raw.trim())) return null
  const seconds = Number(raw.trim())
  return Number.isSafeInteger(seconds) && seconds <= MAX_RETRY_AFTER ? seconds : null
}

function attach(error, response) {
  const seconds = retryAfter(response)
  if (seconds === null) return error
  try { error.retryAfter = seconds } catch { /* frozen transport error */ }
  return error
}

export function createAdminReadApi(generatedApi, fetchImpl = globalThis.fetch) {
  const invoke = async (operation, { query, fetchImpl: suppliedFetch, ...init } = {}) => {
    let response
    const requestFetch = suppliedFetch ?? fetchImpl
    const managedFetch = async (input, requestInit) => {
      const url = new URL(input)
      for (const [key, value] of Object.entries(allowlistedQuery(operation, query))) url.searchParams.set(key, value)
      response = await requestFetch(url, requestInit)
      return response
    }
    try { return await generatedApi[operation]({ ...init, credentials: 'same-origin', fetchImpl: managedFetch }) } catch (error) { throw attach(error, response) }
  }
  return Object.freeze({
    getAdminOverview: (options) => invoke('getAdminOverview', options),
    listAdminArticles: (options) => invoke('listAdminArticles', options),
    getAdminArticle: (options) => invoke('getAdminArticle', options),
    updateAdminArticle: (options) => invoke('updateAdminArticle', options),
    createSummaryJob: (options) => invoke('createSummaryJob', options),
    createIndexingJob: (options) => invoke('createIndexingJob', options),
    mergeDuplicateArticles: (options) => invoke('mergeDuplicateArticles', options),
    listTakedownRequests: (options) => invoke('listTakedownRequests', options),
    getTakedownRequest: (options) => invoke('getTakedownRequest', options),
    updateTakedownRequest: (options) => invoke('updateTakedownRequest', options),
    listAdminUsers: (options) => invoke('listAdminUsers', options),
    getAdminUser: (options) => invoke('getAdminUser', options),
    updateUserStatus: (options) => invoke('updateUserStatus', options),
    listAccountDeletionRequests: (options) => invoke('listAccountDeletionRequests', options),
    getAccountDeletionRequest: (options) => invoke('getAccountDeletionRequest', options),
    retryAccountDeletionRequest: (options) => invoke('retryAccountDeletionRequest', options),
    listAuditLogs: (options) => invoke('listAuditLogs', options),
    listCronLifecycleEvents: (options) => invoke('listCronLifecycleEvents', options),
  })
}
