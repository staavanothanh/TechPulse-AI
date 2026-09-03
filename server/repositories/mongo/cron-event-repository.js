import { ObjectId } from 'mongodb'
import { createLifecycleEventDocument, safeSequence } from '../../jobs/runtime-trace.js'

const MAX_LIMIT = 100
const SAFE_FILTER = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/

function objectId(value, label = 'Identifier') {
  if (value instanceof ObjectId) return value
  if (typeof value === 'string' && ObjectId.isValid(value) && new ObjectId(value).toHexString() === value.toLowerCase()) return new ObjectId(value)
  const error = new Error(`${label} is invalid`)
  error.status = 400
  error.code = 'bad_request'
  throw error
}

function date(value, label = 'Date') {
  const result = value instanceof Date ? new Date(value) : new Date(value)
  if (Number.isNaN(result.getTime())) {
    const error = new Error(`${label} is invalid`)
    error.status = 422
    error.code = 'validation_error'
    throw error
  }
  return result
}
function dateFilter(value, label) {
  if (typeof value !== 'string' || /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/i.test(value) === false) {
    const error = new Error(`${label} must be an RFC3339 date-time with timezone`)
    error.status = 422
    error.code = 'validation_error'
    throw error
  }
  return date(value, label)
}

function filterValue(value, label) {
  const result = String(value)
  if (!SAFE_FILTER.test(result)) {
    const error = new Error(`${label} is invalid`)
    error.status = 422
    error.code = 'validation_error'
    throw error
  }
  return result
}
function operationOptions({ signal, deadline } = {}) {
  const deadlineAt = deadline === undefined ? Number.POSITIVE_INFINITY : date(deadline, 'Retention operation deadline').getTime()
  const remainingMs = deadlineAt === Number.POSITIVE_INFINITY ? Number.POSITIVE_INFINITY : deadlineAt - Date.now()
  return {
    ...(signal ? { signal } : {}),
    ...(deadlineAt !== Number.POSITIVE_INFINITY ? { maxTimeMS: Math.max(1, Math.floor(remainingMs)) } : {}),
  }
}


function decodeCursor(value) {
  if (!value) return null
  try {
    const decoded = JSON.parse(Buffer.from(value, 'base64url').toString('utf8'))
    if (!decoded || typeof decoded.id !== 'string' || !decoded.at) throw new Error('invalid')
    return { id: objectId(decoded.id), at: date(decoded.at, 'Cursor date') }
  } catch {
    const error = new Error('Cursor is invalid')
    error.status = 422
    error.code = 'validation_error'
    throw error
  }
}

function encodeCursor(value) {
  const id = typeof value._id?.toHexString === 'function' ? value._id.toHexString() : String(value._id)
  return Buffer.from(JSON.stringify({ id, at: value.occurredAt.toISOString() }), 'utf8').toString('base64url')
}

function serializeEvent(doc) {
  return {
    eventId: doc.eventId,
    version: doc.version ?? 1,
    runId: doc.runId ?? null,
    queueName: doc.queueName ?? null,
    task: doc.task ?? null,
    jobId: doc.jobId ?? null,
    articleId: doc.articleId ?? null,
    sourceId: doc.sourceId ?? null,
    sourceKey: doc.sourceKey ?? null,
    sequence: safeSequence(doc.sequence) ?? null,
    leaseGeneration: doc.leaseGeneration ?? null,
    remainingClaims: doc.remainingClaims ?? null,
    profileMaxJobs: doc.profileMaxJobs ?? null,
    stage: doc.stage,
    eventType: doc.eventType ?? 'phase',
    status: doc.status,
    elapsedMs: doc.elapsedMs ?? null,
    occurredAt: doc.occurredAt instanceof Date ? doc.occurredAt.toISOString() : doc.occurredAt,
    counters: doc.counters ? { ...doc.counters } : null,
    error: doc.error
      ? {
        code: doc.error.code,
        retryable: Boolean(doc.error.retryable),
        occurredAt: doc.error.occurredAt instanceof Date ? doc.error.occurredAt.toISOString() : doc.error.occurredAt,
        ...(Number.isInteger(doc.error.upstreamStatus) ? { upstreamStatus: doc.error.upstreamStatus } : {}),
      }
      : null,
  }
}

