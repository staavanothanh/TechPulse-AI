export class ContentError extends Error {
  constructor(status, code, message, details) {
    super(message)
    this.name = 'ContentError'
    this.status = status
    this.code = code
    this.details = details
  }
}

export function requireContentUser(auth) {
  const user = auth?.user
  const userId = user?.id ?? user?._id
  if (!userId || user.status !== 'active') throw new ContentError(401, 'unauthorized', 'Authentication is required')
  return String(userId)
}

export function contentActorFence(auth) {
  const userId = requireContentUser(auth)
  const sessionId = auth?.session?.id ?? auth?.session?._id
  const sessionVersion = auth?.session?.userSessionVersion
  if (!sessionId || !Number.isInteger(sessionVersion) || Number.isInteger(auth?.user?.sessionVersion) && auth.user.sessionVersion !== sessionVersion) {
    throw new ContentError(401, 'unauthorized', 'Authentication is required')
  }
  return { userId, actorFence: { sessionId: String(sessionId), sessionVersion } }
}

function optionalString(value, field, { minimum = 0, maximum } = {}) {
  if (value === undefined || value === null || value === '') return undefined
  if (typeof value !== 'string' || value.length < minimum || value.length > maximum) throw new ContentError(422, 'validation_error', `${field} is invalid`, [{ field, message: `${field} is invalid`, code: 'invalid' }])
  return value
}

function dateValue(value, field) {
  const text = optionalString(value, field, { maximum: 64 })
  if (text === undefined) return undefined
  const date = new Date(text)
  if (Number.isNaN(date.getTime())) throw new ContentError(422, 'validation_error', `${field} is invalid`, [{ field, message: `${field} must be a date-time`, code: 'format' }])
  return date
}

function limitValue(value) {
  if (value === undefined || value === null || value === '') return 20
  const limit = typeof value === 'number' ? value : Number(value)
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new ContentError(422, 'validation_error', 'limit is invalid', [{ field: 'limit', message: 'limit must be from 1 to 100', code: 'range' }])
  return limit
}

function pageValue(value) {
  if (value === undefined || value === null || value === '') return 1
  const page = typeof value === 'number' ? value : Number(value)
  if (!Number.isInteger(page) || page < 1 || page > 10000) throw new ContentError(422, 'validation_error', 'page is invalid', [{ field: 'page', message: 'page must be from 1 to 10000', code: 'range' }])
  return page
}

function booleanValue(value, field) {
  if (value === undefined || value === null || value === '') return false
  if (value === true || value === 'true') return true
  if (value === false || value === 'false') return false
  throw new ContentError(422, 'validation_error', `${field} is invalid`, [{ field, message: `${field} must be true or false`, code: 'boolean' }])
}

const MAX_PAGE_OFFSET = 100_000

export function contentListQuery(query = {}) {
  const publishedAfter = dateValue(query.publishedAfter, 'publishedAfter')
  const publishedBefore = dateValue(query.publishedBefore, 'publishedBefore')
  if (publishedAfter && publishedBefore && publishedAfter > publishedBefore) throw new ContentError(422, 'validation_error', 'Published date range is invalid', [{ field: 'publishedAfter', message: 'publishedAfter must not be later than publishedBefore', code: 'range' }])
  return {
    topic: optionalString(query.topic, 'topic', { maximum: 64 }),
    sourceId: optionalString(query.sourceId, 'sourceId', { minimum: 1, maximum: 128 }),
    publishedAfter,
    publishedBefore,
    cursor: optionalString(query.cursor, 'cursor', { maximum: 1000 }),
    limit: limitValue(query.limit),
  }
}

export function pagedContentListQuery(query = {}) {
  const parsed = contentListQuery(query)
  const page = pageValue(query.page)
  const lastPage = booleanValue(query.lastPage, 'lastPage')
  if (lastPage && page > 1) throw new ContentError(422, 'validation_error', 'lastPage cannot be combined with page', [{ field: 'page', message: 'page cannot be used with lastPage', code: 'conflict' }])
  if (!lastPage && (page - 1) * parsed.limit > MAX_PAGE_OFFSET) throw new ContentError(422, 'validation_error', 'page is too deep', [{ field: 'page', message: 'page is too deep', code: 'range' }])
  if (parsed.cursor && (page > 1 || lastPage)) throw new ContentError(422, 'validation_error', 'cursor and page cannot be used together', [{ field: 'page', message: 'page cannot be used with cursor', code: 'conflict' }])
  return { ...parsed, page, lastPage }
}

export function savedListQuery(query = {}) {
  return {
    cursor: optionalString(query.cursor, 'cursor', { maximum: 1000 }),
    limit: limitValue(query.limit),
  }
}

export function searchQuery(query = {}) {
  const q = optionalString(query.q, 'q', { minimum: 2, maximum: 300 })
  if (!q) throw new ContentError(422, 'validation_error', 'q is required', [{ field: 'q', message: 'q is required', code: 'required' }])
  const mode = query.mode ?? 'hybrid'
  if (!['text', 'hybrid'].includes(mode)) throw new ContentError(422, 'validation_error', 'mode is invalid', [{ field: 'mode', message: 'mode must be text or hybrid', code: 'enum' }])
  return { ...contentListQuery(query), q, mode }
}

export function articleIdValue(value) {
  if (typeof value !== 'string' || value.length < 1 || value.length > 128) throw new ContentError(422, 'validation_error', 'articleId is invalid', [{ field: 'articleId', message: 'articleId is invalid', code: 'invalid' }])
  return value
}
