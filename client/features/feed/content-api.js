function queryString(query = {}) {
  const parameters = []
  for (const [key, rawValue] of Object.entries(query)) {
    if (rawValue === undefined || rawValue === null || rawValue === '') continue
    const value = rawValue instanceof Date ? rawValue.toISOString() : String(rawValue)
    parameters.push([key, value])
  }
  return parameters
}

function retryAfterValue(response) {
  const value = Number(response.headers.get('Retry-After'))
  return Number.isInteger(value) && value > 0 ? value : null
}

export function createContentApi(generatedApi, fetchImpl = globalThis.fetch) {
  async function invoke(operation, { query, ...init } = {}) {
    let retryAfter = null
    const managedFetch = async (input, requestInit) => {
      const url = new URL(input)
      for (const [key, value] of queryString(query)) url.searchParams.set(key, value)
      const response = await fetchImpl(url, requestInit)
      retryAfter = retryAfterValue(response)
      return response
    }
    try {
      return await operation({ ...init, credentials: 'same-origin', fetchImpl: managedFetch })
    } catch (error) {
      if (retryAfter !== null) error.retryAfter = retryAfter
      throw error
    }
  }

  return Object.freeze({
    listArticles: (query) => invoke(generatedApi.listArticles, { query }),
    getArticle: (articleId) => invoke(generatedApi.getArticle, { pathParams: { articleId } }),
    searchArticles: (query) => invoke(generatedApi.searchArticles, { query }),
    listSavedArticles: (query) => invoke(generatedApi.listSavedArticles, { query }),
    saveArticle: (articleId, csrfToken) => invoke(generatedApi.saveArticle, { pathParams: { articleId }, headers: { 'X-CSRF-Token': csrfToken } }),
    unsaveArticle: (articleId, csrfToken) => invoke(generatedApi.unsaveArticle, { pathParams: { articleId }, headers: { 'X-CSRF-Token': csrfToken } }),
    clearSavedArticles: (csrfToken) => invoke(generatedApi.clearSavedArticles, { headers: { 'X-CSRF-Token': csrfToken } }),
  })
}