export class MongoCronEventRepository {
  constructor(context = {}) {
    if (!context?.db) throw new Error('Mongo context is required')
    this.db = context.db
    this.clock = typeof context.now === 'function' ? context.now : () => new Date()
  }

  collection() {
    return this.db.collection('cronLifecycleEvents')
  }

  async recordLifecycleEvent(eventInput) {
    try {
      const doc = createLifecycleEventDocument(eventInput, this.clock)
      await this.collection().updateOne({ eventId: doc.eventId }, { $setOnInsert: doc }, { upsert: true })
      return true
    } catch {
      // Observability is deliberately fail-open; worker state transitions remain authoritative.
      return false
    }
  }

  async listLifecycleEvents(query = {}) {
    const limit = query.limit === undefined ? 20 : Number(query.limit)
    if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIMIT) {
      const error = new Error('Limit is invalid')
      error.status = 422
      error.code = 'validation_error'
      throw error
    }

    const filter = {}
    for (const key of ['runId', 'queueName', 'task', 'jobId', 'articleId', 'sourceId', 'status', 'stage']) {
      if (query[key] !== undefined && query[key] !== '') filter[key] = filterValue(query[key], key)
    }
    if (query.from !== undefined && query.from !== '') filter.occurredAt = { $gte: dateFilter(query.from, 'From filter') }
    if (query.to !== undefined && query.to !== '') filter.occurredAt = { ...(filter.occurredAt ?? {}), $lte: dateFilter(query.to, 'To filter') }
    if (filter.occurredAt?.$gte && filter.occurredAt?.$lte && filter.occurredAt.$gte.getTime() > filter.occurredAt.$lte.getTime()) {
      const error = new Error('From filter cannot be after To filter')
      error.status = 422
      error.code = 'validation_error'
      throw error
    }
    const cursor = decodeCursor(query.cursor)
    if (cursor) filter.$or = [{ occurredAt: { $lt: cursor.at } }, { occurredAt: cursor.at, _id: { $lt: cursor.id } }]

    const rows = await this.collection()
      .find(filter)
      .sort({ occurredAt: -1, _id: -1 })
      .project({
        _id: 1, eventId: 1, version: 1, runId: 1, queueName: 1, task: 1, jobId: 1, articleId: 1,
        sourceId: 1, sourceKey: 1, sequence: 1, leaseGeneration: 1, remainingClaims: 1, profileMaxJobs: 1,
        stage: 1, eventType: 1, status: 1, elapsedMs: 1, occurredAt: 1, counters: 1, error: 1,
      })
      .limit(limit + 1)
      .toArray()

    const hasNext = rows.length > limit
    const events = hasNext ? rows.slice(0, limit) : rows
    const last = events.at(-1)
    return { events: events.map(serializeEvent), hasNext, nextCursor: hasNext && last ? encodeCursor(last) : null }
  }

  async purgeExpiredEvents({ cutoff = this.clock(), limit = 100, signal, deadline } = {}) {
    const cutoffDate = date(cutoff, 'Retention cutoff')
    const options = operationOptions({ signal, deadline })
    signal?.throwIfAborted?.()
    const parsedLimit = Number(limit)
    if (!Number.isInteger(parsedLimit) || parsedLimit < 1 || parsedLimit > MAX_LIMIT) {
      const error = new Error('Retention limit is invalid')
      error.status = 422
      error.code = 'validation_error'
      throw error
    }
    const safeLimit = parsedLimit
    const filter = { purgeAfter: { $lte: cutoffDate } }
    const rows = await this.collection()
      .find(filter, options)
      .sort({ purgeAfter: 1, _id: 1 })
      .limit(safeLimit + 1)
      .project({ _id: 1 })
      .toArray()
    signal?.throwIfAborted?.()
    const selected = rows.slice(0, safeLimit)
    if (selected.length === 0) return { inspected: 0, affected: 0, hasMore: false }
    const result = await this.collection().deleteMany({ _id: { $in: selected.map(({ _id }) => _id) }, ...filter }, options)
    return { inspected: selected.length, affected: result.deletedCount ?? 0, hasMore: rows.length > safeLimit }
  }
}
